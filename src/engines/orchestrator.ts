import fs from 'fs';
import { BaseEngine } from './base.ts';
import { DirectEngine } from './direct-engine.ts';
import { PlaywrightEngine } from './playwright-engine.ts';
import { StreamlinkEngine } from './streamlink-engine.ts';
import { YtdlpEngine } from './ytdlp-engine.ts';
import { FfmpegEngine } from './ffmpeg-engine.ts';
import { RetryEngine } from './retry-engine.ts';
import { DownloadTask, EngineResult, ErrorCategory } from '../types.ts';
import { killTaskProcesses } from '../utils/cleaner.ts';
import { validateMediaFile } from '../utils/ffmpeg.ts';
import { logger } from '../logger.ts';
import { evaluateRetryPolicy, executeTaskRetryAction } from '../utils/retry-handler.ts';

function classifyError(errStr: string, explicitType?: ErrorCategory, hasStreamUrl = false): ErrorCategory {
  if (explicitType) {
    if (explicitType === 'EXTRACTOR_UNSUPPORTED' && hasStreamUrl) {
      return 'NETWORK_ERROR';
    }
    return explicitType;
  }
  const lower = errStr.toLowerCase();

  // Strict DRM check
  if (
    lower.includes('drm') ||
    lower.includes('widevine') ||
    lower.includes('fairplay') ||
    lower.includes('playready') ||
    lower.includes('clearkey')
  ) {
    return 'DRM_PROTECTED';
  }

  // Unsupported encryption check (e.g. SAMPLE-AES)
  if (lower.includes('sample-aes') || lower.includes('unsupported encryption')) {
    return 'UNSUPPORTED_ENCRYPTION';
  }

  // Expired URL & token signature check
  if (
    lower.includes('expired') ||
    lower.includes('403 forbidden') ||
    lower.includes('401 unauthorized') ||
    lower.includes('token or session has expired')
  ) {
    return 'EXPIRED_URL';
  }

  // Segment validation error check
  if (
    lower.includes('segment') ||
    lower.includes('bitstream') ||
    lower.includes('truncated segment')
  ) {
    return 'SEGMENT_ERROR';
  }

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) {
    return 'TIMEOUT';
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('connection reset') ||
    lower.includes('connection refused')
  ) {
    return 'NETWORK_ERROR';
  }
  if (lower.includes('no media') || lower.includes('no direct video') || lower.includes('404')) {
    return 'NO_MEDIA_FOUND';
  }
  if (lower.includes('m3u8')) {
    return 'NO_M3U8_FOUND';
  }
  if (lower.includes('ffmpeg') || lower.includes('remux') || lower.includes('transcode')) {
    return 'FFMPEG_ERROR';
  }
  if (lower.includes('spawn') || lower.includes('enoent') || lower.includes('exit code')) {
    return 'PROCESS_ERROR';
  }
  if (lower.includes('invalid') || lower.includes('corrupt') || lower.includes('truncated')) {
    return 'INVALID_MEDIA';
  }
  if (hasStreamUrl) {
    return 'NETWORK_ERROR';
  }
  return 'EXTRACTOR_UNSUPPORTED';
}

export class FallbackOrchestrator {
  private engines: BaseEngine[] = [];

  constructor() {
    // Registered in prioritized fallback order (Engine 1 to Engine 6)
    this.engines = [
      new DirectEngine(),       // Engine 1: Direct HTTP / HLS Detection
      new PlaywrightEngine(),   // Engine 2: Playwright + Chromium Network Discovery
      new StreamlinkEngine(),   // Engine 3: Streamlink
      new YtdlpEngine(),        // Engine 4: yt-dlp
      new FfmpegEngine(),       // Engine 5: FFmpeg Direct HLS Processing
      new RetryEngine(),        // Engine 6: Secondary Discovered Media Retry
    ];
  }

  getEngines(): BaseEngine[] {
    return [...this.engines];
  }

  async executeWithFallback(
    task: DownloadTask,
    onProgressUpdate?: (text: string, percent?: number) => void
  ): Promise<EngineResult> {
    logger.info(`Starting fallback download pipeline for task ${task.id} (${task.originalUrl})`);

    for (let i = 0; i < this.engines.length; i++) {
      if (task.abortController.signal.aborted) {
        return {
          success: false,
          engineName: 'Orchestrator',
          error: 'Task was cancelled',
          errorType: 'TIMEOUT',
        };
      }

      const engine = this.engines[i];
      const isAvailable = await engine.isAvailable();

      if (!isAvailable) {
        logger.debug(`Engine ${engine.name} is not available on this system, skipping.`);
        task.failedEngines.push({
          engine: engine.name,
          error: 'Not installed or unavailable in system PATH',
          errorType: 'PROCESS_ERROR',
          durationMs: 0,
        });
        continue;
      }

      task.activeEngine = engine.name;
      onProgressUpdate?.(`⚙️ Trying ${engine.name}...`);
      logger.job(`[JOB] Executing [${engine.name}] for task ${task.id}`);

      const engineStart = Date.now();
      try {
        const result = await engine.download(task, (text, percent) => {
          onProgressUpdate?.(text, percent);
        });

        const durationMs = Date.now() - engineStart;

        if (result.success && result.outputPath && fs.existsSync(result.outputPath)) {
          // Double check audio + video stream integrity: do not accept video-only output if audio is expected
          const mediaCheck = await validateMediaFile(result.outputPath);
          if (mediaCheck.valid) {
            // Check if audio is missing
            if (mediaCheck.meta.hasVideo && !mediaCheck.meta.hasAudio && i < this.engines.length - 1) {
              logger.warn(`[Orchestrator] ${engine.name} produced output without audio track. Trying subsequent engines for complete audio+video...`);
              onProgressUpdate?.(`⚠️ ${engine.name} output missing audio track. Trying next engine for audio...`);
              // Let loop continue to next engine to recover audio
            } else {
              logger.job(`[JOB] Success with [${engine.name}] in ${(durationMs / 1000).toFixed(1)}s (hasVideo=${mediaCheck.meta.hasVideo}, hasAudio=${mediaCheck.meta.hasAudio})`);
              return result;
            }
          }
        }

        // Failure on this engine -> Record, clean up, and continue to next engine
        const reason = result.error || 'Engine returned failure without message';
        const hasStreamUrl = Boolean(task.streamUrl);
        const errorCategory = classifyError(reason, result.errorType, hasStreamUrl);

        logger.taskError(task.id, engine.name, 'DOWNLOAD', errorCategory, reason);
        task.failedEngines.push({
          engine: engine.name,
          error: reason,
          errorType: errorCategory,
          durationMs,
        });

        // Kill any subprocesses spawned by this engine
        killTaskProcesses(task);

        // 1. Strict DRM & Unsupported Encryption Policy:
        // Do not pretend success, do not attempt to bypass DRM. Report reason and halt immediately.
        if (errorCategory === 'DRM_PROTECTED' || result.details?.isDrm) {
          logger.warn(`[Orchestrator] DRM protected media detected. Halting pipeline as DRM cannot be bypassed: ${reason}`);
          task.status = 'failed';
          task.errorCategory = 'DRM_PROTECTED';
          return {
            success: false,
            engineName: engine.name,
            error: reason,
            errorType: 'DRM_PROTECTED',
            details: result.details,
          };
        }

        if (errorCategory === 'UNSUPPORTED_ENCRYPTION') {
          logger.warn(`[Orchestrator] Unsupported encryption scheme detected. Halting pipeline: ${reason}`);
          task.status = 'failed';
          task.errorCategory = 'UNSUPPORTED_ENCRYPTION';
          return {
            success: false,
            engineName: engine.name,
            error: reason,
            errorType: 'UNSUPPORTED_ENCRYPTION',
            details: result.details,
          };
        }

        // 2. Error-Based Retry System:
        // 403 -> refresh session/header -> rediscover -> retry
        // 401 -> refresh authentication context -> rediscover -> retry
        // 429 -> backoff -> retry
        // 5xx -> exponential backoff -> retry
        // timeout -> retry
        // expired manifest -> rediscover -> retry
        // Enforces MAX_RETRIES with exponential backoff + jitter (no infinite retries)
        const retryDecision = evaluateRetryPolicy(reason, task.retryCount || 0, { maxRetries: 3 });
        if (retryDecision.shouldRetry) {
          task.retryCount = (task.retryCount || 0) + 1;
          task.lastRetryReason = retryDecision.reason;

          if (retryDecision.action === 'rediscover' || retryDecision.action === 'refresh_auth') {
            logger.info(`[Orchestrator] Retry (${task.retryCount}/3) action '${retryDecision.action}': ${retryDecision.reason}`);
            onProgressUpdate?.(`🔄 ${retryDecision.reason}`);
            await executeTaskRetryAction(task, retryDecision);
            // Restart orchestrator loop to re-discover source page and download immediately
            i = -1;
            continue;
          } else if (retryDecision.action === 'backoff' || retryDecision.action === 'retry_immediate') {
            logger.info(`[Orchestrator] Retry (${task.retryCount}/3) action '${retryDecision.action}': ${retryDecision.reason}`);
            onProgressUpdate?.(`⏳ ${retryDecision.reason}`);
            await executeTaskRetryAction(task, retryDecision);
            // Retry engine if under retry budget
            if (task.retryCount <= 2) {
              i--;
              continue;
            }
          }
        } else if ((task.retryCount || 0) >= 3) {
          logger.warn(`[Orchestrator] MAX_RETRIES reached (${task.retryCount}/3) for task ${task.id}. Proceeding with next fallback.`);
        }

        // Notify progress editor about fallback
        if (i < this.engines.length - 1) {
          const nextEngine = this.engines[i + 1];
          onProgressUpdate?.(`⚠️ ${engine.name} failed. Falling back to ${nextEngine.name}...`);
        }
      } catch (err: any) {
        const durationMs = Date.now() - engineStart;
        const errStr = err?.message || String(err);
        const hasStreamUrl = Boolean(task.streamUrl);
        const errorCategory = classifyError(errStr, undefined, hasStreamUrl);

        logger.taskError(task.id, engine.name, 'DOWNLOAD', errorCategory, errStr);
        task.failedEngines.push({
          engine: engine.name,
          error: errStr,
          errorType: errorCategory,
          durationMs,
        });

        killTaskProcesses(task);

        // Catch block error-based retry evaluation
        const catchDecision = evaluateRetryPolicy(errStr, task.retryCount || 0, { maxRetries: 3 });
        if (catchDecision.shouldRetry) {
          task.retryCount = (task.retryCount || 0) + 1;
          task.lastRetryReason = catchDecision.reason;
          logger.info(`[Orchestrator] Exception Retry (${task.retryCount}/3) action '${catchDecision.action}': ${catchDecision.reason}`);
          onProgressUpdate?.(`🔄 ${catchDecision.reason}`);
          await executeTaskRetryAction(task, catchDecision);

          if (catchDecision.action === 'rediscover' || catchDecision.action === 'refresh_auth') {
            i = -1;
            continue;
          } else if (task.retryCount <= 2) {
            i--;
            continue;
          }
        }
      }
    }

    // All engines exhausted
    const summary = task.failedEngines.map(e => `• ${e.engine}: ${e.error}`).join('\n');
    return {
      success: false,
      engineName: 'All Engines Exhausted',
      error: `All download engines failed:\n${summary}`,
      errorType: 'NO_MEDIA_FOUND',
    };
  }
}
