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
 * Detailed media probing using ffprobe JSON output with fallback to ffmpeg inspection.
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
 * Validates that the downloaded file is a genuine, playable video with valid streams and duration.
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
 * Landscape: max height 720 (scale=-2:720)
 * Portrait / Square: max height 720 preserving ratio
 * If height <= 720: do NOT upscale, maintain native resolution!
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
 * Generates thumbnail at the 25th second (or safe fraction if video is shorter than 25s).
 * Fallback to candidate thumbnail URL from metadata if FFmpeg frame capture fails.
 */
export async function generateThumbnailAt25s(
  videoPath: string,
  outputPath: string,
  duration?: number,
  fallbackCandidateUrl?: string
): Promise<string | undefined> {
  const ffmpegBin = getFfmpegPath();

  // 1. Calculate timestamp around 00:00:25
  let timestamp = '00:00:25.000';
  if (duration && duration < 25) {
    // If shorter than 25s, use 25% of duration or safe midpoint
    const safeSec = Math.max(0.5, Math.min(duration - 0.5, duration * 0.25));
    const mins = Math.floor(safeSec / 60);
    const secs = (safeSec % 60).toFixed(3);
    timestamp = `00:${mins.toString().padStart(2, '0')}:${secs.padStart(6, '0')}`;
  }

  logger.info(`Generating video thumbnail at timestamp ${timestamp} (duration: ${duration || 'unknown'}s)...`);

  const ffmpegSuccess = await new Promise<boolean>(resolve => {
    const proc = spawn(
      ffmpegBin,
      [
        '-y',
        '-ss',
        timestamp,
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-q:v',
        '3',
        '-vf',
        'scale=320:-2',
        outputPath,
      ],
      { stdio: 'ignore' }
    );

    proc.on('close', code => {
      resolve(code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });

  if (ffmpegSuccess) {
    return outputPath;
  }

  // 2. Fallback: try capturing frame at 0.5s if 25s failed (e.g. keyframe seek issue)
  const initialFrameSuccess = await new Promise<boolean>(resolve => {
    const proc = spawn(
      ffmpegBin,
      [
        '-y',
        '-ss',
        '00:00:00.500',
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-q:v',
        '3',
        '-vf',
        'scale=320:-2',
        outputPath,
      ],
      { stdio: 'ignore' }
    );

    proc.on('close', code => {
      resolve(code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });

  if (initialFrameSuccess) {
    return outputPath;
  }

  // 3. Fallback: download web/OpenGraph thumbnail candidate if available
  if (fallbackCandidateUrl && fallbackCandidateUrl.startsWith('http')) {
    try {
      logger.info(`FFmpeg thumbnail failed, falling back to metadata thumbnail: ${fallbackCandidateUrl}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(fallbackCandidateUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > 200) {
          fs.writeFileSync(outputPath, buffer);
          return outputPath;
        }
      }
    } catch {
      // Ignore fallback download errors
    }
  }

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
