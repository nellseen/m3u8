import * as cheerio from 'cheerio';
import { isM3u8Url, normalizeMediaUrl } from './url-extractor.ts';
import { logger } from '../logger.ts';

export interface DeepM3u8ScanResult {
  foundUrls: string[];
  primaryM3u8?: string;
  sourceThumbnail?: string;
  playerConfigs: Array<Record<string, unknown>>;
}

/**
 * Recursively inspects JavaScript/JSON objects for m3u8 URLs and poster/thumbnails
 */
function scanObjectForMedia(
  obj: unknown,
  baseUrl: string,
  urls: Set<string>,
  thumbnails: Set<string>,
  depth = 0
): void {
  if (!obj || depth > 8) return;

  if (typeof obj === 'string') {
    const trimmed = obj.trim().replace(/\\/g, '');
    if (isM3u8Url(trimmed)) {
      const abs = normalizeMediaUrl(trimmed, baseUrl);
      if (abs) urls.add(abs);
    }
    // Also look for thumbnail/poster hints
    if (
      (trimmed.endsWith('.jpg') || trimmed.endsWith('.jpeg') || trimmed.endsWith('.png') || trimmed.endsWith('.webp'))
    ) {
      const absThumb = normalizeMediaUrl(trimmed, baseUrl);
      if (absThumb) thumbnails.add(absThumb);
    }
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      scanObjectForMedia(item, baseUrl, urls, thumbnails, depth + 1);
    }
    return;
  }

  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      // Look for media keys: file, src, source, hls, m3u8, manifest, playlist, stream, video
      if (
        typeof value === 'string' &&
        (lowerKey.includes('file') ||
          lowerKey.includes('src') ||
          lowerKey.includes('source') ||
          lowerKey.includes('hls') ||
          lowerKey.includes('m3u8') ||
          lowerKey.includes('manifest') ||
          lowerKey.includes('playlist') ||
          lowerKey.includes('stream') ||
          lowerKey.includes('video') ||
          lowerKey.includes('url'))
      ) {
        if (isM3u8Url(value)) {
          const abs = normalizeMediaUrl(value, baseUrl);
          if (abs) urls.add(abs);
        }
      }

      // Look for thumbnail / poster keys
      if (
        typeof value === 'string' &&
        (lowerKey.includes('poster') ||
          lowerKey.includes('thumbnail') ||
          lowerKey.includes('image') ||
          lowerKey.includes('preview'))
      ) {
        const abs = normalizeMediaUrl(value, baseUrl);
        if (abs) thumbnails.add(abs);
      }

      scanObjectForMedia(value, baseUrl, urls, thumbnails, depth + 1);
    }
  }
}

/**
 * Comprehensive scanner for HTML documents to detect M3U8 from:
 * - <source src="..." type="...">
 * - <video src="..." poster="..." data-src="..." data-url="...">
 * - <link rel="preload" href="..." as="...">
 * - Data attributes on container tags (data-stream, data-source, data-hls, data-manifest, data-file)
 * - Embedded JSON (<script type="application/json">, ld+json, __NEXT_DATA__, __NUXT_DATA__)
 * - Player configuration scripts (JW Player, Video.js, Plyr, Clappr, Hls.js, DPlayer, Artplayer, Fluid Player)
 * - Inline JavaScript variables (file, source, src, hls, manifest, streamUrl)
 */
export function scanHtmlForM3u8AndMedia(html: string, pageUrl: string): DeepM3u8ScanResult {
  const urls = new Set<string>();
  const thumbnails = new Set<string>();
  const playerConfigs: Array<Record<string, unknown>> = [];

  try {
    const $ = cheerio.load(html);

    // 1. Inspect <source> tags
    $('source').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-url');
      const type = $(el).attr('type') || '';
      if (src) {
        if (
          isM3u8Url(src) ||
          type.includes('mpegurl') ||
          type.includes('apple.mpegurl')
        ) {
          const abs = normalizeMediaUrl(src, pageUrl);
          if (abs) urls.add(abs);
        }
      }
    });

    // 2. Inspect <video> tags and their data attributes
    $('video').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-url');
      const poster = $(el).attr('poster') || $(el).attr('data-poster') || $(el).attr('data-image');
      if (src && isM3u8Url(src)) {
        const abs = normalizeMediaUrl(src, pageUrl);
        if (abs) urls.add(abs);
      }
      if (poster) {
        const abs = normalizeMediaUrl(poster, pageUrl);
        if (abs) thumbnails.add(abs);
      }
    });

    // 3. Inspect data attributes across any element (e.g. div.player[data-file], div[data-hls-url])
    $('[data-file], [data-src], [data-hls], [data-source], [data-manifest], [data-stream], [data-stream-url], [data-video-url], [data-config]').each((_, el) => {
      const attrs = [
        $(el).attr('data-file'),
        $(el).attr('data-src'),
        $(el).attr('data-hls'),
        $(el).attr('data-source'),
        $(el).attr('data-manifest'),
        $(el).attr('data-stream'),
        $(el).attr('data-stream-url'),
        $(el).attr('data-video-url'),
      ];

      for (const attr of attrs) {
        if (attr && isM3u8Url(attr)) {
          const abs = normalizeMediaUrl(attr, pageUrl);
          if (abs) urls.add(abs);
        }
      }

      // Check for JSON embedded in data-config or data-setup
      const dataConfig = $(el).attr('data-config') || $(el).attr('data-setup');
      if (dataConfig) {
        try {
          const parsed = JSON.parse(dataConfig);
          scanObjectForMedia(parsed, pageUrl, urls, thumbnails);
        } catch {
          // not json
        }
      }
    });

    // 4. Inspect <link rel="preload"> or <link rel="alternate">
    $('link[rel="preload"], link[rel="alternate"]').each((_, el) => {
      const href = $(el).attr('href');
      const type = $(el).attr('type') || '';
      if (href && (isM3u8Url(href) || type.includes('mpegurl'))) {
        const abs = normalizeMediaUrl(href, pageUrl);
        if (abs) urls.add(abs);
      }
    });

    // 5. Inspect embedded JSON scripts (e.g. Next.js __NEXT_DATA__, Nuxt, LD+JSON, Player Configs)
    $('script').each((_, el) => {
      const type = ($(el).attr('type') || '').toLowerCase();
      const id = ($(el).attr('id') || '').toLowerCase();
      const content = $(el).html() || '';
      if (!content.trim()) return;

      if (type.includes('json') || id.includes('json') || id.includes('next') || id.includes('nuxt')) {
        try {
          const parsed = JSON.parse(content);
          playerConfigs.push(parsed);
          scanObjectForMedia(parsed, pageUrl, urls, thumbnails);
        } catch {
          // not valid JSON
        }
      }
    });

    // 6. Inspect inline JavaScript code for player configs & m3u8 declarations
    const scriptContents = $('script').map((_, el) => $(el).html() || '').get().join('\n');

    // 6a. Regex for direct m3u8 / m3u patterns in JS
    const m3u8Regex = /["'](https?:\\?\/\\?\/[^"'\\s\s]+\.(?:m3u8|m3u)[^"'\\s\s]*)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = m3u8Regex.exec(scriptContents)) !== null) {
      const abs = normalizeMediaUrl(match[1], pageUrl);
      if (abs) urls.add(abs);
    }

    // 6b. Regex for manifest/playlist URLs: e.g. /hls/.../master.m3u8 or playlist.m3u8
    const relativeM3u8Regex = /["'](\/[^"'\\s\s]+\.(?:m3u8|m3u)[^"'\\s\s]*)["']/gi;
    while ((match = relativeM3u8Regex.exec(scriptContents)) !== null) {
      const abs = normalizeMediaUrl(match[1], pageUrl);
      if (abs) urls.add(abs);
    }

    // 6c. Regex for JW Player setup: jwplayer(...).setup({ file: "...", image: "..." })
    const jwPlayerMatch = scriptContents.match(/jwplayer\([^)]*\)\.setup\(\s*({[\s\S]*?})\s*\)/i);
    if (jwPlayerMatch) {
      try {
        const jsonLike = jwPlayerMatch[1].replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
        const parsed = JSON.parse(jsonLike);
        scanObjectForMedia(parsed, pageUrl, urls, thumbnails);
      } catch {}
    }

    // 6d. Regex for Hls.js loadSource: hls.loadSource("...")
    const hlsLoadMatches = scriptContents.matchAll(/hls\.loadSource\(\s*["']([^"']+)["']\s*\)/gi);
    for (const m of hlsLoadMatches) {
      const abs = normalizeMediaUrl(m[1], pageUrl);
      if (abs) urls.add(abs);
    }

    // 6e. Regex for Video.js source: player.src({ src: '...', type: 'application/x-mpegURL' })
    const videoJsMatches = scriptContents.matchAll(/src\s*:\s*["']([^"']+\.(?:m3u8|m3u)[^"']*)["']/gi);
    for (const m of videoJsMatches) {
      const abs = normalizeMediaUrl(m[1], pageUrl);
      if (abs) urls.add(abs);
    }

    // 6f. Regex for Clappr / Plyr / DPlayer / Artplayer / Fluid Player
    const playerConfigsMatches = scriptContents.matchAll(/(?:source|url|file|manifest)\s*:\s*["']([^"']+\.(?:m3u8|m3u)[^"']*)["']/gi);
    for (const m of playerConfigsMatches) {
      const abs = normalizeMediaUrl(m[1], pageUrl);
      if (abs) urls.add(abs);
    }

    // 6g. Regex for poster/image in scripts
    const posterInScriptRegex = /(?:poster|image|thumbnail)\s*:\s*["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi;
    while ((match = posterInScriptRegex.exec(scriptContents)) !== null) {
      const abs = normalizeMediaUrl(match[1], pageUrl);
      if (abs) thumbnails.add(abs);
    }

  } catch (err: any) {
    logger.warn(`scanHtmlForM3u8 error: ${err.message || err}`);
  }

  const foundUrls = Array.from(urls);
  const foundThumbnails = Array.from(thumbnails);

  // Normalize: prioritize master playlist first, then playlist, then media
  const master = foundUrls.find(u => u.toLowerCase().includes('master.m3u8') || u.toLowerCase().includes('master.m3u'));
  const primaryM3u8 = master || foundUrls[0];

  return {
    foundUrls,
    primaryM3u8,
    sourceThumbnail: foundThumbnails[0],
    playerConfigs,
  };
}
