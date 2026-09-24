import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { getFfmpegPath } from '../utils/system.ts';
import { validateMediaFile, remuxToTelegramMp4 } from '../utils/ffmpeg.ts';
import { buildFfmpegHeaders } from './ffmpeg-engine.ts';
import { isUrlExpired } from '../utils/signed-url.ts';
import { isM3u8Url } from '../utils/url-extractor.ts';
import { detectHlsEncryption } from '../utils/m3u8-parser.ts';
import { logger } from '../logger.ts';

export class RetryEngine extends BaseEngine {
  readonly name = 'Secondary Discovered Media Retry (Engine 6)';
  readonly priority = 6;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async download(
    task: DownloadTask,
    onProgress?: (statusText: string, percent?: number) => void
  ): Promise<EngineResult> {
    const candidates = [
      ...(task.discoveredMedia || []).map(m => m.streamUrl),
      task.streamUrl,
    ].filter(Boolean) as string[];

    const uniqueCandidates = Array.from(new Set(candidates))
      .filter(u => u !== task.originalUrl)
      .filter(u => {
        if (isUrlExpired(u)) {
          logger.info(`[Engine 6] Skipping expired signed URL candidate: ${u}`);
          return false;
        }
        return true;
      });

    if (uniqueCandidates.length === 0) {
      return {
        success: false,
        engineName: this.name,
        error: 'No discovered media resources available from previous engines to retry',
        errorType: 'NO_MEDIA_FOUND',
      };
    }

    onProgress?.(`🔄 Engine 6: Retrying with ${uniqueCandidates.length} discovered media candidate(s)...`, 40);
    logger.info(`[Engine 6] Starting retry on ${uniqueCandidates.length} candidate URLs for task ${task.id}`);

    const ffmpegBin = getFfmpegPath();
    const downloadDir = task.subDirs?.download || task.tempDir;

    for (let idx = 0; idx < uniqueCandidates.length; idx++) {
      const candidateUrl = uniqueCandidates[idx];
      const outputPath = path.join(downloadDir, `retry_output_${idx}_${Date.now()}.mp4`);

      onProgress?.(`🔄 Engine 6: Attempting discovered media candidate ${idx + 1}/${uniqueCandidates.length}...`, 45);

      try {
        const success = await new Promise<boolean>(resolve => {
          const args = [
            '-y',
            '-protocol_whitelist',
            'file,http,https,tcp,tls,crypto,data',
          ];

          // Contextual header propagation
          const headerStr = buildFfmpegHeaders(task.streamHeaders, task.cookies);
          if (headerStr) {
            args.push('-headers', headerStr);
          }

          args.push(
            '-i',
            candidateUrl,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            outputPath
          );

          const proc = spawn(ffmpegBin, args);
          if (proc.pid) {
            task.subprocesses.push(proc.pid);
          }

          const abortHandler = () => {
            try {
              proc.kill('SIGKILL');
            } catch {}
          };
          task.abortController.signal.addEventListener('abort', abortHandler, { once: true });

          proc.on('close', code => {
            task.abortController.signal.removeEventListener('abort', abortHandler);
            resolve(code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000);
          });

          proc.on('error', () => {
            task.abortController.signal.removeEventListener('abort', abortHandler);
            resolve(false);
          });
        });

        if (success && fs.existsSync(outputPath)) {
          const validation = await validateMediaFile(outputPath);
          if (validation.valid) {
            logger.info(`[Engine 6] Successfully recovered media using candidate: ${candidateUrl}`);
            return {
              success: true,
              outputPath,
              engineName: this.name,
              streamUrl: candidateUrl,
            };
          }
        }
      } catch (err: any) {
        logger.warn(`Candidate ${candidateUrl} failed in Engine 6: ${err.message}`);
      }
    }

    return {
      success: false,
      engineName: this.name,
      error: `All ${uniqueCandidates.length} discovered media retry candidates failed`,
      errorType: 'NO_MEDIA_FOUND',
    };
  }
}
