import * as cheerio from 'cheerio';
import { ExtractedMetadata } from '../types.ts';
import { ensureIndonesianTitle } from './translator.ts';
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

    // 1. JSON-LD metadata
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
            if (!meta.thumbnail && video.thumbnailUrl) {
              meta.thumbnail = Array.isArray(video.thumbnailUrl) ? video.thumbnailUrl[0] : String(video.thumbnailUrl);
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

    // 2. OpenGraph & Twitter tags
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
    if (!meta.thumbnail && ogImage) {
      meta.thumbnail = ogImage.trim();
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

    // 4. Video element attributes
    $('video').each((_, el) => {
      const poster = $(el).attr('poster');
      if (poster && !meta.thumbnail) {
        try {
          meta.thumbnail = new URL(poster, pageUrl).toString();
        } catch {
          meta.thumbnail = poster;
        }
      }
    });
  } catch (err: any) {
    logger.warn('Error parsing HTML metadata:', err.message || err);
  }

  // 5. Clean up title (remove trailing site identifiers like " - YouTube", " | Website")
  if (meta.originalTitle) {
    meta.originalTitle = meta.originalTitle
      .replace(/\s*[-|–—]\s*(YouTube|Twitter|X|Vimeo|TikTok|Dailymotion|Twitch).*$/i, '')
      .trim();
  }

  // 6. Translate foreign title to Indonesian
  if (meta.originalTitle) {
    const trans = await ensureIndonesianTitle(meta.originalTitle);
    meta.translatedTitle = trans.translatedTitle;
    meta.detectedLanguage = trans.detectedLanguage;
    meta.translationStatus = trans.translationStatus;
  }

  return meta;
}
