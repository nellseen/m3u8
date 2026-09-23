import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { getStreamlinkPath } from '../utils/system.ts';
import { remuxToTelegramMp4, validateMediaFile } from '../utils/ffmpeg.ts';
import { logger } from '../logger.ts';

export class StreamlinkEngine extends BaseEngine {
  readonly name = 'Streamlink (Engine 3)';
  readonly priority = 3;

  async isAvailable(): Promise<boolean> {
    try {
      const bin = getStreamlinkPath();
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
    const streamlinkBin = getStreamlinkPath();
    const downloadDir = task.subDirs?.download || task.tempDir;
    const rawOutput = path.join(downloadDir, `streamlink_raw_${Date.now()}.ts`);
    const finalMp4 = path.join(downloadDir, `streamlink_output_${Date.now()}.mp4`);

    onProgress?.('⬇️ Streamlink: Connecting to stream (prioritizing max 720p)...', 30);

    const args: string[] = [
      '--force',
      '--output',
      rawOutput,
      '--stream-segment-timeout',
      '15',
      '--stream-timeout',
      '30',
    ];

    // Contextual Header Propagation (Referer, User-Agent, Origin, Authorization, Cookie)
    if (task.streamHeaders) {
      const lowerHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(task.streamHeaders)) {
        lowerHeaders[k.toLowerCase()] = v;
      }

      if (lowerHeaders['referer']) {
        args.push('--http-header', `Referer=${lowerHeaders['referer']}`);
      }
      if (lowerHeaders['user-agent']) {
        args.push('--http-header', `User-Agent=${lowerHeaders['user-agent']}`);
      }
      if (lowerHeaders['origin']) {
        args.push('--http-header', `Origin=${lowerHeaders['origin']}`);
      }
      if (lowerHeaders['authorization']) {
        args.push('--http-header', `Authorization=${lowerHeaders['authorization']}`);
      }
      if (lowerHeaders['accept']) {
        args.push('--http-header', `Accept=${lowerHeaders['accept']}`);
      }
      if (lowerHeaders['accept-language']) {
        args.push('--http-header', `Accept-Language=${lowerHeaders['accept-language']}`);
      }
    }

    if (task.cookies) {
      args.push('--http-header', `Cookie=${task.cookies}`);
    }

    // Prioritize 720p, then lower resolutions, avoiding 1080p/4k unless fallback
    let streamTarget = targetUrl;
    if (targetUrl.includes('.m3u8') && !targetUrl.startsWith('hlsvariant://') && !targetUrl.startsWith('hls://')) {
      streamTarget = `hlsvariant://${targetUrl}`;
    }
    args.push(streamTarget, '720p,720p60,480p,360p,worst,best');

    return new Promise(resolve => {
      let stderr = '';
      let stdout = '';
      const proc = spawn(streamlinkBin, args);

      if (proc.pid) {
        task.subprocesses.push(proc.pid);
      }

      proc.stdout.on('data', data => {
        const text = data.toString();
        stdout += text;
        if (text.includes('[download]') || text.includes('Written')) {
          onProgress?.(`⬇️ Streamlink downloading stream...`, 50);
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

        if (code === 0 && fs.existsSync(rawOutput) && fs.statSync(rawOutput).size > 1000) {
          onProgress?.('⚙️ Remuxing Streamlink stream to Telegram MP4 format...', 80);
          await remuxToTelegramMp4(rawOutput, finalMp4);

          // Cleanup raw TS file
          try { fs.unlinkSync(rawOutput); } catch {}

          if (fs.existsSync(finalMp4)) {
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
        }

        const errMsg = stderr || stdout || `Process exited with code ${code}`;
        logger.warn(`Streamlink failed: ${errMsg.slice(-250)}`);

        let errorType: any = 'PROCESS_ERROR';
        if (errMsg.includes('No plugin can handle URL') || errMsg.includes('No playable streams found')) {
          errorType = 'NO_MEDIA_FOUND';
        } else if (errMsg.includes('403 Client Error')) {
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
          error: `Streamlink execution error: ${err.message}`,
          errorType: 'PROCESS_ERROR',
        });
      });
    });
  }
}
