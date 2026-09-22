/**
 * Core type definitions for Telegram HLS/M3U8 Downloader Userbot
 */

export type DownloadStatus =
  | 'queued'
  | 'detecting'
  | 'finding_media'
  | 'downloading'
  | 'processing'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ExtractedMedia {
  streamUrl: string;
  headers?: Record<string, string>;
  title?: string;
  isHls?: boolean;
  isDash?: boolean;
  mimeType?: string;
  cookies?: string;
}

export interface EngineResult {
  success: boolean;
  outputPath?: string;
  streamUrl?: string;
  engineName: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface DownloadTask {
  id: string;
  originalUrl: string;
  streamUrl?: string;
  streamHeaders?: Record<string, string>;
  chatId: any;
  messageId: number;
  status: DownloadStatus;
  statusMessage?: string;
  activeEngine?: string;
  failedEngines: Array<{ engine: string; error: string; durationMs: number }>;
  tempDir: string;
  outputPath?: string;
  thumbnailPath?: string;
  title?: string;
  duration?: number;
  width?: number;
  height?: number;
  sizeBytes?: number;
  progressPercent?: number;
  downloadSpeed?: string;
  etaSeconds?: number;
  startTime: number;
  endTime?: number;
  abortController: AbortController;
  subprocesses: number[]; // PIDs to kill on cancel/cleanup
}

export interface DoctorCheckItem {
  category: 'Environment' | 'Dependencies' | 'Binaries' | 'Telegram' | 'Filesystem';
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  details: string;
  remedy?: string;
}

export interface BotConfig {
  apiId: number;
  apiHash: string;
  session: string;
  sessionFilePath: string;
  maxConcurrentJobs: number;
  downloadTimeoutSeconds: number;
  tempDir: string;
  outputDir: string;
  logDir: string;
  port: number;
  autoDownloadSavedMessages: boolean;
  autoDownloadPrivate: boolean;
  autoDownloadGroups: boolean;
  commandPrefix: string;
  customPaths: {
    ffmpeg?: string;
    ytdlp?: string;
    streamlink?: string;
    chromium?: string;
  };
}
