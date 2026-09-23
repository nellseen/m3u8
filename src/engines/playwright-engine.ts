import fs from 'fs';
import path from 'path';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult, ExtractedMedia } from '../types.ts';
import {
  resolveChromiumExecutable,
  getChromiumLaunchArgs,
  isTermuxOrPRoot,
} from '../utils/system.ts';
import { isHlsContentType, isM3u8Url, normalizeMediaUrl } from '../utils/url-extractor.ts';
import { scanHtmlForM3u8AndMedia } from '../utils/m3u8-detector.ts';
import { extractHtmlMetadata } from '../utils/metadata.ts';
import { FfmpegEngine } from './ffmpeg-engine.ts';
import { YtdlpEngine } from './ytdlp-engine.ts';
import { StreamlinkEngine } from './streamlink-engine.ts';
import { logger } from '../logger.ts';

export class PlaywrightEngine extends BaseEngine {
  readonly name = 'Playwright + Chromium Discovery (Engine 2)';
  readonly priority = 2;

  async isAvailable(): Promise<boolean> {
    const candidate = await resolveChromiumExecutable();
    return candidate.verified;
  }

  async download(
    task: DownloadTask,
    onProgress?: (statusText: string, percent?: number) => void
  ): Promise<EngineResult> {
    const targetUrl = task.originalUrl;
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      const resolved = await resolveChromiumExecutable();
      if (!resolved.verified) {
        return {
          success: false,
          engineName: this.name,
          error: `Chromium binary not verified on host (${resolved.source}): ${resolved.error || 'unsupported'}`,
          errorType: 'PROCESS_ERROR',
        };
      }

      onProgress?.(`🧭 Launching Chromium (${resolved.source}) for deep network inspection...`, 25);

      const { isPRoot } = isTermuxOrPRoot();
      const launchArgs = getChromiumLaunchArgs(isPRoot, resolved.isSingleProcess);

      try {
        browser = await chromium.launch({
          executablePath: resolved.path || undefined,
          headless: true,
          args: launchArgs,
          timeout: 20000,
        });
      } catch (launchErr: any) {
        // If initial launch fails in PRoot/container, fallback retry with --single-process
        logger.warn(`Initial launch failed, retrying with --single-process: ${launchErr.message}`);
        const fallbackArgs = getChromiumLaunchArgs(isPRoot, true);
        browser = await chromium.launch({
          executablePath: resolved.path || undefined,
          headless: true,
          args: fallbackArgs,
          timeout: 20000,
        });
      }

      const userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

      context = await browser.newContext({
        userAgent,
        viewport: { width: 1280, height: 720 },
      });

      page = await context.newPage();

      let detectedStreamUrl = '';
      // Contextual headers obtained directly from source/session
      const detectedHeaders: Record<string, string> = {
        'user-agent': userAgent,
        referer: targetUrl,
      };

      try {
        const parsedTarget = new URL(targetUrl);
        detectedHeaders['origin'] = parsedTarget.origin;
      } catch {}

      const discoveredMedia: ExtractedMedia[] = [];

      const recordMedia = (
        rawUrl: string,
        reqHeaders?: Record<string, string>,
        mimeType?: string,
        isHlsHint?: boolean
      ) => {
        const norm = normalizeMediaUrl(rawUrl, targetUrl);
        if (!norm) return;

        const isHls = Boolean(isHlsHint || isM3u8Url(norm) || (mimeType && isHlsContentType(mimeType)));
        const isDash = norm.toLowerCase().includes('.mpd');

        // Extract and propagate contextual headers from request
        if (reqHeaders) {
          const lowerHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(reqHeaders)) {
            lowerHeaders[k.toLowerCase()] = v;
          }

          if (lowerHeaders['referer']) detectedHeaders['referer'] = lowerHeaders['referer'];
          if (lowerHeaders['origin']) detectedHeaders['origin'] = lowerHeaders['origin'];
          if (lowerHeaders['user-agent']) detectedHeaders['user-agent'] = lowerHeaders['user-agent'];
          if (lowerHeaders['authorization']) detectedHeaders['authorization'] = lowerHeaders['authorization'];
          if (lowerHeaders['accept']) detectedHeaders['accept'] = lowerHeaders['accept'];
          if (lowerHeaders['accept-language']) detectedHeaders['accept-language'] = lowerHeaders['accept-language'];
          if (lowerHeaders['cookie']) detectedHeaders['cookie'] = lowerHeaders['cookie'];

          // Sec-fetch headers if present in genuine request
          if (lowerHeaders['sec-fetch-dest']) detectedHeaders['sec-fetch-dest'] = lowerHeaders['sec-fetch-dest'];
          if (lowerHeaders['sec-fetch-mode']) detectedHeaders['sec-fetch-mode'] = lowerHeaders['sec-fetch-mode'];
          if (lowerHeaders['sec-fetch-site']) detectedHeaders['sec-fetch-site'] = lowerHeaders['sec-fetch-site'];
        }

        if (!discoveredMedia.some(m => m.streamUrl === norm)) {
          discoveredMedia.push({
            streamUrl: norm,
            headers: { ...detectedHeaders },
            isHls,
            isDash,
            mimeType,
          });
        }

        // Prioritize master/playlist M3U8 over other media
        if (
          !detectedStreamUrl ||
          (isHls && !isM3u8Url(detectedStreamUrl)) ||
          (norm.includes('master.m3u8') && !detectedStreamUrl.includes('master.m3u8'))
        ) {
          detectedStreamUrl = norm;
          logger.info(`[Playwright] Prioritized primary stream URL: ${detectedStreamUrl}`);
        }
      };

      // 1. Intercept network requests (XHR, fetch, media, manifest, playlist)
      page.on('request', request => {
        try {
          const reqUrl = request.url();
          const lower = reqUrl.toLowerCase();
          const resourceType = request.resourceType();
          const isHls = isM3u8Url(reqUrl);
          const isDash = lower.includes('.mpd');
          const isVideoFile =
            lower.includes('.mp4?') ||
            lower.endsWith('.mp4') ||
            lower.includes('.webm') ||
            lower.includes('.ts?') ||
            lower.endsWith('.ts');

          if (
            isHls ||
            isDash ||
            isVideoFile ||
            resourceType === 'media' ||
            (resourceType === 'fetch' && (lower.includes('playlist') || lower.includes('manifest') || lower.includes('stream'))) ||
            (resourceType === 'xhr' && (lower.includes('playlist') || lower.includes('manifest') || lower.includes('stream')))
          ) {
            logger.info(`[Playwright] Intercepted media request (${resourceType}): ${reqUrl}`);
            recordMedia(reqUrl, request.headers(), undefined, isHls);
          }
        } catch {
          // ignore error in handler
        }
      });

      // 2. Intercept network responses (by Content-Type MIME and URL)
      page.on('response', response => {
        try {
          const respUrl = response.url();
          const contentType = (response.headers()['content-type'] || '').toLowerCase();
          const isHlsMime = isHlsContentType(contentType);
          const isHlsFromUrl = isM3u8Url(respUrl);
          const isVideoMime =
            contentType.includes('video/') ||
            contentType.includes('application/mp4') ||
            contentType.includes('video/mp4') ||
            contentType.includes('video/webm');

          if (isHlsMime || isHlsFromUrl || isVideoMime) {
            logger.info(`[Playwright] Intercepted media response (${contentType || 'url-match'}): ${respUrl}`);
            const req = response.request();
            recordMedia(respUrl, req ? req.headers() : undefined, contentType, isHlsMime || isHlsFromUrl);
          }
        } catch {
          // Ignore header read issues
        }
      });

      // 3. Monitor network routes for media requests
      try {
        await page.route('**/*', async (route, request) => {
          const rUrl = request.url();
          if (isM3u8Url(rUrl)) {
            recordMedia(rUrl, request.headers(), undefined, true);
          }
          await route.continue().catch(() => {});
        });
      } catch {
        // Route registration optional
      }

      onProgress?.('🌐 Navigating page and executing client-side scripts...', 30);

      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (err: any) {
        logger.warn(`Playwright page.goto warning: ${err.message}`);
      }

      // Check for <video>, <source>, <link preload>, player objects in DOM
      try {
        const domMedia = await page.evaluate(() => {
          const urls: string[] = [];
          const posters: string[] = [];

          // 1. Video elements & posters
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
            if (v.src) urls.push(v.src);
            if (v.currentSrc) urls.push(v.currentSrc);
            if (v.poster) posters.push(v.poster);
            const sources = v.querySelectorAll('source');
            sources.forEach(s => {
              if (s.src) urls.push(s.src);
            });
            try {
              v.play().catch(() => {});
            } catch {}
          });

          // 2. Link preload/alternate
          const links = document.querySelectorAll('link[rel="preload"], link[rel="alternate"]');
          links.forEach(l => {
            const href = l.getAttribute('href');
            if (href) urls.push(href);
          });

          // 3. Elements with data attributes
          const dataElements = document.querySelectorAll('[data-file], [data-src], [data-hls], [data-source], [data-manifest], [data-stream]');
          dataElements.forEach(el => {
            const f = el.getAttribute('data-file') || el.getAttribute('data-src') || el.getAttribute('data-hls') || el.getAttribute('data-source') || el.getAttribute('data-manifest') || el.getAttribute('data-stream');
            if (f) urls.push(f);
          });

          return { urls, posters };
        });

        for (const u of domMedia.urls) {
          recordMedia(u);
        }

        if (domMedia.posters.length > 0 && (!task.metadata || !task.metadata.sourceThumbnail)) {
          if (!task.metadata) task.metadata = {};
          const normPoster = normalizeMediaUrl(domMedia.posters[0], targetUrl);
          if (normPoster) {
            task.metadata.sourceThumbnail = normPoster;
            if (!task.metadata.thumbnail) task.metadata.thumbnail = normPoster;
          }
        }
      } catch {
        // Ignore DOM evaluation errors
      }

      // Extract metadata & perform deep M3U8 scan from page content
      try {
        const pageHtml = await page.content();
        if (!task.metadata || !task.metadata.originalTitle) {
          task.metadata = await extractHtmlMetadata(pageHtml, targetUrl);
        }

        const deepScan = scanHtmlForM3u8AndMedia(pageHtml, targetUrl);
        if (deepScan.primaryM3u8 && !detectedStreamUrl) {
          recordMedia(deepScan.primaryM3u8, undefined, undefined, true);
        }
        for (const u of deepScan.foundUrls) {
          recordMedia(u, undefined, undefined, true);
        }
        if (deepScan.sourceThumbnail && (!task.metadata || !task.metadata.sourceThumbnail)) {
          if (!task.metadata) task.metadata = {};
          task.metadata.sourceThumbnail = deepScan.sourceThumbnail;
          if (!task.metadata.thumbnail) task.metadata.thumbnail = deepScan.sourceThumbnail;
        }
      } catch {
        // Ignore content read errors
      }

      // Extract cookies from session
      try {
        const cookies = await context.cookies();
        if (cookies && cookies.length > 0) {
          task.cookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          detectedHeaders['cookie'] = task.cookies;
        }
      } catch {
        // Ignore cookie read errors
      }

      // Wait briefly for network activity to capture delayed manifests
      const waitStart = Date.now();
      while (!detectedStreamUrl && Date.now() - waitStart < 5000) {
        if (task.abortController.signal.aborted) break;
        await new Promise(r => setTimeout(r, 400));
      }

      // Close browser resources immediately to free memory for downstream downloaders
      try {
        if (page) await page.close();
      } catch {}
      try {
        if (context) await context.close();
      } catch {}
      try {
        if (browser) await browser.close();
      } catch {}
      page = null;
      context = null;
      browser = null;

      // GENERIC FALLBACK: If M3U8 or video stream was intercepted, capture directly and download downstream
      if (detectedStreamUrl) {
        logger.info(`[Playwright] Successfully intercepted stream: ${detectedStreamUrl}`);
        task.streamUrl = detectedStreamUrl;
        task.streamHeaders = detectedHeaders;
        task.discoveredMedia = discoveredMedia;

        onProgress?.('🔎 Stream intercepted! Handing off to downstream downloader...', 38);

        // Downstream Step 1: FFmpeg Direct HLS remuxing with full propagated headers
        const ffmpegEngine = new FfmpegEngine();
        if (await ffmpegEngine.isAvailable()) {
          try {
            onProgress?.('⬇️ Intercepted M3U8! Downloading via FFmpeg HLS engine...', 42);
            const ffmpegResult = await ffmpegEngine.download(task, onProgress);
            if (ffmpegResult.success && ffmpegResult.outputPath) {
              return {
                success: true,
                outputPath: ffmpegResult.outputPath,
                engineName: this.name,
                details: {
                  interceptedUrl: detectedStreamUrl,
                  downloader: ffmpegEngine.name,
                },
              };
            }
          } catch (err: any) {
            logger.warn(`FFmpeg pass failed on intercepted stream: ${err.message}`);
          }
        }

        // Downstream Step 2: yt-dlp on intercepted stream
        const ytdlpEngine = new YtdlpEngine();
        if (await ytdlpEngine.isAvailable()) {
          try {
            onProgress?.('⬇️ Trying yt-dlp on intercepted M3U8 stream...', 55);
            const ytdlpResult = await ytdlpEngine.download(task, onProgress);
            if (ytdlpResult.success && ytdlpResult.outputPath) {
              return {
                success: true,
                outputPath: ytdlpResult.outputPath,
                engineName: this.name,
                details: {
                  interceptedUrl: detectedStreamUrl,
                  downloader: ytdlpEngine.name,
                },
              };
            }
          } catch (err: any) {
            logger.warn(`yt-dlp pass failed on intercepted stream: ${err.message}`);
          }
        }

        // Downstream Step 3: Streamlink on intercepted stream
        const streamlinkEngine = new StreamlinkEngine();
        if (await streamlinkEngine.isAvailable()) {
          try {
            onProgress?.('⬇️ Trying Streamlink on intercepted M3U8 stream...', 70);
            const slResult = await streamlinkEngine.download(task, onProgress);
            if (slResult.success && slResult.outputPath) {
              return {
                success: true,
                outputPath: slResult.outputPath,
                engineName: this.name,
                details: {
                  interceptedUrl: detectedStreamUrl,
                  downloader: streamlinkEngine.name,
                },
              };
            }
          } catch (err: any) {
            logger.warn(`Streamlink pass failed on intercepted stream: ${err.message}`);
          }
        }

        return {
          success: false,
          engineName: this.name,
          error: `Stream URL found (${detectedStreamUrl.slice(0, 60)}...) but downstream engines failed`,
          errorType: 'NO_M3U8_FOUND',
        };
      }

      return {
        success: false,
        engineName: this.name,
        error: 'No media request or dynamic M3U8 intercepted by Chromium',
        errorType: 'NO_MEDIA_FOUND',
      };
    } catch (err: any) {
      return {
        success: false,
        engineName: this.name,
        error: `Playwright interception error: ${err.message}`,
        errorType: 'PROCESS_ERROR',
      };
    } finally {
      try {
        if (page) await page.close();
      } catch {}
      try {
        if (context) await context.close();
      } catch {}
      try {
        if (browser) await browser.close();
      } catch {}
    }
  }
}
