import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { getYtdlpPath, getFfmpegPath } from '../utils/system.ts';
import { validateMediaFile, remuxToTelegramMp4 } from '../utils/ffmpeg.ts';
import { normalizeCookies } from '../utils/cookie-manager.ts';
import { ensureIndonesianTitle } from '../utils/translator.ts';
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
    const downloadDir = task.subDirs?.download || task.tempDir;
    const outputPattern = path.join(downloadDir, `ytdlp_raw_${Date.now()}.%(ext)s`);
    const finalMp4 = path.join(downloadDir, `ytdlp_final_${Date.now()}.mp4`);

    onProgress?.('⬇️ yt-dlp: Initializing stream extraction (prioritizing max 720p)...', 30);

    // Format selection prioritizing native <= 720p to conserve bandwidth, RAM & processing
    const formatSpec =
      'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/bestvideo[height<=720]+bestaudio/best[height<=720]/bv*+ba/b/best';

    const args: string[] = [
      '--no-playlist',
      '--no-warnings',
      '--write-info-json',
      '--ffmpeg-location',
      ffmpegBin,
      '-f',
      formatSpec,
      '--merge-output-format',
      'mp4',
      '--concurrent-fragments',
      '3',
      '--socket-timeout',
      '30',
      '-o',
      outputPattern,
    ];

    // Contextual Header Propagation
    if (task.streamHeaders) {
      const lowerHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(task.streamHeaders)) {
        lowerHeaders[k.toLowerCase()] = v;
      }

      if (lowerHeaders['referer']) {
        args.push('--referer', lowerHeaders['referer']);
      }
      if (lowerHeaders['user-agent']) {
        args.push('--user-agent', lowerHeaders['user-agent']);
      }

      // Propagate Origin, Authorization, Accept, Accept-Language, Sec-Fetch-* if genuine
      const passthroughKeys = [
        'origin',
        'authorization',
        'accept',
        'accept-language',
        'sec-fetch-dest',
        'sec-fetch-mode',
        'sec-fetch-site',
      ];

      for (const key of passthroughKeys) {
        if (lowerHeaders[key]) {
          const capitalizedKey = key
            .split('-')
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join('-');
          args.push('--add-header', `${capitalizedKey}:${lowerHeaders[key]}`);
        }
      }
    }

    const normCookies = normalizeCookies(task.cookies);
    if (normCookies) {
      args.push('--add-header', `Cookie:${normCookies}`);
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
        const match = line.match(
          /\[download\]\s+(\d+\.?\d*)%\s+of\s+(?:~?\s*)(\d+\.?\d*[KMGT]iB)\s+at\s+(\d+\.?\d*[KMGT]iB\/s)(?:\s+ETA\s+(\d+:\d+))?/
        );
        if (match && onProgress) {
          const percent = parseFloat(match[1]);
          const total = match[2];
          const speed = match[3];
          const eta = match[4] || '';
          onProgress(`⬇️ yt-dlp: ${percent}% of ${total} (${speed})${eta ? ` ETA: ${eta}` : ''}`, percent);
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

        if (code === 0) {
          // Find downloaded file
          const files = fs.readdirSync(downloadDir);
          const rawFile = files.find(
            f =>
              f.startsWith('ytdlp_raw_') &&
              !f.endsWith('.part') &&
              !f.endsWith('.ytdl') &&
              !f.endsWith('.json')
          );

          if (rawFile) {
            const rawPath = path.join(downloadDir, rawFile);
            onProgress?.('⚙️ Remuxing yt-dlp output to Telegram MP4 format...', 85);
            await remuxToTelegramMp4(rawPath, finalMp4);

            // Cleanup raw download
            try { fs.unlinkSync(rawPath); } catch {}

            // Parse yt-dlp info.json if generated
            const jsonFile = files.find(f => f.startsWith('ytdlp_raw_') && f.endsWith('.info.json'));
            if (jsonFile) {
              try {
                const jsonPath = path.join(downloadDir, jsonFile);
                const infoData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                if (!task.metadata) task.metadata = {};

                if (infoData.title && !task.metadata.originalTitle) {
                  task.metadata.originalTitle = String(infoData.title).trim();
                  const trans = await ensureIndonesianTitle(task.metadata.originalTitle);
                  task.metadata.translatedTitle = trans.translatedTitle;
                  task.metadata.detectedLanguage = trans.detectedLanguage;
                  task.metadata.translationStatus = trans.translationStatus;
                }
                if (infoData.thumbnail && !task.metadata.extractorThumbnail) {
                  task.metadata.extractorThumbnail = String(infoData.thumbnail);
                  if (!task.metadata.thumbnail) task.metadata.thumbnail = String(infoData.thumbnail);
                }
                if (infoData.duration && !task.metadata.duration) {
                  task.metadata.duration = Math.round(Number(infoData.duration));
                }
                try { fs.unlinkSync(jsonPath); } catch {}
              } catch {
                // Ignore info json parsing error
              }
            }

            resolve({
              success: true,
              outputPath: finalMp4,
              engineName: this.name,
            });
            return;
          }
        }

        const errMsg = stderr || stdout || `Process exited with code ${code}`;
        logger.warn(`yt-dlp failed: ${errMsg.slice(-250)}`);

        let errorType: any = 'PROCESS_ERROR';
        if (errMsg.includes('Unsupported URL') || errMsg.includes('no suitable extractor')) {
          errorType = 'EXTRACTOR_UNSUPPORTED';
        } else if (errMsg.includes('HTTP Error 403') || errMsg.includes('Forbidden')) {
          errorType = 'NETWORK_ERROR';
        }

        resolve({
          success: false,
          engineName: this.name,
          error: errMsg.slice(0, 300),
          errorType,
        });
      });

      proc.on('error', err => {
        task.abortController.signal.removeEventListener('abort', abortHandler);
        resolve({
          success: false,
          engineName: this.name,
          error: `yt-dlp execution error: ${err.message}`,
          errorType: 'PROCESS_ERROR',
        });
      });
    });
  }
}
