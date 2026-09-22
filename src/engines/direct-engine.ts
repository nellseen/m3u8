import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import * as cheerio from 'cheerio';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { analyzeUrl } from '../utils/url-extractor.ts';
import { remuxToTelegramMp4 } from '../utils/ffmpeg.ts';
import { formatBytes } from '../utils/system.ts';
import { logger } from '../logger.ts';

export class DirectEngine extends BaseEngine {
  readonly name = 'Direct / HLS Detection (Engine 1)';
  readonly priority = 1;

  async isAvailable(): Promise<boolean> {
    return true; // Always available via native fetch and cheerio
  }

  async download(
    task: DownloadTask,
    onProgress?: (statusText: string, percent?: number) => void
  ): Promise<EngineResult> {
    const targetUrl = task.streamUrl || task.originalUrl;
    const urlInfo = analyzeUrl(targetUrl);

    try {
      // 1. Direct HLS (.m3u8) check
      if (urlInfo.isDirectM3u8) {
        onProgress?.('🔎 Direct M3U8 detected, delegating to HLS pipeline...', 20);
        task.streamUrl = targetUrl;
        return {
          success: false,
          engineName: this.name,
          error: 'Direct M3U8 detected, transferring to FFmpeg/HLS engine for segment assembly',
        };
      }

      // 2. Direct Video File (.mp4, .mkv, .webm, etc.) check
      if (urlInfo.isDirectVideo) {
        onProgress?.('⬇️ Direct video stream detected, downloading...', 20);
        const rawFile = path.join(task.tempDir, `raw_direct_${Date.now()}.bin`);
        const finalMp4 = path.join(task.tempDir, `direct_output_${Date.now()}.mp4`);

        await this.downloadDirectStream(targetUrl, rawFile, onProgress, task.abortController.signal);

        onProgress?.('⚙️ Processing & remuxing for Telegram...', 80);
        await remuxToTelegramMp4(rawFile, finalMp4);

        if (fs.existsSync(finalMp4) && fs.statSync(finalMp4).size > 1000) {
          return {
            success: true,
            outputPath: finalMp4,
            engineName: this.name,
          };
        }
      }

      // 3. Web Page Inspection via Cheerio
      onProgress?.('🌐 Inspecting page HTML for media & HLS playlists...', 10);
      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,video/*,*/*;q=0.8',
        },
        signal: task.abortController.signal,
      });

      const contentType = res.headers.get('content-type') || '';
      if (
        contentType.includes('application/x-mpegurl') ||
        contentType.includes('vnd.apple.mpegurl') ||
        contentType.includes('application/vnd.apple.mpegurl')
      ) {
        task.streamUrl = targetUrl;
        return {
          success: false,
          engineName: this.name,
          error: 'Content-type indicates HLS stream, passing to FFmpeg HLS engine',
        };
      }

      if (contentType.includes('video/')) {
        onProgress?.('⬇️ Video response detected from URL...', 25);
        const rawFile = path.join(task.tempDir, `raw_stream_${Date.now()}.bin`);
        const finalMp4 = path.join(task.tempDir, `stream_output_${Date.now()}.mp4`);

        if (!res.body) {
          throw new Error('Response body was empty');
        }

        const fileStream = fs.createWriteStream(rawFile);
        await finished(Readable.fromWeb(res.body as any).pipe(fileStream));

        await remuxToTelegramMp4(rawFile, finalMp4);
        return {
          success: true,
          outputPath: finalMp4,
          engineName: this.name,
        };
      }

      // Parse HTML
      const html = await res.text();
      const $ = cheerio.load(html);

      // Look for video or source tags
      let detectedMediaUrl = '';
      $('video, source').each((_, el) => {
        const src = $(el).attr('src');
        if (src && (src.includes('.m3u8') || src.includes('.mp4') || src.includes('.webm'))) {
          detectedMediaUrl = new URL(src, targetUrl).href;
          return false;
        }
      });

      // Look for regex matches inside script tags
      if (!detectedMediaUrl) {
        const scriptContents = $('script').map((_, el) => $(el).html()).get().join('\n');
        const m3u8Match = scriptContents.match(/(https?:\/\/[^"'\\s\s]+\.m3u8[^"'\\s\s]*)/i);
        if (m3u8Match) {
          detectedMediaUrl = m3u8Match[1].replace(/\\/g, '');
        }
      }

      if (detectedMediaUrl) {
        logger.info(`Engine 1 extracted media URL: ${detectedMediaUrl}`);
        task.streamUrl = detectedMediaUrl;
        return {
          success: false,
          engineName: this.name,
          error: `Extracted media URL (${detectedMediaUrl.slice(0, 60)}...), proceeding to downloader engine`,
        };
      }

      return {
        success: false,
        engineName: this.name,
        error: 'No direct video stream or static M3U8 found in HTML tags',
      };
    } catch (err: any) {
      return {
        success: false,
        engineName: this.name,
        error: err.message || 'Direct inspection failed',
      };
    }
  }

  private async downloadDirectStream(
    url: string,
    destination: string,
    onProgress?: (statusText: string, percent?: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
    let downloadedBytes = 0;

    const fileStream = fs.createWriteStream(destination);
    const body = res.body;
    if (!body) {
      throw new Error('Response body was null');
    }

    const reader = body.getReader();
    let lastProgressUpdate = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        fileStream.write(Buffer.from(value));
        downloadedBytes += value.length;

        const now = Date.now();
        if (now - lastProgressUpdate > 1500 && onProgress) {
          lastProgressUpdate = now;
          let percent = 0;
          let text = `⬇️ Downloading: ${formatBytes(downloadedBytes)}`;
          if (totalBytes > 0) {
            percent = Math.floor((downloadedBytes / totalBytes) * 100);
            text += ` / ${formatBytes(totalBytes)} (${percent}%)`;
          }
          onProgress(text, percent);
        }
      }
    }

    fileStream.end();
  }
}
