import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { getYtdlpPath, getFfmpegPath } from '../utils/system.ts';
import { remuxToTelegramMp4 } from '../utils/ffmpeg.ts';
import { logger } from '../logger.ts';

export class YtdlpEngine extends BaseEngine {
  readonly name = 'yt-dlp (Engine 4)';
  readonly priority = 4;

  async isAvailable(): Promise<boolean> {
    try {
      const bin = getYtdlpPath();
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
    const ytdlpBin = getYtdlpPath();
    const ffmpegBin = getFfmpegPath();
    const outputPattern = path.join(task.tempDir, `ytdlp_raw_${Date.now()}.%(ext)s`);
    const finalMp4 = path.join(task.tempDir, `ytdlp_final_${Date.now()}.mp4`);

    onProgress?.('⬇️ yt-dlp: Initializing stream extraction...', 30);

    const args: string[] = [
      '--no-playlist',
      '--no-warnings',
      '--ffmpeg-location',
      ffmpegBin,
      '-f',
      'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bestvideo+bestaudio/best',
      '--merge-output-format',
      'mp4',
      '--concurrent-fragments',
      '3',
      '--socket-timeout',
      '30',
      '-o',
      outputPattern,
    ];

    if (task.streamHeaders) {
      if (task.streamHeaders['referer']) {
        args.push('--referer', task.streamHeaders['referer']);
      }
      if (task.streamHeaders['user-agent']) {
        args.push('--user-agent', task.streamHeaders['user-agent']);
      }
    }

    args.push(targetUrl);

    return new Promise(resolve => {
      let stderr = '';
      let stdout = '';
      const proc = spawn(ytdlpBin, args);

      if (proc.pid) {
        task.subprocesses.push(proc.pid);
      }

      proc.stdout.on('data', data => {
        const line = data.toString();
        stdout += line;

        // Parse progress line: [download]  45.2% of ~ 24.12MiB at  2.41MiB/s ETA 00:05
        const match = line.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+(?:~?\s*)(\d+\.?\d*[KMGT]iB)\s+at\s+(\d+\.?\d*[KMGT]iB\/s)(?:\s+ETA\s+(\d+:\d+))?/);
        if (match && onProgress) {
          const percent = parseFloat(match[1]);
          const size = match[2];
          const speed = match[3];
          const eta = match[4] || '';
          onProgress(`⬇️ yt-dlp: ${percent.toFixed(1)}% of ${size} (${speed}${eta ? ` ETA ${eta}` : ''})`, percent);
        } else if (line.includes('[Merger]') || line.includes('[ffmpeg]')) {
          onProgress?.('⚙️ Merging audio and video streams...', 90);
        }
      });

      proc.stderr.on('data', data => {
        stderr += data.toString();
      });

      const abortHandler = () => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      };

      task.abortController.signal.addEventListener('abort', abortHandler, { once: true });

      proc.on('close', async code => {
        task.abortController.signal.removeEventListener('abort', abortHandler);

        // Find created file in temp dir
        const files = fs.readdirSync(task.tempDir);
        const downloadedFile = files.find(f => f.startsWith('ytdlp_raw_') && !f.endsWith('.part') && !f.endsWith('.ytdl'));

        if (code === 0 && downloadedFile) {
          const fullRawPath = path.join(task.tempDir, downloadedFile);
          if (fs.statSync(fullRawPath).size > 1000) {
            onProgress?.('⚙️ Remuxing faststart MP4 for Telegram streaming...', 95);
            try {
              await remuxToTelegramMp4(fullRawPath, finalMp4);
              resolve({
                success: true,
                outputPath: finalMp4,
                engineName: this.name,
              });
              return;
            } catch (err: any) {
              // If remux failed, raw mp4 file can still be used if it's already mp4
              if (downloadedFile.endsWith('.mp4')) {
                resolve({
                  success: true,
                  outputPath: fullRawPath,
                  engineName: this.name,
                });
                return;
              }
            }
          }
        }

        const errMsg = stderr || stdout || `Process exited with code ${code}`;
        logger.warn(`yt-dlp failed: ${errMsg.slice(-250)}`);
        resolve({
          success: false,
          engineName: this.name,
          error: errMsg.slice(0, 300),
        });
      });

      proc.on('error', err => {
        task.abortController.signal.removeEventListener('abort', abortHandler);
        resolve({
          success: false,
          engineName: this.name,
          error: `yt-dlp execution error: ${err.message}`,
        });
      });
    });
  }
}
