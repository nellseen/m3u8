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
import { logger } from '../logger.ts';

function classifyError(errStr: string, explicitType?: ErrorCategory): ErrorCategory {
  if (explicitType) return explicitType;
  const lower = errStr.toLowerCase();
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
      logger.info(`Executing [${engine.name}] for task ${task.id}`);

      const engineStart = Date.now();
      try {
        const result = await engine.download(task, (text, percent) => {
          onProgressUpdate?.(text, percent);
        });

        const durationMs = Date.now() - engineStart;

        if (result.success && result.outputPath) {
          logger.info(`✅ Success with [${engine.name}] in ${(durationMs / 1000).toFixed(1)}s`);
          return result;
        }

        // Failure on this engine -> Record, clean up, and continue to next engine
        const reason = result.error || 'Engine returned failure without message';
        const errorCategory = classifyError(reason, result.errorType);

        logger.taskError(task.id, engine.name, 'DOWNLOAD', errorCategory, reason);
        task.failedEngines.push({
          engine: engine.name,
          error: reason,
          errorType: errorCategory,
          durationMs,
        });

        // Kill any subprocesses spawned by this engine
        killTaskProcesses(task);

        // Notify progress editor about fallback
        if (i < this.engines.length - 1) {
          const nextEngine = this.engines[i + 1];
          onProgressUpdate?.(`⚠️ ${engine.name} failed. Falling back to ${nextEngine.name}...`);
        }
      } catch (err: any) {
        const durationMs = Date.now() - engineStart;
        const errStr = err?.message || String(err);
        const errorCategory = classifyError(errStr);

        logger.taskError(task.id, engine.name, 'DOWNLOAD', errorCategory, errStr);
        task.failedEngines.push({
          engine: engine.name,
          error: errStr,
          errorType: errorCategory,
          durationMs,
        });

        killTaskProcesses(task);
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
