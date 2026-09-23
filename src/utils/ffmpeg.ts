import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getFfmpegPath, getFfprobePath } from './system.ts';
import { logger } from '../logger.ts';

export interface MediaMetadata {
  duration?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  sizeBytes?: number;
  fps?: number;
  bitrate?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  container?: string;
}

export interface MediaValidationResult {
  valid: boolean;
  meta: MediaMetadata;
  error?: string;
}

/**
 * Probes media file using ffprobe with fallback to ffmpeg stderr inspection.
 */
export async function probeMedia(filePath: string): Promise<MediaMetadata> {
  const meta: MediaMetadata = {};
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      meta.sizeBytes = stats.size;
    }
  } catch {
    // Ignore stat error
  }

  const ffprobeBin = getFfprobePath();

  try {
    const ffprobeCmd = `"${ffprobeBin}" -v quiet -print_format json -show_format -show_streams "${filePath}"`;
    const output = execSync(ffprobeCmd, { encoding: 'utf8', timeout: 15000 });
    const data = JSON.parse(output);

    if (data.format) {
      if (data.format.duration) {
        meta.duration = parseFloat(data.format.duration);
      }
      if (data.format.bit_rate) {
        meta.bitrate = parseInt(data.format.bit_rate, 10);
      }
      if (data.format.format_name) {
        meta.container = data.format.format_name;
      }
    }

    const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');
    if (videoStream) {
      meta.hasVideo = true;
      meta.width = videoStream.width;
      meta.height = videoStream.height;
      meta.videoCodec = videoStream.codec_name;
      if (!meta.duration && videoStream.duration) {
        meta.duration = parseFloat(videoStream.duration);
      }
      if (videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
        if (num && den) {
          meta.fps = Math.round(num / den);
        }
      }
    }

    const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio');
    if (audioStream) {
      meta.hasAudio = true;
      meta.audioCodec = audioStream.codec_name;
    }
  } catch {
    // Fallback: inspect ffmpeg stderr
    try {
      const ffmpegBin = getFfmpegPath();
      execSync(`"${ffmpegBin}" -i "${filePath}"`, {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        timeout: 10000,
      });
    } catch (err: any) {
      const stderr = err.stderr || '';
      const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (durMatch) {
        const hrs = parseInt(durMatch[1], 10);
        const mins = parseInt(durMatch[2], 10);
        const secs = parseFloat(durMatch[3]);
        meta.duration = hrs * 3600 + mins * 60 + secs;
      }
      const resMatch = stderr.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
      if (resMatch) {
        meta.hasVideo = true;
        meta.width = parseInt(resMatch[1], 10);
        meta.height = parseInt(resMatch[2], 10);
      }
      if (stderr.includes('Audio:')) {
        meta.hasAudio = true;
      }
    }
  }

  return meta;
}

/**
 * Validates that the downloaded file is a genuine, playable video with valid streams.
 */
export async function validateMediaFile(filePath: string): Promise<MediaValidationResult> {
  if (!fs.existsSync(filePath)) {
    return {
      valid: false,
      meta: {},
      error: 'File does not exist on disk',
    };
  }

  const stat = fs.statSync(filePath);
  if (stat.size < 1024) {
    return {
      valid: false,
      meta: { sizeBytes: stat.size },
      error: `File is too small or truncated (${stat.size} bytes)`,
    };
  }

  const meta = await probeMedia(filePath);

  if (!meta.hasVideo && !meta.width) {
    return {
      valid: false,
      meta,
      error: 'No valid video stream detected in container',
    };
  }

  return {
    valid: true,
    meta,
  };
}

/**
 * Enforces maximum 720p resolution without upscaling, preserving aspect ratio.
 */
export async function enforceMax720p(
  inputPath: string,
  outputPath: string,
  onProgress?: (progressText: string, percent?: number) => void
): Promise<{ outputPath: string; meta: MediaMetadata }> {
  const initialMeta = await probeMedia(inputPath);
  const ffmpegBin = getFfmpegPath();
  const height = initialMeta.height || 0;
  const width = initialMeta.width || 0;

  // Check if downscale is required (height > 720)
  const requiresDownscale = height > 720;

  if (requiresDownscale) {
    onProgress?.(`📐 Limiting resolution to max 720p (Source: ${width}x${height})...`, 85);
    logger.info(`Downscaling video from ${width}x${height} to max 720p...`);

    const filter = 'scale=-2:720';

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        ffmpegBin,
        [
          '-y',
          '-i',
          inputPath,
          '-vf',
          filter,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'copy',
          '-movflags',
          '+faststart',
          outputPath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );

      let stderr = '';
      proc.stderr.on('data', chunk => {
        const text = chunk.toString();
        stderr += text;
        const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (timeMatch && onProgress) {
          onProgress(`📐 Downscaling to 720p: ${timeMatch[1]}`, 90);
        }
      });

      proc.on('close', code => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          // If audio copy failed, retry with re-encoded audio
          logger.warn('Audio copy during 720p scale failed, retrying with aac re-encode');
          const retryProc = spawn(
            ffmpegBin,
            [
              '-y',
              '-i',
              inputPath,
              '-vf',
              filter,
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-crf',
              '23',
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              '-movflags',
              '+faststart',
              outputPath,
            ],
            { stdio: 'ignore' }
          );

          retryProc.on('close', c => {
            if (c === 0 && fs.existsSync(outputPath)) {
              resolve();
            } else {
              reject(new Error(`FFmpeg 720p downscaling failed: ${stderr.slice(-300)}`));
            }
          });
          retryProc.on('error', reject);
        }
      });

      proc.on('error', reject);
    });
  } else {
    // Native <= 720p: DO NOT upscale! Maintain native resolution
    onProgress?.(`⚙️ Maintaining native resolution (${width}x${height} <= 720p)...`, 85);
    logger.info(`Video is already <= 720p (${width}x${height}). Maintaining native resolution.`);

    // Fast copy or normalize container for Telegram
    await remuxToTelegramMp4(inputPath, outputPath, text => {
      onProgress?.(text, 88);
    });
  }

  const finalMeta = await probeMedia(outputPath);
  return { outputPath, meta: finalMeta };
}

/**
 * Normalizes an image file (downloaded or generated) to Telegram-compliant JPEG format:
 * - Dimensions: max 320x320 preserving ratio
 * - File size: strictly < 200 KB (Telegram thumb limit)
 * - Format: JPEG (.jpg)
 */
export async function normalizeTelegramThumbnail(
  rawImagePath: string,
  normalizedPath: string
): Promise<boolean> {
  const ffmpegBin = getFfmpegPath();
  try {
    if (!fs.existsSync(rawImagePath)) return false;
    const stat = fs.statSync(rawImagePath);
    if (stat.size < 50) return false;

    // Use FFmpeg to transcode to standard progressive/baseline JPEG with max dimension 320px
    await new Promise<boolean>((resolve) => {
      const proc = spawn(
        ffmpegBin,
        [
          '-y',
          '-i',
          rawImagePath,
          '-vf',
          'scale=320:320:force_original_aspect_ratio=decrease',
          '-q:v',
          '4',
          normalizedPath,
        ],
        { stdio: 'ignore' }
      );

      proc.on('close', code => {
        resolve(code === 0 && fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).size > 100);
      });
      proc.on('error', () => resolve(false));
    });

    if (fs.existsSync(normalizedPath)) {
      const normStat = fs.statSync(normalizedPath);
      // Telegram requires thumbnail under 200KB. Scale=320 with q:v=4 is usually 10-35KB.
      if (normStat.size > 0 && normStat.size < 200 * 1024) {
        return true;
      }
    }
  } catch (err: any) {
    logger.warn(`normalizeTelegramThumbnail error: ${err.message || err}`);
  }
  return false;
}

/**
 * Helper to download an external image URL and normalize to Telegram thumbnail
 */
async function downloadAndNormalizeImage(
  imageUrl: string,
  outputPath: string
): Promise<string | undefined> {
  if (!imageUrl || !imageUrl.startsWith('http')) return undefined;

  const rawTemp = `${outputPath}.raw_download`;
  try {
    logger.info(`[Thumbnail] Downloading external image candidate: ${imageUrl}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    clearTimeout(timer);

    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 200) {
        fs.writeFileSync(rawTemp, buffer);
        const normalized = await normalizeTelegramThumbnail(rawTemp, outputPath);
        try { fs.unlinkSync(rawTemp); } catch {}
        if (normalized && fs.existsSync(outputPath)) {
          return outputPath;
        }
      }
    }
  } catch (err: any) {
    logger.debug(`[Thumbnail] Download failed for candidate ${imageUrl}: ${err.message}`);
  } finally {
    try { if (fs.existsSync(rawTemp)) fs.unlinkSync(rawTemp); } catch {}
  }

  return undefined;
}

/**
 * Generates frame directly from video at specific timestamp using FFmpeg
 */
export async function captureVideoFrame(
  videoPath: string,
  outputPath: string,
  timestampStr: string
): Promise<boolean> {
  const ffmpegBin = getFfmpegPath();
  return new Promise<boolean>(resolve => {
    const proc = spawn(
      ffmpegBin,
      [
        '-y',
        '-ss',
        timestampStr,
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-q:v',
        '3',
        '-vf',
        'scale=320:320:force_original_aspect_ratio=decrease',
        outputPath,
      ],
      { stdio: 'ignore' }
    );

    proc.on('close', code => {
      resolve(code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100);
    });

    proc.on('error', () => resolve(false));
  });
}

/**
 * Resolves Thumbnail according to strict priority requirements:
 * 1. Thumbnail source (video poster, direct player source image)
 * 2. OpenGraph image (og:image, twitter:image)
 * 3. Extractor thumbnail (yt-dlp, streamlink, json-ld)
 * 4. Generate frame from video using FFmpeg (25s or safe fraction, with 0.5s fallback)
 *
 * Guarantees:
 * - Format strictly compatible with Telegram (JPEG, <= 320x320, < 200KB)
 * - Safe sizes that will not cause upload failure
 * - Non-fatal: if all thumbnail attempts fail, returns undefined rather than failing video upload
 */
export async function resolveVideoThumbnail(options: {
  videoPath: string;
  outputPath: string;
  duration?: number;
  sourceThumbnail?: string;
  ogImage?: string;
  extractorThumbnail?: string;
}): Promise<string | undefined> {
  const { videoPath, outputPath, duration, sourceThumbnail, ogImage, extractorThumbnail } = options;

  logger.info('[Thumbnail] Resolving thumbnail with strict priority: 1.Source -> 2.OG -> 3.Extractor -> 4.FFmpeg');

  // Priority 1: Thumbnail Source (Player Poster / Video Poster / Page Source)
  if (sourceThumbnail) {
    const res = await downloadAndNormalizeImage(sourceThumbnail, outputPath);
    if (res) {
      logger.info(`[Thumbnail] Resolved via Priority 1 (Source Thumbnail): ${sourceThumbnail}`);
      return res;
    }
  }

  // Priority 2: OpenGraph Image (og:image, twitter:image)
  if (ogImage) {
    const res = await downloadAndNormalizeImage(ogImage, outputPath);
    if (res) {
      logger.info(`[Thumbnail] Resolved via Priority 2 (OpenGraph Image): ${ogImage}`);
      return res;
    }
  }

  // Priority 3: Extractor Thumbnail (yt-dlp, streamlink, json-ld)
  if (extractorThumbnail) {
    const res = await downloadAndNormalizeImage(extractorThumbnail, outputPath);
    if (res) {
      logger.info(`[Thumbnail] Resolved via Priority 3 (Extractor Thumbnail): ${extractorThumbnail}`);
      return res;
    }
  }

  // Priority 4: Generate frame from video using FFmpeg
  if (fs.existsSync(videoPath)) {
    // 4a. Calculate timestamp around 25th second (or 25% if shorter than 25s)
    let timestamp = '00:00:25.000';
    if (duration && duration < 25) {
      const safeSec = Math.max(0.5, Math.min(duration - 0.5, duration * 0.25));
      const mins = Math.floor(safeSec / 60);
      const secs = (safeSec % 60).toFixed(3);
      timestamp = `00:${mins.toString().padStart(2, '0')}:${secs.padStart(6, '0')}`;
    }

    logger.info(`[Thumbnail] Generating frame from video at ${timestamp} (duration: ${duration || 'unknown'}s)...`);
    const frameSuccess = await captureVideoFrame(videoPath, outputPath, timestamp);
    if (frameSuccess) {
      logger.info('[Thumbnail] Resolved via Priority 4 (FFmpeg frame capture at 25s/ratio)');
      return outputPath;
    }

    // 4b. Frame capture fallback: seek to 00:00:00.500 if 25s failed (e.g. keyframe seek issue)
    const fallbackFrame = await captureVideoFrame(videoPath, outputPath, '00:00:00.500');
    if (fallbackFrame) {
      logger.info('[Thumbnail] Resolved via Priority 4 (FFmpeg frame capture at 0.5s fallback)');
      return outputPath;
    }
  }

  logger.warn('[Thumbnail] All thumbnail candidates failed. Proceeding without thumbnail (non-fatal).');
  return undefined;
}

/**
 * Standard remux to MP4 with faststart for streaming support in Telegram.
 */
export async function remuxToTelegramMp4(
  inputPath: string,
  outputPath: string,
  onProgress?: (progressText: string) => void
): Promise<boolean> {
  const ffmpegBin = getFfmpegPath();

  return new Promise((resolve, reject) => {
    // Try fast copy remux first
    const proc = spawn(
      ffmpegBin,
      [
        '-y',
        '-i',
        inputPath,
        '-c',
        'copy',
        '-bsf:a',
        'aac_adtstoasc',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    let stderr = '';
    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (timeMatch && onProgress) {
        onProgress(`Processing: ${timeMatch[1]}`);
      }
    });

    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(true);
      } else {
        logger.warn('Fast copy remux failed, attempting transcode to MP4:', stderr.slice(-200));
        // Fallback: re-encode video to h264 + aac
        const reencode = spawn(
          ffmpegBin,
          [
            '-y',
            '-i',
            inputPath,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            outputPath,
          ],
          { stdio: 'ignore' }
        );

        reencode.on('close', c => {
          resolve(c === 0 && fs.existsSync(outputPath));
        });
        reencode.on('error', err => reject(err));
      }
    });

    proc.on('error', err => {
      logger.error('FFmpeg execution error:', err);
      reject(err);
    });
  });
}
