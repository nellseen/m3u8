import fs from 'fs';
import { BaseEngine } from './base.ts';
import { DirectEngine } from './direct-engine.ts';
import { PlaywrightEngine } from './playwright-engine.ts';
import { StreamlinkEngine } from './streamlink-engine.ts';
import { YtdlpEngine } from './ytdlp-engine.ts';
import { FfmpegEngine } from './ffmpeg-engine.ts';
import { Aria2Engine } from './aria2-engine.ts';
import { RetryEngine } from './retry-engine.ts';
import { DownloadTask, EngineResult, ErrorCategory } from '../types.ts';
import { killTaskProcesses } from '../utils/cleaner.ts';
import { validateMediaFile } from '../utils/ffmpeg.ts';
import { logger } from '../logger.ts';
import { evaluateRetryPolicy, executeTaskRetryAction } from '../utils/retry-handler.ts';
import { isM3u8Url } from '../utils/url-extractor.ts';
import { isUrlExpired } from '../utils/signed-url.ts';
import { detectHlsEncryption, parseHlsManifest } from '../utils/m3u8-parser.ts';
import { planEngineRoute, EngineRegistry, RouteDecision } from '../utils/source-router.ts';
import { buildPropagatedHeaders } from '../utils/header-propagator.ts';

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
  private engineRegistry: EngineRegistry;

  constructor() {
    const direct = new DirectEngine();
    const playwright = new PlaywrightEngine();
    const streamlink = new StreamlinkEngine();
    const ytdlp = new YtdlpEngine();
    const ffmpeg = new FfmpegEngine();
    const aria2 = new Aria2Engine();
    const retry = new RetryEngine();

    this.engineRegistry = {
      direct,
      playwright,
      streamlink,
      ytdlp,
      ffmpeg,
      aria2,
      retry,
    };

    // Registered all 7 engines for inventory queries
    this.engines = [direct, playwright, streamlink, ytdlp, aria2, ffmpeg, retry];
  }

  getEngines(): BaseEngine[] {
    return [...this.engines];
  }

  getRegistry(): EngineRegistry {
    return this.engineRegistry;
  }

  /**
   * Pre-inspects direct M3U8 manifests before launching heavy engines.
   * Checks encryption (DRM / SAMPLE-AES), verifies expiration, and inspects variants.
   */
  private async preInspectDirectM3u8(
    task: DownloadTask,
    targetUrl: string,
    onProgressUpdate?: (text: string, percent?: number) => void
  ): Promise<EngineResult | null> {
    if (isUrlExpired(targetUrl)) {
      logger.warn(`[Orchestrator] Direct M3U8 URL signature is expired: ${targetUrl}`);
      task.status = 'failed';
      task.errorCategory = 'EXPIRED_URL';
      return {
        success: false,
        engineName: 'M3U8 Parser',
        error: 'Signed stream URL timestamp has expired. Re-discovery required.',
        errorType: 'EXPIRED_URL',
        details: { isExpiredUrl: true },
      };
    }

    onProgressUpdate?.('🔎 M3U8 Parser: Menganalisis manifest, enkripsi, dan varian...', 15);

    try {
      let content: string | null = null;

      if (fs.existsSync(targetUrl)) {
        content = fs.readFileSync(targetUrl, 'utf8');
      } else if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
        const reqHeaders = buildPropagatedHeaders(task.streamHeaders, task.cookies, {
          targetUrl,
          defaultUserAgent:
            task.streamHeaders?.['user-agent'] ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        });
        const res = await fetch(targetUrl, {
          headers: reqHeaders,
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          content = await res.text();
        }
      }

      if (content) {
        const encryption = detectHlsEncryption(content);
        task.encryption = encryption;

        if (encryption.isDrm) {
          logger.warn(`[Orchestrator] DRM protected stream detected by M3U8 Parser: ${encryption.reason}`);
          task.status = 'failed';
          task.errorCategory = 'DRM_PROTECTED';
          return {
            success: false,
            engineName: 'M3U8 Parser',
            error: encryption.reason || 'DRM protection detected. Cannot be bypassed.',
            errorType: 'DRM_PROTECTED',
            details: { isDrm: true, encryption },
          };
        }

        if (encryption.primaryMethod === 'SAMPLE-AES') {
          logger.warn('[Orchestrator] SAMPLE-AES encrypted stream detected by M3U8 Parser');
          task.status = 'failed';
          task.errorCategory = 'UNSUPPORTED_ENCRYPTION';
          return {
            success: false,
            engineName: 'M3U8 Parser',
            error: 'SAMPLE-AES encryption is not supported by standard pipelines.',
            errorType: 'UNSUPPORTED_ENCRYPTION',
            details: { encryption },
          };
        }

        const parsed = parseHlsManifest(content, targetUrl);
        if (parsed.type === 'MASTER') {
          logger.info(`[Orchestrator] MASTER playlist parsed with ${parsed.variants.length} variants and ${parsed.audioGroups.length} audio groups.`);
          if (parsed.selectedVariant) {
            logger.info(`[Orchestrator] Selected variant: ${parsed.selectedVariant.resolution || 'optimal'} (${parsed.selectedVariant.uri})`);
            task.streamUrl = parsed.selectedVariant.uri;
            if (parsed.selectedVariant.audioTrackUri) {
              logger.info(`[Orchestrator] Variant has separated audio track: ${parsed.selectedVariant.audioTrackUri}`);
            }
          }
        } else if (parsed.type === 'MEDIA') {
          logger.info(`[Orchestrator] MEDIA playlist parsed with ${parsed.segments.length} segments (total duration: ${parsed.totalDuration}s, isLive: ${parsed.isLive}).`);
          task.streamUrl = targetUrl;
        }
      }
    } catch (err: any) {
      logger.debug(`[Orchestrator] Direct M3U8 parser pre-inspection exception: ${err.message}`);
    }

    return null;
  }

  async executeWithFallback(
    task: DownloadTask,
    onProgressUpdate?: (text: string, percent?: number) => void
  ): Promise<EngineResult> {
    logger.info(`Starting intelligent download pipeline for task ${task.id} (${task.originalUrl})`);

    // 1. Direct M3U8 Fast-Path & Pre-Inspection
    const initialTarget = task.streamUrl || task.originalUrl;
    const isDirectManifest = isM3u8Url(initialTarget) || initialTarget.endsWith('.m3u8') || initialTarget.includes('.m3u8');

    if (isDirectManifest) {
      const preCheckResult = await this.preInspectDirectM3u8(task, initialTarget, onProgressUpdate);
      if (preCheckResult) {
        return preCheckResult;
      }
    }

    // 2. Intelligent Engine Route Planning based on Source Characteristics
    let routeDecision: RouteDecision = planEngineRoute(task, this.engineRegistry);
    logger.info(`[Orchestrator] Intelligent Route Decision: ${routeDecision.category} -> ${routeDecision.reason}`);
    onProgressUpdate?.(`🧭 Strategy: ${routeDecision.category}`);

    let activePipeline: BaseEngine[] = [...routeDecision.recommendedEngines];
    let manifestAlreadyDiscovered = Boolean(task.streamUrl);

    for (let i = 0; i < activePipeline.length; i++) {
      if (task.abortController.signal.aborted) {
        return {
          success: false,
          engineName: 'Orchestrator',
          error: 'Task was cancelled',
          errorType: 'TIMEOUT',
        };
      }

      const engine = activePipeline[i];
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

        // Check if an engine discovered a new manifest URL during page discovery
        if (!manifestAlreadyDiscovered && task.streamUrl) {
          manifestAlreadyDiscovered = true;
          logger.info(`[Orchestrator] Manifest discovered (${task.streamUrl}). Re-planning route to bypass any remaining browser overhead.`);
          // Switch to Direct M3U8 pipeline immediately
          activePipeline = [
            this.engineRegistry.aria2,
            this.engineRegistry.ffmpeg,
            this.engineRegistry.ytdlp,
            this.engineRegistry.streamlink,
            this.engineRegistry.retry,
          ];
          i = -1; // Next loop starts at index 0 of the new pipeline
          continue;
        }

        if (result.success && result.outputPath && fs.existsSync(result.outputPath)) {
          // Double check audio + video stream integrity
          const mediaCheck = await validateMediaFile(result.outputPath);
          if (mediaCheck.valid) {
            if (mediaCheck.meta.hasVideo && !mediaCheck.meta.hasAudio && i < activePipeline.length - 1) {
              logger.warn(`[Orchestrator] ${engine.name} produced output without audio track. Trying subsequent engines for complete audio+video...`);
              onProgressUpdate?.(`⚠️ ${engine.name} output missing audio track. Trying next engine for audio...`);
            } else {
              logger.job(`[JOB] Success with [${engine.name}] in ${(durationMs / 1000).toFixed(1)}s (hasVideo=${mediaCheck.meta.hasVideo}, hasAudio=${mediaCheck.meta.hasAudio})`);
              return result;
            }
          }
        }

        // Failure on this engine -> Record, clean up, and evaluate retry / fallback
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

        killTaskProcesses(task);

        // Strict DRM & Unsupported Encryption Policy: halt immediately
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

        // Error-Based Retry Evaluation
        const retryDecision = evaluateRetryPolicy(reason, task.retryCount || 0, { maxRetries: 3 });
        if (retryDecision.shouldRetry) {
          task.retryCount = (task.retryCount || 0) + 1;
          task.lastRetryReason = retryDecision.reason;

          if (retryDecision.action === 'rediscover' || retryDecision.action === 'refresh_auth') {
            logger.info(`[Orchestrator] Retry (${task.retryCount}/3) action '${retryDecision.action}': ${retryDecision.reason}`);
            onProgressUpdate?.(`🔄 ${retryDecision.reason}`);
            await executeTaskRetryAction(task, retryDecision);
            i = -1;
            continue;
          } else if (retryDecision.action === 'backoff' || retryDecision.action === 'retry_immediate') {
            logger.info(`[Orchestrator] Retry (${task.retryCount}/3) action '${retryDecision.action}': ${retryDecision.reason}`);
            onProgressUpdate?.(`⏳ ${retryDecision.reason}`);
            await executeTaskRetryAction(task, retryDecision);
            if (task.retryCount <= 2) {
              i--;
              continue;
            }
          }
        } else if ((task.retryCount || 0) >= 3) {
          logger.warn(`[Orchestrator] MAX_RETRIES reached (${task.retryCount}/3) for task ${task.id}. Proceeding with next fallback.`);
        }

        if (i < activePipeline.length - 1) {
          const nextEngine = activePipeline[i + 1];
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
