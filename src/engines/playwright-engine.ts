import { chromium, Browser } from 'playwright';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult, ExtractedMedia } from '../types.ts';
import { getChromiumPath } from '../utils/system.ts';
import { extractHtmlMetadata } from '../utils/metadata.ts';
import { logger } from '../logger.ts';

export class PlaywrightEngine extends BaseEngine {
  readonly name = 'Playwright + Chromium Discovery (Engine 2)';
  readonly priority = 2;

  async isAvailable(): Promise<boolean> {
    try {
      const execPath = getChromiumPath();
      const browser = await chromium.launch({
        executablePath: execPath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
      await browser.close();
      return true;
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

    try {
      onProgress?.('🧭 Launching Chromium for deep network media interception...', 20);

      const execPath = getChromiumPath();
      browser = await chromium.launch({
        executablePath: execPath,
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
        ],
      });

      const userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

      const context = await browser.newContext({
        userAgent,
        viewport: { width: 1280, height: 720 },
      });

      const page = await context.newPage();

      let detectedStreamUrl = '';
      const detectedHeaders: Record<string, string> = {
        'user-agent': userAgent,
        referer: targetUrl,
      };
      const discoveredMedia: ExtractedMedia[] = [];

      // Intercept network requests & responses
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

      onProgress?.('🌐 Navigating page and executing client-side scripts...', 25);

      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (err: any) {
        logger.warn(`Playwright page.goto warning: ${err.message}`);
      }

      // Check for video element in DOM or triggers
      try {
        await page.evaluate(() => {
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
            try {
              v.play().catch(() => {});
            } catch {}
          });
        });
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
      // Browser must ALWAYS be closed on SUCCESS, FAILURE, TIMEOUT, or EXCEPTION
      if (browser) {
        try {
          await browser.close();
        } catch {
          // Ignore close error
        }
      }
    }
  }
}
