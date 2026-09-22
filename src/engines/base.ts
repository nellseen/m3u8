import { DownloadTask, EngineResult } from '../types.ts';

export abstract class BaseEngine {
  abstract readonly name: string;
  abstract readonly priority: number;

  /**
   * Check if this engine and its prerequisites are installed/available on the system.
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Execute download with this engine.
   * If download fails, return EngineResult with success: false and detailed error.
   */
  abstract download(
    task: DownloadTask,
    onProgress?: (statusText: string, percent?: number) => void
  ): Promise<EngineResult>;
}
