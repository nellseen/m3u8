/**
 * Core type definitions for Telegram HLS/M3U8 Downloader Userbot
 */

export type DownloadStatus =
  | 'queued'
  | 'detecting_url'
  | 'extracting_metadata'
  | 'finding_media'
  | 'downloading'
  | 'processing'
  | 'limiting_resolution'
  | 'generating_thumbnail'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ErrorCategory =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'NO_MEDIA_FOUND'
  | 'NO_M3U8_FOUND'
  | 'EXTRACTOR_UNSUPPORTED'
  | 'PROCESS_ERROR'
  | 'FFMPEG_ERROR'
  | 'INVALID_MEDIA'
  | 'METADATA_ERROR'
  | 'TRANSLATION_ERROR'
  | 'THUMBNAIL_ERROR'
  | 'TELEGRAM_UPLOAD_ERROR'
  | 'STORAGE_ERROR';

export interface ExtractedMedia {
  streamUrl: string;
  headers?: Record<string, string>;
  title?: string;
  isHls?: boolean;
  isDash?: boolean;
  mimeType?: string;
  cookies?: string;
}

export interface ExtractedMetadata {
  originalTitle?: string;
  translatedTitle?: string;
  description?: string;
  source?: string;
  domain?: string;
  duration?: number;
  resolution?: string; // e.g. "1280x720"
  width?: number;
  height?: number;
  codec?: string;
  audioCodec?: string;
  fps?: number;
  filesize?: number;
  thumbnail?: string; // candidate image url or local path
  detectedLanguage?: string;
  translationStatus?: 'not_needed' | 'translated' | 'failed';
}

export interface TaskSubDirectories {
  source: string;
  download: string;
  processed: string;
  thumbnail: string;
  logs: string;
}

export interface EngineResult {
  success: boolean;
  outputPath?: string;
  streamUrl?: string;
  engineName: string;
  error?: string;
  errorType?: ErrorCategory;
  details?: Record<string, unknown>;
}

export interface DownloadTask {
  id: string;
  originalUrl: string;
  streamUrl?: string;
  streamHeaders?: Record<string, string>;
  cookies?: string;
  discoveredMedia?: ExtractedMedia[];
  chatId: any;
  messageId: number;
  status: DownloadStatus;
  statusMessage?: string;
  activeEngine?: string;
  failedEngines: Array<{
    engine: string;
    error: string;
    errorType?: ErrorCategory;
    durationMs: number;
  }>;
  tempDir: string;
  subDirs?: TaskSubDirectories;
  outputPath?: string;
  thumbnailPath?: string;
  metadata?: ExtractedMetadata;
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
  errorCategory?: ErrorCategory;
}

export interface DoctorCheckItem {
  category: 'Environment' | 'Dependencies' | 'Binaries' | 'Playwright' | 'Chromium' | 'Telegram' | 'Filesystem';
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  details: string;
  remedy?: string;
}

export interface ChromiumCandidate {
  path?: string; // undefined means Playwright bundled
  source: 'configured' | 'system-path' | 'system-known-location' | 'playwright-bundled' | 'scanned-cache';
  architecture: string;
  exists: boolean;
}

export interface PlaywrightHealthResult {
  success: boolean;
  stage: 'resolve' | 'launch' | 'context' | 'page' | 'evaluate' | 'close';
  version?: string;
  userAgent?: string;
  error?: string;
  stderr?: string;
  executablePath?: string;
  isSingleProcess?: boolean;
}

export interface ResolvedChromium {
  path: string | undefined;
  source: 'configured' | 'system-path' | 'system-known-location' | 'playwright-bundled' | 'scanned-cache' | 'none';
  architecture: string;
  verified: boolean;
  version?: string;
  isSingleProcess?: boolean;
  error?: string;
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
