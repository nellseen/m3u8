import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult, ExtractedMedia } from '../types.ts';
import {
  resolveChromiumExecutable,
  getChromiumLaunchArgs,
  isTermuxOrPRoot,
} from '../utils/system.ts';
import { extractHtmlMetadata } from '../utils/metadata.ts';
import { logger } from '../logger.ts';

export class PlaywrightEngine extends BaseEngine {
  readonly name = 'Playwright + Chromium Discovery (Engine 2)';
  readonly priority = 2;

  async isAvailable(): Promise<boolean> {
    try {
      const resolved = await resolveChromiumExecutable();
      return Boolean(resolved.verified);
    } catch {
      return false;
    }
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
      onProgress?.('🧭 Resolving & testing Chromium for media interception...', 20);

      // 1. Resolve and verify working Chromium
      const resolved = await resolveChromiumExecutable();
      if (!resolved.verified) {
        logger.warn(`Playwright engine cannot run: ${resolved.error || 'Chromium launch test failed'}`);
        return {
          success: false,
          engineName: this.name,
          error: `Chromium is not operational on this system: ${resolved.error}`,
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
      const detectedHeaders: Record<string, string> = {
        'user-agent': userAgent,
        referer: targetUrl,
      };
      const discoveredMedia: ExtractedMedia[] = [];

      // Intercept network requests (HLS, DASH, MP4)
      page.on('request', request => {
        const reqUrl = request.url();
        const lower = reqUrl.toLowerCase();
        const isHls =
          lower.includes('.m3u8') ||
          lower.includes('master.m3u8') ||
          lower.includes('playlist.m3u8') ||
          lower.includes('index.m3u8');
        const isDash = lower.includes('.mpd');
        const isVideoFile = lower.includes('.mp4?') || lower.endsWith('.mp4');

        if (isHls || isDash || isVideoFile) {
          logger.info(`[Playwright] Intercepted media request: ${reqUrl}`);
          const headers = request.headers();
          if (headers['referer']) detectedHeaders['referer'] = headers['referer'];
          if (headers['user-agent']) detectedHeaders['user-agent'] = headers['user-agent'];
          if (headers['authorization']) detectedHeaders['authorization'] = headers['authorization'];

          discoveredMedia.push({
            streamUrl: reqUrl,
            headers: { ...detectedHeaders },
            isHls,
            isDash,
          });

          if (!detectedStreamUrl) {
            detectedStreamUrl = reqUrl;
          }
        }
      });

      // Intercept network responses (by content-type)
      page.on('response', response => {
        try {
          const respUrl = response.url();
          const contentType = (response.headers()['content-type'] || '').toLowerCase();
          const isHlsMime =
            contentType.includes('application/x-mpegurl') ||
            contentType.includes('application/vnd.apple.mpegurl') ||
            contentType.includes('vnd.apple.mpegurl');
          const isVideoMime = contentType.includes('video/');

          if (isHlsMime || isVideoMime) {
            logger.info(`[Playwright] Intercepted media response (${contentType}): ${respUrl}`);
            discoveredMedia.push({
              streamUrl: respUrl,
              headers: { ...detectedHeaders },
              isHls: isHlsMime,
              mimeType: contentType,
            });

            if (!detectedStreamUrl) {
              detectedStreamUrl = respUrl;
            }
          }
        } catch {
          // Ignore header read issues
        }
      });

      onProgress?.('🌐 Navigating page and executing client-side scripts...', 30);

      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (err: any) {
        logger.warn(`Playwright page.goto warning: ${err.message}`);
      }

      // Check for <video> and <source> elements in DOM
      try {
        const domMediaUrls = await page.evaluate(() => {
          const urls: string[] = [];
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
            if (v.src) urls.push(v.src);
            const sources = v.querySelectorAll('source');
            sources.forEach(s => {
              if (s.src) urls.push(s.src);
            });
            try {
              v.play().catch(() => {});
            } catch {}
          });
          return urls;
        });

        for (const u of domMediaUrls) {
          if (u && !discoveredMedia.some(m => m.streamUrl === u)) {
            discoveredMedia.push({
              streamUrl: u,
              headers: { ...detectedHeaders },
              isHls: u.includes('.m3u8'),
            });
            if (!detectedStreamUrl) {
              detectedStreamUrl = u;
            }
          }
        }
      } catch {
        // Ignore DOM evaluation errors
      }

      // Extract metadata from page content
      try {
        const pageHtml = await page.content();
        if (!task.metadata || !task.metadata.originalTitle) {
          task.metadata = await extractHtmlMetadata(pageHtml, targetUrl);
        }
      } catch {
        // Ignore content read errors
      }

      // Extract cookies
      try {
        const cookies = await context.cookies();
        if (cookies && cookies.length > 0) {
          task.cookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
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

      if (detectedStreamUrl) {
        task.streamUrl = detectedStreamUrl;
        task.streamHeaders = detectedHeaders;
        task.discoveredMedia = discoveredMedia;

        return {
          success: false,
          engineName: this.name,
          error: `Media intercepted (${detectedStreamUrl.slice(0, 60)}...), passing to downstream engine`,
          details: { streamUrl: detectedStreamUrl, discoveredMediaCount: discoveredMedia.length },
        };
      }

      return {
        success: false,
        engineName: this.name,
        error: 'No HLS or media stream intercepted during Chromium session',
        errorType: 'NO_MEDIA_FOUND',
      };
    } catch (err: any) {
      return {
        success: false,
        engineName: this.name,
        error: `Playwright interception failed: ${err.message}`,
        errorType: 'PROCESS_ERROR',
      };
    } finally {
      // Browser must ALWAYS be closed
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
