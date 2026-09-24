import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DownloadTask, DownloadStatus, TelegramUploadResult } from '../types.ts';
import { config } from '../config.ts';
import { FallbackOrchestrator } from '../engines/orchestrator.ts';
import { createTaskDirectories, cleanupTaskTemp, killTaskProcesses, ensureDirectories } from '../utils/cleaner.ts';
import { enforceMax720p, resolveVideoThumbnail, probeMedia } from '../utils/ffmpeg.ts';
import { getAvailableDiskSpace } from '../utils/system.ts';
import { logger } from '../logger.ts';
import { createJobFingerprint, normalizeUrlForFingerprint } from '../utils/fingerprint.ts';

type JobCallback = (task: DownloadTask) => void;
type ProgressCallback = (statusText: string, percent?: number) => void;

interface QueuedJob {
  task: DownloadTask;
  onProgress?: ProgressCallback;
  onComplete: JobCallback;
  onError: (task: DownloadTask, error: Error) => void;
  subscribers?: Array<{
    onProgress?: ProgressCallback;
    onComplete: JobCallback;
    onError: (task: DownloadTask, error: Error) => void;
  }>;
}

const MIN_FREE_DISK_BYTES = 250 * 1024 * 1024; // 250 MB minimum free storage

export class DownloadQueue {
  private activeJobs: Map<string, DownloadTask> = new Map();
  private pendingQueue: QueuedJob[] = [];
  private completedJobs: DownloadTask[] = [];
  private uploadResults: TelegramUploadResult[] = [];
  private activeJobEntries: Map<string, QueuedJob> = new Map();
  private orchestrator: FallbackOrchestrator;
  private resultsFilePath: string;

  constructor() {
    this.orchestrator = new FallbackOrchestrator();
    ensureDirectories(config.tempDir, config.outputDir, config.logDir);

    this.resultsFilePath = path.join(config.outputDir, 'upload_results.json');
    this.loadPersistedResults();
  }

  private loadPersistedResults(): void {
    try {
      if (fs.existsSync(this.resultsFilePath)) {
        const data = fs.readFileSync(this.resultsFilePath, 'utf8');
        this.uploadResults = JSON.parse(data);
      }
    } catch {
      logger.warn('[QUEUE] Could not parse persisted upload_results.json, initializing empty');
      this.uploadResults = [];
    }
  }

  private savePersistedResults(): void {
    try {
      fs.writeFileSync(this.resultsFilePath, JSON.stringify(this.uploadResults, null, 2), 'utf8');
    } catch (err: any) {
      logger.error('[QUEUE] Failed to save upload_results.json:', err?.message || err);
    }
  }

  /**
   * Finds an active or queued job with the same URL or media fingerprint
   */
  findExistingJob(rawUrl: string): DownloadTask | undefined {
    const targetFp = createJobFingerprint(rawUrl);
    const normalizedTarget = normalizeUrlForFingerprint(rawUrl);

    // 1. Check actively running jobs
    for (const task of this.activeJobs.values()) {
      if (task.fingerprint === targetFp || normalizeUrlForFingerprint(task.originalUrl) === normalizedTarget) {
        return task;
      }
    }

    // 2. Check pending jobs
    for (const item of this.pendingQueue) {
      if (item.task.fingerprint === targetFp || normalizeUrlForFingerprint(item.task.originalUrl) === normalizedTarget) {
        return item.task;
      }
    }

    return undefined;
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
      const fingerprint = createJobFingerprint(options.originalUrl);

      // ─────────────────────────────────────────────────────────────
      // DUPLICATE JOB CHECK
      // If the same URL / media fingerprint is currently active:
      // DO NOT create duplicate download. Return existing job status.
      // ─────────────────────────────────────────────────────────────
      const existingTask = this.findExistingJob(options.originalUrl);
      if (existingTask) {
        logger.queue(`[QUEUE] Duplicate job detected for ${options.originalUrl}. Reusing active job ${existingTask.id} (Status: ${existingTask.status}).`);

        // Attach listener to existing job
        const activeEntry = this.activeJobEntries.get(existingTask.id);
        if (activeEntry) {
          if (!activeEntry.subscribers) activeEntry.subscribers = [];
          activeEntry.subscribers.push({
            onProgress,
            onComplete: resolve,
            onError: (t, err) => reject(err),
          });
          return;
        }

        const pendingEntry = this.pendingQueue.find(j => j.task.id === existingTask.id);
        if (pendingEntry) {
          if (!pendingEntry.subscribers) pendingEntry.subscribers = [];
          pendingEntry.subscribers.push({
            onProgress,
            onComplete: resolve,
            onError: (t, err) => reject(err),
          });
          return;
        }

        return resolve(existingTask);
      }

      const taskId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const { tempDir, subDirs } = createTaskDirectories(config.tempDir, taskId);

      const task: DownloadTask = {
        id: taskId,
        originalUrl: options.originalUrl,
        fingerprint,
        chatId: options.chatId,
        messageId: options.messageId,
        status: 'queued',
        failedEngines: [],
        tempDir,
        subDirs,
        workspace: tempDir,
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
      logger.queue(`[QUEUE] Enqueued task ${task.id} (Fingerprint: ${fingerprint.slice(0, 10)}...). Queue depth: ${this.pendingQueue.length}`);

      this.processNext();
    });
  }

  cancel(taskId: string): boolean {
    const active = this.activeJobs.get(taskId);
    if (active) {
      logger.queue(`[QUEUE] Cancelling active task ${taskId}`);
      active.status = 'cancelled';
      active.abortController.abort();
      killTaskProcesses(active);
      cleanupTaskTemp(active);
      this.activeJobs.delete(taskId);
      this.activeJobEntries.delete(taskId);
      this.processNext();
      return true;
    }

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

  /**
   * Persists completed Telegram upload result (jobId, telegramChatId, telegramMessageId, fileName, fileSize, title, sourceUrl, engine, timestamp)
   */
  recordUploadResult(result: TelegramUploadResult): void {
    this.uploadResults.unshift(result);
    if (this.uploadResults.length > 100) {
      this.uploadResults.pop();
    }
    this.savePersistedResults();
    logger.telegram(`[TELEGRAM] Upload result saved: jobId=${result.jobId} messageId=${result.telegramMessageId} size=${result.fileSize} engine=${result.engine}`);
  }

  getUploadResults(): TelegramUploadResult[] {
    return [...this.uploadResults];
  }

  recordCompletedJob(task: DownloadTask): void {
    this.completedJobs.unshift({ ...task });
    if (this.completedJobs.length > 25) {
      this.completedJobs.pop();
    }

    // Automatically record TelegramUploadResult if uploaded to channel
    if (task.channelMessageId) {
      this.recordUploadResult({
        jobId: task.id,
        telegramChatId: task.channelPeerId || String(task.chatId),
        telegramMessageId: task.channelMessageId,
        fileName: task.outputPath ? path.basename(task.outputPath) : `video_${task.id}.mp4`,
        fileSize: task.sizeBytes || 0,
        title: task.metadata?.translatedTitle || task.metadata?.originalTitle || task.title || 'Video',
        sourceUrl: task.originalUrl,
        engine: task.activeEngine || 'Direct / Fallback',
        timestamp: Date.now(),
      });
    }
  }

  getCompletedJobs(): DownloadTask[] {
    return [...this.completedJobs];
  }

  private async processNext(): Promise<void> {
    if (this.activeJobs.size >= config.maxConcurrentJobs) {
      return;
    }

    const nextJob = this.pendingQueue.shift();
    if (!nextJob) {
      return;
    }

    const { task, onProgress, onComplete, onError, subscribers } = nextJob;
    this.activeJobs.set(task.id, task);
    this.activeJobEntries.set(task.id, nextJob);

    // Multi-subscriber broadcast helpers
    const broadcastProgress = (statusText: string, percent?: number) => {
      onProgress?.(statusText, percent);
      if (subscribers) {
        for (const sub of subscribers) {
          sub.onProgress?.(statusText, percent);
        }
      }
    };

    const broadcastComplete = (completedTask: DownloadTask) => {
      onComplete(completedTask);
      if (subscribers) {
        for (const sub of subscribers) {
          sub.onComplete(completedTask);
        }
      }
    };

    const broadcastError = (failedTask: DownloadTask, err: Error) => {
      onError(failedTask, err);
      if (subscribers) {
        for (const sub of subscribers) {
          sub.onError(failedTask, err);
        }
      }
    };

    // 1. Storage Protection: Check available disk space before downloading
    const availableSpace = getAvailableDiskSpace(config.tempDir);
    if (availableSpace < MIN_FREE_DISK_BYTES) {
      const errMsg = `Insufficient storage: only ${(availableSpace / (1024 * 1024)).toFixed(1)} MB free (minimum 250 MB required)`;
      logger.taskError(task.id, 'Queue', 'STORAGE_CHECK', 'STORAGE_ERROR', errMsg);
      task.status = 'failed';
      task.errorCategory = 'STORAGE_ERROR';
      this.activeJobs.delete(task.id);
      this.activeJobEntries.delete(task.id);
      await cleanupTaskTemp(task);
      broadcastError(task, new Error(errMsg));
      this.processNext();
      return;
    }

    // Set task timeout
    const timeoutTimer = setTimeout(() => {
      logger.warn(`[Queue] Task ${task.id} timed out after ${config.downloadTimeoutSeconds}s. Aborting.`);
      task.status = 'failed';
      task.errorCategory = 'TIMEOUT';
      task.abortController.abort();
      killTaskProcesses(task);
    }, config.downloadTimeoutSeconds * 1000);

    try {
      task.status = 'detecting_url';
      broadcastProgress('🔎 Detecting source...', 5);

      // Execute fallback chain
      const result = await this.orchestrator.executeWithFallback(
        task,
        (progressText, percent) => {
          broadcastProgress(progressText, percent);
        }
      );

      clearTimeout(timeoutTimer);

      if (result.success && result.outputPath && fs.existsSync(result.outputPath)) {
        task.status = 'processing';
        broadcastProgress('⚙️ Processing...', 80);

        // 2. Enforce Max 720p (Aspect-ratio safe downscaling, NO upscaling if <= 720p, copy/remux priority)
        const processedFile = path.join(task.subDirs?.processed || task.tempDir, `processed_${task.id}.mp4`);
        const { outputPath: compliantVideoPath, meta: finalMeta, processingMode } = await enforceMax720p(
          result.outputPath,
          processedFile,
          (text, percent) => broadcastProgress(text, percent)
        );
        logger.ffmpeg(`[FFMPEG] Task ${task.id} processed via '${processingMode}' (Resolution: ${finalMeta.width}x${finalMeta.height})`);

        // Store final compliant video inside task workspace dedicated 'final' directory
        const workspaceFinalVideo = path.join(task.subDirs?.final || task.tempDir, `final_${task.id}.mp4`);
        fs.copyFileSync(compliantVideoPath, workspaceFinalVideo);

        // Copy final compliant file to permanent output directory for Telegram upload
        const permanentVideoPath = path.join(config.outputDir, `video_${task.id}.mp4`);
        fs.copyFileSync(workspaceFinalVideo, permanentVideoPath);
        task.outputPath = permanentVideoPath;

        // Populate task media details
        task.duration = finalMeta.duration;
        task.width = finalMeta.width;
        task.height = finalMeta.height;
        task.sizeBytes = finalMeta.sizeBytes;

        if (!task.metadata) {
          task.metadata = {};
        }
        task.metadata.duration = finalMeta.duration;
        task.metadata.width = finalMeta.width;
        task.metadata.height = finalMeta.height;
        task.metadata.resolution = finalMeta.width && finalMeta.height ? `${finalMeta.width}x${finalMeta.height}` : undefined;
        task.metadata.codec = finalMeta.videoCodec;
        task.metadata.audioCodec = finalMeta.audioCodec;
        task.metadata.fps = finalMeta.fps;
        task.metadata.filesize = finalMeta.sizeBytes;

        // 3. Resolve thumbnail
        task.status = 'generating_thumbnail';
        broadcastProgress('🖼️ Preparing thumbnail...', 95);

        const workspaceThumbPath = path.join(task.subDirs?.thumbnail || task.tempDir, `thumb_${task.id}.jpg`);
        const permanentThumbPath = path.join(config.outputDir, `thumb_${task.id}.jpg`);
        const thumbnailOutput = await resolveVideoThumbnail({
          videoPath: permanentVideoPath,
          outputPath: workspaceThumbPath,
          duration: finalMeta.duration,
          sourceThumbnail: task.metadata.sourceThumbnail,
          ogImage: task.metadata.ogImage,
          extractorThumbnail: task.metadata.extractorThumbnail || task.metadata.thumbnail,
        });

        if (thumbnailOutput && fs.existsSync(thumbnailOutput)) {
          fs.copyFileSync(thumbnailOutput, permanentThumbPath);
          task.thumbnailPath = permanentThumbPath;
        }

        task.status = 'uploading';
        broadcastProgress('📤 Uploading to channel...', 98);
        broadcastComplete(task);
      } else {
        task.status = 'failed';
        task.endTime = Date.now();
        const err = new Error(result.error || 'All download fallback engines failed');
        broadcastError(task, err);
      }
    } catch (err: any) {
      clearTimeout(timeoutTimer);
      task.status = 'failed';
      task.endTime = Date.now();
      broadcastError(task, err);
    } finally {
      this.activeJobs.delete(task.id);
      this.activeJobEntries.delete(task.id);
      // Clean up isolated temporary directories
      await cleanupTaskTemp(task);
      // Trigger next job in queue
      this.processNext();
    }
  }
}
