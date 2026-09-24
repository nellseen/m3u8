import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DownloadTask, DownloadStatus } from '../types.ts';
import { config } from '../config.ts';
import { FallbackOrchestrator } from '../engines/orchestrator.ts';
import { createTaskDirectories, cleanupTaskTemp, killTaskProcesses, ensureDirectories } from '../utils/cleaner.ts';
import { enforceMax720p, resolveVideoThumbnail, probeMedia } from '../utils/ffmpeg.ts';
import { getAvailableDiskSpace } from '../utils/system.ts';
import { logger } from '../logger.ts';

type JobCallback = (task: DownloadTask) => void;
type ProgressCallback = (statusText: string, percent?: number) => void;

interface QueuedJob {
  task: DownloadTask;
  onProgress?: ProgressCallback;
  onComplete: JobCallback;
  onError: (task: DownloadTask, error: Error) => void;
}

const MIN_FREE_DISK_BYTES = 250 * 1024 * 1024; // 250 MB minimum free storage

export class DownloadQueue {
  private activeJobs: Map<string, DownloadTask> = new Map();
  private pendingQueue: QueuedJob[] = [];
  private completedJobs: DownloadTask[] = [];
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
      const { tempDir, subDirs } = createTaskDirectories(config.tempDir, taskId);

      const task: DownloadTask = {
        id: taskId,
        originalUrl: options.originalUrl,
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
      logger.info(`Enqueued task ${task.id}. Pending queue length: ${this.pendingQueue.length}`);

      this.processNext();
    });
  }

  cancel(taskId: string): boolean {
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

  recordCompletedJob(task: DownloadTask): void {
    this.completedJobs.unshift({ ...task });
    if (this.completedJobs.length > 25) {
      this.completedJobs.pop();
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

    const { task, onProgress, onComplete, onError } = nextJob;
    this.activeJobs.set(task.id, task);

    // 1. Storage Protection: Check available disk space before downloading
    const availableSpace = getAvailableDiskSpace(config.tempDir);
    if (availableSpace < MIN_FREE_DISK_BYTES) {
      const errMsg = `Insufficient storage: only ${(availableSpace / (1024 * 1024)).toFixed(1)} MB free (minimum 250 MB required)`;
      logger.taskError(task.id, 'Queue', 'STORAGE_CHECK', 'STORAGE_ERROR', errMsg);
      task.status = 'failed';
      task.errorCategory = 'STORAGE_ERROR';
      this.activeJobs.delete(task.id);
      await cleanupTaskTemp(task);
      onError(task, new Error(errMsg));
      this.processNext();
      return;
    }

    // Start job timeout watcher
    const timeoutMs = config.downloadTimeoutSeconds * 1000;
    const timeoutTimer = setTimeout(() => {
      if (this.activeJobs.has(task.id)) {
        logger.warn(`Task ${task.id} timed out after ${config.downloadTimeoutSeconds}s. Aborting.`);
        task.status = 'failed';
        task.errorCategory = 'TIMEOUT';
        task.abortController.abort();
        killTaskProcesses(task);
      }
    }, timeoutMs);

    try {
      task.status = 'detecting_url';
      onProgress?.('🔎 Detecting URL & media streams...', 5);

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
        onProgress?.('⚙️ Processing & enforcing resolution policy (max 720p)...', 80);

        // 2. Enforce Max 720p (Aspect-ratio safe downscaling, NO upscaling if <= 720p, copy/remux priority)
        const processedFile = path.join(task.subDirs?.processed || task.tempDir, `processed_${task.id}.mp4`);
        const { outputPath: compliantVideoPath, meta: finalMeta, processingMode } = await enforceMax720p(
          result.outputPath,
          processedFile,
          (text, percent) => onProgress?.(text, percent)
        );
        logger.info(`[Queue] Task ${task.id} processed via mode '${processingMode}' (Resolution: ${finalMeta.width}x${finalMeta.height})`);

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

        // 3. Resolve thumbnail according to strict priority:
        // 1. Thumbnail source
        // 2. OpenGraph image
        // 3. Extractor thumbnail
        // 4. Generate frame from video using FFmpeg (25s or safe fraction)
        task.status = 'generating_thumbnail';
        onProgress?.('🖼️ Resolving thumbnail (Source/OG/Extractor/FFmpeg)...', 95);

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
        onProgress?.('📤 Menyiapkan upload wajib ke TARGET_CHANNEL_ID...', 98);
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
      // Clean up isolated temporary directories
      await cleanupTaskTemp(task);
      // Trigger next job in queue
      this.processNext();
    }
  }
}
