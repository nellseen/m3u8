import { chromium, Browser } from 'playwright';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { getChromiumPath } from '../utils/system.ts';
import { logger } from '../logger.ts';

export class PlaywrightEngine extends BaseEngine {
  readonly name = 'Playwright + Chromium Sniffer (Engine 2)';
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
      onProgress?.('🌐 Launching headless Chromium to intercept network media...', 20);

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

      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
      });

      const page = await context.newPage();

      let detectedStreamUrl = '';
      const detectedHeaders: Record<string, string> = {};

      // Intercept network requests
      page.on('request', request => {
        const reqUrl = request.url();
        const lower = reqUrl.toLowerCase();

        if (
          lower.includes('.m3u8') ||
          lower.includes('/playlist') ||
          lower.includes('/master') ||
          lower.includes('.mpd') ||
          request.resourceType() === 'media'
        ) {
          if (!detectedStreamUrl && !lower.includes('analytics') && !lower.includes('tracking')) {
            detectedStreamUrl = reqUrl;
            Object.assign(detectedHeaders, request.headers());
            logger.info(`Playwright intercepted stream URL: ${reqUrl}`);
          }
        }
      });

      // Intercept network responses for content-type
      page.on('response', response => {
        try {
          const respUrl = response.url();
          const contentType = response.headers()['content-type'] || '';
          if (
            contentType.includes('application/x-mpegurl') ||
            contentType.includes('vnd.apple.mpegurl') ||
            contentType.includes('application/vnd.apple.mpegurl') ||
            contentType.includes('video/mp4') ||
            contentType.includes('video/webm')
          ) {
            if (!detectedStreamUrl) {
              detectedStreamUrl = respUrl;
              logger.info(`Playwright detected media response (${contentType}): ${respUrl}`);
            }
          }
        } catch {
          // Ignore header parsing errors
        }
      });

      onProgress?.('🔎 Navigating to page & intercepting media requests...', 35);
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Attempt to trigger playback if video element exists
      try {
        await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v) {
            v.play().catch(() => {});
          }
        });
      } catch {
        // Ignore autoplay evaluation errors
      }

      // Wait up to 6 seconds for dynamic requests to fire
      const startTime = Date.now();
      while (!detectedStreamUrl && Date.now() - startTime < 6000) {
        if (task.abortController.signal.aborted) break;
        await new Promise(r => setTimeout(r, 500));
      }

      await browser.close();
      browser = null;

      if (detectedStreamUrl) {
        task.streamUrl = detectedStreamUrl;
        task.streamHeaders = detectedHeaders;
        return {
          success: false,
          engineName: this.name,
          error: `Media intercepted (${detectedStreamUrl.slice(0, 60)}...), passing to downstream engine`,
          details: { streamUrl: detectedStreamUrl },
        };
      }

      return {
        success: false,
        engineName: this.name,
        error: 'No HLS or video stream intercepted during Chromium session',
      };
    } catch (err: any) {
      if (browser) {
        try {
          await browser.close();
        } catch {
          // Ignore close error
        }
      }
      return {
        success: false,
        engineName: this.name,
        error: `Playwright interception failed: ${err.message}`,
      };
    }
  }
}
