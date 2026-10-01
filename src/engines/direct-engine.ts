import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { analyzeUrl, isHlsContentType, normalizeMediaUrl } from '../utils/url-extractor.ts';
import { scanHtmlForM3u8AndMedia } from '../utils/m3u8-detector.ts';
import { discoverMediaFromPage } from '../utils/media-discovery.ts';
import { normalizeCookies, mergeCookieStrings } from '../utils/cookie-manager.ts';
import { remuxToTelegramMp4 } from '../utils/ffmpeg.ts';
import { formatBytes } from '../utils/system.ts';
import { extractHtmlMetadata } from '../utils/metadata.ts';
import { isSignedUrl, isUrlExpired } from '../utils/signed-url.ts';
import { detectHlsEncryption } from '../utils/m3u8-parser.ts';
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
        task.discoveredAt = Date.now();
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

      // 3. Universal Web Page Discovery via Deep HTML, Scripts, Player Configs & Iframes
      onProgress?.('🌐 Scanning web page for embedded media & player configs...', 10);
      
      const discovery = await discoverMediaFromPage(targetUrl, {
        headers: task.streamHeaders,
        cookies: task.cookies,
        onProgress: (text, pct) => onProgress?.(text, pct),
      });

      // Forward session headers and cookies
      if (discovery.sessionHeaders) {
        task.streamHeaders = { ...task.streamHeaders, ...discovery.sessionHeaders };
      }
      if (discovery.cookies) {
        task.cookies = mergeCookieStrings(task.cookies, discovery.cookies);
      }
      if (discovery.sourceThumbnail && (!task.metadata || !task.metadata.sourceThumbnail)) {
        if (!task.metadata) task.metadata = {};
        task.metadata.sourceThumbnail = discovery.sourceThumbnail;
        if (!task.metadata.thumbnail) task.metadata.thumbnail = discovery.sourceThumbnail;
      }

      // If direct playable video was resolved (e.g. MP4)
      if (discovery.mediaType === 'DIRECT_VIDEO' && discovery.selectedMediaUrl) {
        onProgress?.('⬇️ Direct video stream detected, downloading...', 25);
        const rawFile = path.join(downloadDir, `raw_direct_${Date.now()}.bin`);
        const finalMp4 = path.join(downloadDir, `direct_output_${Date.now()}.mp4`);

        await this.downloadDirectStream(discovery.selectedMediaUrl, rawFile, onProgress, task.abortController.signal);
        await remuxToTelegramMp4(rawFile, finalMp4);

        if (fs.existsSync(finalMp4) && fs.statSync(finalMp4).size > 1000) {
          return {
            success: true,
            outputPath: finalMp4,
            engineName: this.name,
          };
        }
      }

      // If HLS Master or Media playlist was discovered
      if (discovery.selectedMediaUrl && (discovery.mediaType === 'HLS_MASTER' || discovery.mediaType === 'HLS_MEDIA')) {
        logger.info(`[DirectEngine] Discovered HLS stream: ${discovery.selectedMediaUrl}`);
        task.streamUrl = discovery.selectedMediaUrl;
        task.discoveredAt = Date.now();
        if (discovery.selectedVariant) {
          task.selectedVariant = discovery.selectedVariant;
        }

        if (!task.discoveredMedia) {
          task.discoveredMedia = [];
        }
        for (const c of discovery.candidates) {
          task.discoveredMedia.push({
            streamUrl: c.url,
            isHls: c.mediaType === 'HLS_MASTER' || c.mediaType === 'HLS_MEDIA',
            headers: { ...task.streamHeaders },
            discoveredAt: Date.now(),
            isSigned: isSignedUrl(c.url),
          });
        }

        return {
          success: false,
          engineName: this.name,
          error: `Discovered HLS media (${discovery.selectedMediaUrl.slice(0, 60)}...), proceeding to downstream engines`,
          errorType: 'NO_M3U8_FOUND',
        };
      }

      return {
        success: false,
        engineName: this.name,
        error: 'No media discovered in static HTML/JS/iframes, proceeding to Playwright browser network discovery',
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
