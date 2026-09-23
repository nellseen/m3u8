import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { analyzeUrl, isHlsContentType, normalizeMediaUrl } from '../utils/url-extractor.ts';
import { scanHtmlForM3u8AndMedia } from '../utils/m3u8-detector.ts';
import { normalizeCookies, mergeCookieStrings } from '../utils/cookie-manager.ts';
import { remuxToTelegramMp4 } from '../utils/ffmpeg.ts';
import { formatBytes } from '../utils/system.ts';
import { extractHtmlMetadata } from '../utils/metadata.ts';
import { logger } from '../logger.ts';

export class DirectEngine extends BaseEngine {
  readonly name = 'Direct / HLS Detection (Engine 1)';
  readonly priority = 1;

  async isAvailable(): Promise<boolean> {
    return true; // Native fetch and parser
  }

  async download(
    task: DownloadTask,
    onProgress?: (statusText: string, percent?: number) => void
  ): Promise<EngineResult> {
    const targetUrl = task.streamUrl || task.originalUrl;
    const urlInfo = analyzeUrl(targetUrl);
    const downloadDir = task.subDirs?.download || task.tempDir;

    try {
      // 1. Direct HLS (.m3u8, .m3u, query, hash, manifest, master) check
      if (urlInfo.isDirectM3u8) {
        onProgress?.('🔎 Direct M3U8 detected, delegating to HLS pipeline...', 20);
        task.streamUrl = targetUrl;
        return {
          success: false,
          engineName: this.name,
          error: 'Direct M3U8 detected, transferring to FFmpeg/HLS engine for segment assembly',
          errorType: 'NO_M3U8_FOUND',
        };
      }

      // 2. Direct Video File (.mp4, .mkv, .webm, etc.) check
      if (urlInfo.isDirectVideo) {
        onProgress?.('⬇️ Direct video stream detected, downloading...', 20);
        const rawFile = path.join(downloadDir, `raw_direct_${Date.now()}.bin`);
        const finalMp4 = path.join(downloadDir, `direct_output_${Date.now()}.mp4`);

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

      // 3. Web Page Inspection via Deep HTTP & HTML Analysis
      onProgress?.('🌐 Inspecting page HTTP response & deep HTML for M3U8 playlists...', 10);
      
      const timeoutController = new AbortController();
      const fetchTimer = setTimeout(() => timeoutController.abort(), 15000);

      const abortHandler = () => timeoutController.abort();
      task.abortController.signal.addEventListener('abort', abortHandler, { once: true });

      const requestHeaders: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,application/vnd.apple.mpegurl,application/x-mpegURL,application/mpegurl,video/*,*/*;q=0.8',
        Referer: targetUrl,
      };

      try {
        requestHeaders['Origin'] = new URL(targetUrl).origin;
      } catch {}

      let res: globalThis.Response;
      try {
        res = await fetch(targetUrl, {
          headers: requestHeaders,
          signal: timeoutController.signal,
        });
      } finally {
        clearTimeout(fetchTimer);
        task.abortController.signal.removeEventListener('abort', abortHandler);
      }

      // Capture Set-Cookie if any returned
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const normalized = normalizeCookies(setCookie);
        task.cookies = mergeCookieStrings(task.cookies, normalized);
      }

      // Check HTTP Response Content-Type:
      // application/vnd.apple.mpegurl, application/x-mpegURL, application/mpegurl
      const contentType = res.headers.get('content-type') || '';
      if (isHlsContentType(contentType)) {
        logger.info(`Engine 1: HTTP Content-Type indicates HLS stream (${contentType}) at ${targetUrl}`);
        task.streamUrl = targetUrl;
        task.streamHeaders = {
          'user-agent': requestHeaders['User-Agent'],
          referer: targetUrl,
          origin: requestHeaders['Origin'],
        };
        return {
          success: false,
          engineName: this.name,
          error: `Content-type (${contentType}) indicates HLS stream, passing to FFmpeg HLS engine`,
          errorType: 'NO_M3U8_FOUND',
        };
      }

      if (contentType.includes('video/')) {
        onProgress?.('⬇️ Video response detected from URL...', 25);
        const rawFile = path.join(downloadDir, `raw_stream_${Date.now()}.bin`);
        const finalMp4 = path.join(downloadDir, `stream_output_${Date.now()}.mp4`);

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

      // Check if raw response text is actually an M3U8 playlist (e.g. starts with #EXTM3U)
      if (html.trim().startsWith('#EXTM3U')) {
        logger.info(`Engine 1: URL returned raw M3U8 playlist content: ${targetUrl}`);
        task.streamUrl = targetUrl;
        task.streamHeaders = {
          'user-agent': requestHeaders['User-Agent'],
          referer: targetUrl,
          origin: requestHeaders['Origin'],
        };
        return {
          success: false,
          engineName: this.name,
          error: 'Response body is raw M3U8 playlist, proceeding to HLS engine',
          errorType: 'NO_M3U8_FOUND',
        };
      }

      // Extract metadata with strict thumbnail priorities
      if (!task.metadata || !task.metadata.originalTitle) {
        task.metadata = await extractHtmlMetadata(html, targetUrl);
      }

      // Deep M3U8 scan: <source>, <video>, <link preload>, data attributes, embedded JSON, JS variables, player configs
      const scanResult = scanHtmlForM3u8AndMedia(html, targetUrl);
      if (scanResult.primaryM3u8) {
        logger.info(`Engine 1 deep scan discovered M3U8: ${scanResult.primaryM3u8}`);
        task.streamUrl = scanResult.primaryM3u8;
        task.streamHeaders = {
          'user-agent': requestHeaders['User-Agent'],
          referer: targetUrl,
          origin: requestHeaders['Origin'],
        };

        if (!task.discoveredMedia) {
          task.discoveredMedia = [];
        }
        for (const u of scanResult.foundUrls) {
          task.discoveredMedia.push({
            streamUrl: u,
            isHls: true,
            headers: { ...task.streamHeaders },
          });
        }

        if (scanResult.sourceThumbnail && (!task.metadata || !task.metadata.sourceThumbnail)) {
          if (!task.metadata) task.metadata = {};
          task.metadata.sourceThumbnail = scanResult.sourceThumbnail;
          if (!task.metadata.thumbnail) task.metadata.thumbnail = scanResult.sourceThumbnail;
        }

        return {
          success: false,
          engineName: this.name,
          error: `Extracted M3U8 URL (${scanResult.primaryM3u8.slice(0, 60)}...), proceeding to downstream engines`,
          errorType: 'NO_M3U8_FOUND',
        };
      }

      return {
        success: false,
        engineName: this.name,
        error: 'No direct video stream or static M3U8 found in HTML tags/scripts',
        errorType: 'NO_MEDIA_FOUND',
      };
    } catch (err: any) {
      const isTimeout = err.name === 'AbortError' || String(err).includes('abort');
      return {
        success: false,
        engineName: this.name,
        error: err.message || 'Direct inspection failed',
        errorType: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
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
