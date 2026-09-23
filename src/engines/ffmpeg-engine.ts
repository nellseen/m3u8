import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { getFfmpegPath } from '../utils/system.ts';
import { validateMediaFile } from '../utils/ffmpeg.ts';
import { logger } from '../logger.ts';

/**
 * Builds HTTP headers string for FFmpeg -headers argument
 * Strictly propagates only genuine source session headers
 */
export function buildFfmpegHeaders(headers?: Record<string, string>, cookies?: string): string {
  if (!headers && !cookies) return '';

  let headerStr = '';
  const seenKeys = new Set<string>();

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (!value) continue;
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'content-length' || lowerKey === 'host') continue; // Managed by network stack

      if (!seenKeys.has(lowerKey)) {
        seenKeys.add(lowerKey);
        headerStr += `${key}: ${value}\r\n`;
      }
    }
  }

  // Ensure cookies are included if task has cookies but headers['cookie'] is absent
  if (cookies && !seenKeys.has('cookie')) {
    headerStr += `Cookie: ${cookies}\r\n`;
  }

  return headerStr;
}

export class FfmpegEngine extends BaseEngine {
  readonly name = 'FFmpeg HLS Direct (Engine 5)';
  readonly priority = 5;

  async isAvailable(): Promise<boolean> {
    try {
      const bin = getFfmpegPath();
      return Boolean(bin);
    } catch {
      return false;
    }
  }

  async download(
    task: DownloadTask,
    onProgress?: (statusText: string, percent?: number) => void
  ): Promise<EngineResult> {
    const targetUrl = task.streamUrl || task.originalUrl;
    const ffmpegBin = getFfmpegPath();
    const downloadDir = task.subDirs?.download || task.tempDir;
    const finalMp4 = path.join(downloadDir, `ffmpeg_output_${Date.now()}.mp4`);

    onProgress?.('⬇️ FFmpeg: Connecting to HLS manifest & downloading segments...', 35);

    const args: string[] = ['-y'];

    // Add protocol whitelist for HLS/crypto/data
    args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data');

    // Contextual header propagation (User-Agent, Referer, Origin, Cookie, Authorization, etc.)
    const headerStr = buildFfmpegHeaders(task.streamHeaders, task.cookies);
    if (headerStr) {
      args.push('-headers', headerStr);
    }

    args.push(
      '-i',
      targetUrl,
      '-c',
      'copy',
      '-bsf:a',
      'aac_adtstoasc',
      '-movflags',
      '+faststart',
      finalMp4
    );

    return new Promise(resolve => {
      let stderr = '';
      const proc = spawn(ffmpegBin, args);

      if (proc.pid) {
        task.subprocesses.push(proc.pid);
      }

      proc.stderr.on('data', data => {
        const text = data.toString();
        stderr += text;

        const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
        const speedMatch = text.match(/speed=\s*(\d+\.?\d*x)/);
        if (timeMatch && onProgress) {
          const time = timeMatch[1];
          const speed = speedMatch ? speedMatch[1] : '';
          onProgress(`⬇️ FFmpeg downloading HLS: ${time}${speed ? ` (${speed})` : ''}`, 60);
        }
      });

      const abortHandler = () => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      };

      task.abortController.signal.addEventListener('abort', abortHandler, { once: true });

      proc.on('close', async code => {
        task.abortController.signal.removeEventListener('abort', abortHandler);

        if (code === 0 && fs.existsSync(finalMp4) && fs.statSync(finalMp4).size > 1000) {
          const validation = await validateMediaFile(finalMp4);
          if (validation.valid) {
            resolve({
              success: true,
              outputPath: finalMp4,
              engineName: this.name,
            });
            return;
          }
        }

        // If stream copy failed due to incompatible codecs or variant issues, retry with transcoding
        logger.warn('FFmpeg copy failed, retrying with re-encode fallback...');
        const transcodeArgs = [
          '-y',
          '-protocol_whitelist',
          'file,http,https,tcp,tls,crypto,data',
        ];

        if (headerStr) {
          transcodeArgs.push('-headers', headerStr);
        }

        transcodeArgs.push(
          '-i',
          targetUrl,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          finalMp4
        );

        const transcodeProc = spawn(ffmpegBin, transcodeArgs);

        if (transcodeProc.pid) {
          task.subprocesses.push(transcodeProc.pid);
        }

        transcodeProc.on('close', async c => {
          if (c === 0 && fs.existsSync(finalMp4) && fs.statSync(finalMp4).size > 1000) {
            const validation = await validateMediaFile(finalMp4);
            if (validation.valid) {
              resolve({
                success: true,
                outputPath: finalMp4,
                engineName: this.name,
              });
              return;
            }
          }

          const errMsg = stderr || `FFmpeg failed with exit code ${code}`;
          logger.warn(`FFmpeg engine failed: ${errMsg.slice(-250)}`);
          resolve({
            success: false,
            engineName: this.name,
            error: errMsg.slice(0, 300),
            errorType: 'FFMPEG_ERROR',
          });
        });

        transcodeProc.on('error', err => {
          resolve({
            success: false,
            engineName: this.name,
            error: `FFmpeg transcode error: ${err.message}`,
            errorType: 'PROCESS_ERROR',
          });
        });
      });

      proc.on('error', err => {
        task.abortController.signal.removeEventListener('abort', abortHandler);
        resolve({
          success: false,
          engineName: this.name,
          error: `FFmpeg execution error: ${err.message}`,
          errorType: 'PROCESS_ERROR',
        });
      });
    });
  }
}
