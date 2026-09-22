import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { getStreamlinkPath } from '../utils/system.ts';
import { remuxToTelegramMp4 } from '../utils/ffmpeg.ts';
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
    const rawOutput = path.join(task.tempDir, `streamlink_raw_${Date.now()}.ts`);
    const finalMp4 = path.join(task.tempDir, `streamlink_output_${Date.now()}.mp4`);

    onProgress?.('⬇️ Streamlink: Connecting to stream...', 30);

    const args: string[] = [
      '--force',
      '--output',
      rawOutput,
      '--stream-segment-timeout',
      '15',
      '--stream-timeout',
      '30',
    ];

    // Add custom headers if captured by Playwright
    if (task.streamHeaders) {
      if (task.streamHeaders['referer']) {
        args.push('--http-header', `Referer=${task.streamHeaders['referer']}`);
      }
      if (task.streamHeaders['user-agent']) {
        args.push('--http-header', `User-Agent=${task.streamHeaders['user-agent']}`);
      }
    }

    args.push(targetUrl, 'best,worst');

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
          onProgress?.(`⬇️ Streamlink downloading...`, 50);
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
          onProgress?.('⚙️ Remuxing Streamlink stream with FFmpeg...', 85);
          try {
            await remuxToTelegramMp4(rawOutput, finalMp4);
            resolve({
              success: true,
              outputPath: finalMp4,
              engineName: this.name,
            });
          } catch (err: any) {
            resolve({
              success: false,
              engineName: this.name,
              error: `Streamlink remux failed: ${err.message}`,
            });
          }
        } else {
          const errMsg = stderr || stdout || `Process exited with code ${code}`;
          logger.warn(`Streamlink failed: ${errMsg.slice(-250)}`);
          resolve({
            success: false,
            engineName: this.name,
            error: errMsg.slice(0, 300),
          });
        }
      });

      proc.on('error', err => {
        task.abortController.signal.removeEventListener('abort', abortHandler);
        resolve({
          success: false,
          engineName: this.name,
          error: `Streamlink spawn error: ${err.message}`,
        });
      });
    });
  }
}
