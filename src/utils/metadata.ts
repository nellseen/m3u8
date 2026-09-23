import * as cheerio from 'cheerio';
import { ExtractedMetadata } from '../types.ts';
import { ensureIndonesianTitle } from './translator.ts';
import { scanHtmlForM3u8AndMedia } from './m3u8-detector.ts';
import { logger } from '../logger.ts';

export async function extractHtmlMetadata(html: string, pageUrl: string): Promise<ExtractedMetadata> {
  const meta: ExtractedMetadata = {};

  try {
    const parsedUrl = new URL(pageUrl);
    meta.domain = parsedUrl.hostname.replace(/^www\./, '');
    meta.source = pageUrl;
  } catch {
    meta.domain = '';
    meta.source = pageUrl;
  }

  try {
    const $ = cheerio.load(html);

    // 1. JSON-LD metadata (Priority 3: Extractor thumbnail)
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const text = $(el).html() || '';
        const json = JSON.parse(text);
        const candidates = Array.isArray(json) ? json : [json];

        for (const item of candidates) {
          if (item['@type'] === 'VideoObject' || item['video']) {
            const video = item['@type'] === 'VideoObject' ? item : item.video;
            if (!meta.originalTitle && video.name) {
              meta.originalTitle = String(video.name).trim();
            }
            if (!meta.description && video.description) {
              meta.description = String(video.description).trim();
            }
            if (!meta.extractorThumbnail && video.thumbnailUrl) {
              meta.extractorThumbnail = Array.isArray(video.thumbnailUrl) ? video.thumbnailUrl[0] : String(video.thumbnailUrl);
            }
            if (!meta.duration && video.duration) {
              // Parse ISO 8601 duration e.g. PT1M30S
              const match = String(video.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
              if (match) {
                const h = parseInt(match[1] || '0', 10);
                const m = parseInt(match[2] || '0', 10);
                const s = parseInt(match[3] || '0', 10);
                meta.duration = h * 3600 + m * 60 + s;
              }
            }
          }
        }
      } catch {
        // Ignore JSON-LD parse errors
      }
    });

    // 2. OpenGraph & Twitter tags (Priority 2: ogImage)
    const ogTitle = $('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content');
    const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="twitter:description"]').attr('content');
    const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
    const ogSite = $('meta[property="og:site_name"]').attr('content');

    if (!meta.originalTitle && ogTitle) {
      meta.originalTitle = ogTitle.trim();
    }
    if (!meta.description && ogDesc) {
      meta.description = ogDesc.trim();
    }
    if (ogImage) {
      meta.ogImage = ogImage.trim();
    }
    if (ogSite && !meta.domain) {
      meta.domain = ogSite.trim();
    }

    // 3. HTML Title & standard meta tags
    if (!meta.originalTitle) {
      const titleTag = $('title').text();
      if (titleTag) {
        meta.originalTitle = titleTag.trim();
      }
    }
    if (!meta.description) {
      const metaDesc = $('meta[name="description"]').attr('content');
      if (metaDesc) {
        meta.description = metaDesc.trim();
      }
    }

    // 4. Video & Source element attributes (Priority 1: sourceThumbnail)
    $('video').each((_, el) => {
      const poster = $(el).attr('poster') || $(el).attr('data-poster');
      if (poster && !meta.sourceThumbnail) {
        try {
          meta.sourceThumbnail = new URL(poster, pageUrl).toString();
        } catch {
          meta.sourceThumbnail = poster;
        }
      }
    });

    // 5. Deep Scan for player configurations & script posters
    const deepScan = scanHtmlForM3u8AndMedia(html, pageUrl);
    if (!meta.sourceThumbnail && deepScan.sourceThumbnail) {
      meta.sourceThumbnail = deepScan.sourceThumbnail;
    }

    // Resolve unified thumbnail candidate according to strict user priorities:
    // 1. Thumbnail source
    // 2. OpenGraph image
    // 3. Extractor thumbnail
    meta.thumbnail = meta.sourceThumbnail || meta.ogImage || meta.extractorThumbnail;

  } catch (err: any) {
    logger.warn('Error parsing HTML metadata:', err.message || err);
  }

  // Clean up title
  if (meta.originalTitle) {
    meta.originalTitle = meta.originalTitle
      .replace(/\s*[-|–—]\s*(YouTube|Twitter|X|Vimeo|TikTok|Dailymotion|Twitch).*$/i, '')
      .trim();
  }

  // Translate foreign title to Indonesian
  if (meta.originalTitle) {
    const trans = await ensureIndonesianTitle(meta.originalTitle);
    meta.translatedTitle = trans.translatedTitle;
    meta.detectedLanguage = trans.detectedLanguage;
    meta.translationStatus = trans.translationStatus;
  }

  return meta;
}
