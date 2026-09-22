import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DownloadTask, DownloadStatus } from '../types.ts';
import { config } from '../config.ts';
import { FallbackOrchestrator } from '../engines/orchestrator.ts';
import { cleanupTaskTemp, killTaskProcesses, ensureDirectories } from '../utils/cleaner.ts';
import { probeMedia, generateThumbnail } from '../utils/ffmpeg.ts';
import { logger } from '../logger.ts';

type JobCallback = (task: DownloadTask) => void;
type ProgressCallback = (statusText: string, percent?: number) => void;

interface QueuedJob {
  task: DownloadTask;
  onProgress?: ProgressCallback;
  onComplete: JobCallback;
  onError: (task: DownloadTask, error: Error) => void;
}

export class DownloadQueue {
  private activeJobs: Map<string, DownloadTask> = new Map();
  private pendingQueue: QueuedJob[] = [];
  private orchestrator: FallbackOrchestrator;

  constructor() {
    this.orchestrator = new FallbackOrchestrator();
    ensureDirectories(config.tempDir, config.outputDir, config.logDir);
  }

  enqueue(
    options: {
      originalUrl: string;
      chatId: any;
      messageId: number;
    },
    onProgress?: ProgressCallback
  ): Promise<DownloadTask> {
    return new Promise((resolve, reject) => {
      const taskId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const jobTempDir = path.join(config.tempDir, taskId);
      fs.mkdirSync(jobTempDir, { recursive: true });

      const task: DownloadTask = {
        id: taskId,
        originalUrl: options.originalUrl,
        chatId: options.chatId,
        messageId: options.messageId,
        status: 'queued',
        failedEngines: [],
        tempDir: jobTempDir,
        startTime: Date.now(),
        abortController: new AbortController(),
        subprocesses: [],
      };

      const queuedJob: QueuedJob = {
        task,
        onProgress,
        onComplete: completedTask => resolve(completedTask),
        onError: (failedTask, error) => reject(error),
      };

      this.pendingQueue.push(queuedJob);
      logger.info(`Enqueued task ${task.id}. Pending queue size: ${this.pendingQueue.length}`);

      this.processNext();
    });
  }

  cancel(taskId: string): boolean {
    // Check active
    const active = this.activeJobs.get(taskId);
    if (active) {
      logger.info(`Cancelling active task ${taskId}`);
      active.status = 'cancelled';
      active.abortController.abort();
      killTaskProcesses(active);
      cleanupTaskTemp(active);
      this.activeJobs.delete(taskId);
      this.processNext();
      return true;
    }

    // Check pending
    const idx = this.pendingQueue.findIndex(j => j.task.id === taskId);
    if (idx !== -1) {
      const [removed] = this.pendingQueue.splice(idx, 1);
      removed.task.status = 'cancelled';
      cleanupTaskTemp(removed.task);
      return true;
    }

    return false;
  }

  getActiveJobs(): DownloadTask[] {
    return Array.from(this.activeJobs.values());
  }

  getPendingQueueLength(): number {
    return this.pendingQueue.length;
  }

  private async processNext(): Promise<void> {
    if (this.activeJobs.size >= config.maxConcurrentJobs) {
      return;
    }

    const nextJob = this.pendingQueue.shift();
    if (!nextJob) {
      return;
    }

    const { task, onProgress, onComplete, onError } = nextJob;
    this.activeJobs.set(task.id, task);

    // Start timeout watcher
    const timeoutMs = config.downloadTimeoutSeconds * 1000;
    const timeoutTimer = setTimeout(() => {
      if (this.activeJobs.has(task.id)) {
        logger.warn(`Task ${task.id} timed out after ${config.downloadTimeoutSeconds}s. Aborting.`);
        task.status = 'failed';
        task.abortController.abort();
        killTaskProcesses(task);
      }
    }, timeoutMs);

    try {
      task.status = 'detecting';
      onProgress?.('🔎 Detecting media source...', 5);

      const result = await this.orchestrator.executeWithFallback(task, (text, percent) => {
        task.statusMessage = text;
        if (percent !== undefined) {
          task.progressPercent = percent;
        }
        onProgress?.(text, percent);
      });

      clearTimeout(timeoutTimer);

      if (result.success && result.outputPath && fs.existsSync(result.outputPath)) {
        task.status = 'processing';
        onProgress?.('⚙️ Extracting video metadata & generating preview...', 95);

        // Probe media info
        const meta = await probeMedia(result.outputPath);
        task.duration = meta.duration;
        task.width = meta.width;
        task.height = meta.height;
        task.sizeBytes = meta.sizeBytes;

        // Move to permanent output directory to prevent temp cleanup collision
        const finalFilename = `video_${task.id}.mp4`;
        const permanentOutputPath = path.join(config.outputDir, finalFilename);
        fs.copyFileSync(result.outputPath, permanentOutputPath);
        task.outputPath = permanentOutputPath;

        // Thumbnail
        const thumbPath = path.join(task.tempDir, `thumb_${task.id}.jpg`);
        const hasThumb = await generateThumbnail(permanentOutputPath, thumbPath);
        if (hasThumb) {
          task.thumbnailPath = thumbPath;
        }

        task.status = 'completed';
        task.endTime = Date.now();
        onComplete(task);
      } else {
        task.status = 'failed';
        task.endTime = Date.now();
        const err = new Error(result.error || 'All download fallback engines failed');
        onError(task, err);
      }
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      task.status = 'failed';
      task.endTime = Date.now();
      onError(task, err);
    } finally {
      this.activeJobs.delete(task.id);
      // Clean up isolated temp directory
      await cleanupTaskTemp(task);
      // Trigger next job in queue
      this.processNext();
    }
  }
}
