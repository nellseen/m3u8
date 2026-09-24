import { isM3u8Url, analyzeUrl } from './url-extractor.ts';
import { BaseEngine } from '../engines/base.ts';
import { DirectEngine } from '../engines/direct-engine.ts';
import { PlaywrightEngine } from '../engines/playwright-engine.ts';
import { StreamlinkEngine } from '../engines/streamlink-engine.ts';
import { YtdlpEngine } from '../engines/ytdlp-engine.ts';
import { FfmpegEngine } from '../engines/ffmpeg-engine.ts';
import { Aria2Engine } from '../engines/aria2-engine.ts';
import { RetryEngine } from '../engines/retry-engine.ts';
import { DownloadTask } from '../types.ts';
import { logger } from '../logger.ts';

export type SourceCategory =
  | 'DIRECT_M3U8'
  | 'DIRECT_VIDEO'
  | 'YTDLP_PREFERRED'
  | 'STREAMLINK_PREFERRED'
  | 'PAGE_DISCOVERY';

export interface RouteDecision {
  category: SourceCategory;
  reason: string;
  recommendedEngines: BaseEngine[];
  skipPlaywright: boolean;
}

const YTDLP_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'instagram.com',
  'reddit.com',
  'facebook.com',
  'fb.watch',
  'bilibili.com',
  'bilibili.tv',
  'vimeo.com',
  'soundcloud.com',
  'pinterest.com',
  'threads.net',
];

const STREAMLINK_DOMAINS = [
  'twitch.tv',
  'kick.com',
  'chzzk.naver.com',
  'afreecatv.com',
  'sooplive.co.kr',
  'livestream.com',
];

/**
 * Classifies source URL into distinct architectural categories
 * to route tasks intelligently instead of running an invariant fixed fallback sequence.
 */
export function categorizeSourceUrl(url: string): SourceCategory {
  if (!url) return 'PAGE_DISCOVERY';
  const trimmed = url.trim();

  // 1. Direct M3U8 Check (files, playlists, HLS queries, master/variant streams)
  if (isM3u8Url(trimmed) || /\.m3u8(\?|#|$)/i.test(trimmed) || /\.m3u(\?|#|$)/i.test(trimmed)) {
    return 'DIRECT_M3U8';
  }

  // 2. Direct Video File Check (.mp4, .mkv, .webm, .mov, etc.)
  const analyzed = analyzeUrl(trimmed);
  if (analyzed.isDirectVideo) {
    return 'DIRECT_VIDEO';
  }

  // Check domain if valid HTTP URL
  let hostname = '';
  try {
    const parsed = new URL(trimmed);
    hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Local path or non-standard URL
    if (trimmed.endsWith('.m3u8') || trimmed.includes('.m3u8')) {
      return 'DIRECT_M3U8';
    }
  }

  if (hostname) {
    // 3. Known Streamlink Live Streaming Platforms
    if (STREAMLINK_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))) {
      return 'STREAMLINK_PREFERRED';
    }

    // 4. Known yt-dlp Video Platforms
    if (YTDLP_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`))) {
      return 'YTDLP_PREFERRED';
    }

    if (hostname.includes('dailymotion.com')) {
      if (trimmed.includes('/live/') || trimmed.includes('/video/x')) {
        return 'STREAMLINK_PREFERRED';
      }
      return 'YTDLP_PREFERRED';
    }
  }

  // 5. Generic Web Page / JavaScript-heavy site
  return 'PAGE_DISCOVERY';
}

export interface EngineRegistry {
  direct: DirectEngine;
  playwright: PlaywrightEngine;
  streamlink: StreamlinkEngine;
  ytdlp: YtdlpEngine;
  ffmpeg: FfmpegEngine;
  aria2: Aria2Engine;
  retry: RetryEngine;
}

/**
 * Selects the optimal engine pipeline according to source characteristics.
 * Eliminates Chromium/Playwright launch overhead when a manifest is already directly available.
 */
export function planEngineRoute(
  task: DownloadTask,
  engines: EngineRegistry
): RouteDecision {
  const activeUrl = task.streamUrl || task.originalUrl;
  const hasDirectManifest = Boolean(task.streamUrl) || isM3u8Url(activeUrl);

  // A. If a manifest is already identified directly or via earlier discovery:
  // ROUTE DIRECTLY TO M3U8 / FFMPEG PIPELINE. NEVER LAUNCH PLAYWRIGHT.
  if (hasDirectManifest) {
    logger.info(`[Router] Direct M3U8 manifest confirmed for task ${task.id}. Prioritizing M3U8 Parser & Aria2/FFmpeg pipeline (Playwright bypassed).`);
    return {
      category: 'DIRECT_M3U8',
      reason: 'Direct M3U8 manifest available. Playwright/Chromium bypassed to eliminate overhead.',
      skipPlaywright: true,
      recommendedEngines: [
        engines.aria2,      // Priority 1: Aria2 Parallel Multi-Connection Segment Downloader
        engines.ffmpeg,     // Priority 2: Direct HLS & FFmpeg segment assembly
        engines.ytdlp,      // Priority 3: yt-dlp secondary HLS fetcher
        engines.streamlink, // Priority 4: Streamlink fallback
        engines.retry,      // Priority 5: Secondary retry
      ],
    };
  }

  const category = categorizeSourceUrl(activeUrl);

  switch (category) {
    case 'DIRECT_M3U8':
      logger.info(`[Router] Source classified as DIRECT_M3U8 (${activeUrl}). Bypassing Playwright/Chromium.`);
      return {
        category: 'DIRECT_M3U8',
        reason: 'Direct M3U8 URL detected. Routing to Aria2 & FFmpeg pipeline directly.',
        skipPlaywright: true,
        recommendedEngines: [
          engines.aria2,
          engines.ffmpeg,
          engines.ytdlp,
          engines.streamlink,
          engines.retry,
        ],
      };

    case 'DIRECT_VIDEO':
      logger.info(`[Router] Source classified as DIRECT_VIDEO (${activeUrl}).`);
      return {
        category: 'DIRECT_VIDEO',
        reason: 'Direct binary video file stream detected. Routing to Direct HTTP downloader.',
        skipPlaywright: true,
        recommendedEngines: [
          engines.direct,
          engines.aria2,
          engines.ytdlp,
          engines.ffmpeg,
          engines.retry,
        ],
      };

    case 'STREAMLINK_PREFERRED':
      logger.info(`[Router] Source classified as STREAMLINK_PREFERRED (${activeUrl}).`);
      return {
        category: 'STREAMLINK_PREFERRED',
        reason: 'Live streaming platform detected. Routing to Streamlink first.',
        skipPlaywright: false,
        recommendedEngines: [
          engines.streamlink,
          engines.ytdlp,
          engines.direct,
          engines.playwright,
          engines.aria2,
          engines.ffmpeg,
          engines.retry,
        ],
      };

    case 'YTDLP_PREFERRED':
      logger.info(`[Router] Source classified as YTDLP_PREFERRED (${activeUrl}).`);
      return {
        category: 'YTDLP_PREFERRED',
        reason: 'Dedicated media platform detected. Routing to yt-dlp first.',
        skipPlaywright: false,
        recommendedEngines: [
          engines.ytdlp,
          engines.direct,
          engines.playwright,
          engines.aria2,
          engines.ffmpeg,
          engines.retry,
        ],
      };

    case 'PAGE_DISCOVERY':
    default:
      // Page discovery:
      // 1. DirectEngine: Deep static HTML/HTTP inspection (fast, ~100ms)
      // 2. PlaywrightEngine: Network interception for JS-heavy/SPA pages
      // 3. Downstream download engines
      logger.info(`[Router] Source classified as PAGE_DISCOVERY (${activeUrl}). Initializing discovery flow.`);
      return {
        category: 'PAGE_DISCOVERY',
        reason: 'Web page requires discovery. Running static inspection first, then JS network interception if required.',
        skipPlaywright: false,
        recommendedEngines: [
          engines.direct,
          engines.playwright,
          engines.aria2,
          engines.ffmpeg,
          engines.ytdlp,
          engines.streamlink,
          engines.retry,
        ],
      };
  }
}
