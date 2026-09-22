import { BaseEngine } from './base.ts';
import { DirectEngine } from './direct-engine.ts';
import { PlaywrightEngine } from './playwright-engine.ts';
import { StreamlinkEngine } from './streamlink-engine.ts';
import { YtdlpEngine } from './ytdlp-engine.ts';
import { FfmpegEngine } from './ffmpeg-engine.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { killTaskProcesses } from '../utils/cleaner.ts';
import { logger } from '../logger.ts';

export class FallbackOrchestrator {
  private engines: BaseEngine[] = [];

  constructor() {
    // Registered in prioritized fallback order
    this.engines = [
      new DirectEngine(),       // Engine 1
      new PlaywrightEngine(),   // Engine 2
      new StreamlinkEngine(),   // Engine 3
      new YtdlpEngine(),        // Engine 4
      new FfmpegEngine(),       // Engine 5
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
        };
      }

      const engine = this.engines[i];
      const isAvailable = await engine.isAvailable();

      if (!isAvailable) {
        logger.debug(`Engine ${engine.name} is not available on this system, skipping.`);
        task.failedEngines.push({
          engine: engine.name,
          error: 'Not installed or unavailable in system PATH',
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
        logger.warn(`❌ [${engine.name}] failed (${(durationMs / 1000).toFixed(1)}s): ${reason}`);
        task.failedEngines.push({
          engine: engine.name,
          error: reason,
          durationMs,
        });

        // Clean up any remaining processes spawned by this engine
        killTaskProcesses(task);

        // Notify progress editor about fallback
        if (i < this.engines.length - 1) {
          const nextEngine = this.engines[i + 1];
          onProgressUpdate?.(`⚠️ ${engine.name} failed. Falling back to ${nextEngine.name}...`);
        }
      } catch (err: any) {
        const durationMs = Date.now() - engineStart;
        const errStr = err?.message || String(err);
        logger.error(`Exception in [${engine.name}]:`, errStr);
        task.failedEngines.push({
          engine: engine.name,
          error: errStr,
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
    };
  }
}
