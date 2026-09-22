import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getFfmpegPath } from './system.ts';
import { logger } from '../logger.ts';

export interface MediaMetadata {
  duration?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  sizeBytes?: number;
}

export async function probeMedia(filePath: string): Promise<MediaMetadata> {
  const meta: MediaMetadata = {};
  try {
    const stats = fs.statSync(filePath);
    meta.sizeBytes = stats.size;
  } catch {
    // Ignore stat error
  }

  try {
    // Use ffprobe if available
    const ffprobeCmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`;
    const output = execSync(ffprobeCmd, { encoding: 'utf8', timeout: 15000 });
    const data = JSON.parse(output);

    if (data.format?.duration) {
      meta.duration = parseFloat(data.format.duration);
    }

    const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');
    if (videoStream) {
      meta.width = videoStream.width;
      meta.height = videoStream.height;
      meta.videoCodec = videoStream.codec_name;
      if (!meta.duration && videoStream.duration) {
        meta.duration = parseFloat(videoStream.duration);
      }
    }

    const audioStream = data.streams?.find((s: any) => s.codec_type === 'audio');
    if (audioStream) {
      meta.audioCodec = audioStream.codec_name;
    }
  } catch {
    // If ffprobe is not installed, fallback to ffmpeg stderr inspection
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
        meta.width = parseInt(resMatch[1], 10);
        meta.height = parseInt(resMatch[2], 10);
      }
    }
  }

  return meta;
}

export async function generateThumbnail(videoPath: string, outputPath: string): Promise<boolean> {
  const ffmpegBin = getFfmpegPath();
  return new Promise(resolve => {
    // Capture snapshot at 0.5s
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
        'scale=320:-1',
        outputPath,
      ],
      { stdio: 'ignore' }
    );

    proc.on('close', code => {
      resolve(code === 0 && fs.existsSync(outputPath));
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

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
        logger.warn('Fast copy remux failed, attempting standard transcode to MP4:', stderr.slice(-300));
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
            'fast',
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
