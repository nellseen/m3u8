import * as cheerio from 'cheerio';
import { logger } from '../logger.ts';
import { normalizeMediaUrl, isM3u8Url, isHlsContentType } from './url-extractor.ts';
import { normalizeCookies, mergeCookieStrings } from './cookie-manager.ts';
import { detectHlsEncryption, parseHlsManifest } from './m3u8-parser.ts';
import { resolveNativeVideoVariant, VideoVariant } from './variant-resolver.ts';

export type CandidateMediaType = 'HLS_MASTER' | 'HLS_MEDIA' | 'DIRECT_VIDEO' | 'UNKNOWN';

export interface DiscoveredCandidate {
  url: string;
  source:
    | 'html_tag'
    | 'iframe'
    | 'inline_script'
    | 'player_config'
    | 'json_data'
    | 'network_xhr'
    | 'network_fetch'
    | 'network_media';
  discoveredAt: number;
  headers?: Record<string, string>;
  cookies?: string;
  probed?: boolean;
  mediaType?: CandidateMediaType;
  contentType?: string;
  contentLength?: number;
  variants?: VideoVariant[];
  rawBodySnippet?: string;
  rankScore: number;
}

export interface UniversalDiscoveryResult {
  pageUrl: string;
  selectedMediaUrl?: string;
  mediaType?: CandidateMediaType;
  candidates: DiscoveredCandidate[];
  sessionHeaders: Record<string, string>;
  cookies?: string;
  selectedVariant?: VideoVariant;
  availableVariants: VideoVariant[];
  sourceThumbnail?: string;
  strategyUsed: string;
}

/**
 * Inspects initial text content & content-type to classify media without relying purely on extensions (Requirement 3, 4).
 */
export function inspectContentSignature(
  bodyText: string,
  contentType: string
): { mediaType: CandidateMediaType; isMaster: boolean } {
  const trimmed = (bodyText || '').trim();
  const lowerMime = (contentType || '').toLowerCase();

  // Check HLS signatures in body
  if (trimmed.startsWith('#EXTM3U') || trimmed.includes('#EXTM3U')) {
    if (trimmed.includes('#EXT-X-STREAM-INF')) {
      return { mediaType: 'HLS_MASTER', isMaster: true };
    }
    if (
      trimmed.includes('#EXTINF') ||
      trimmed.includes('#EXT-X-TARGETDURATION') ||
      trimmed.includes('#EXT-X-MEDIA-SEQUENCE')
    ) {
      return { mediaType: 'HLS_MEDIA', isMaster: false };
    }
    return { mediaType: 'HLS_MEDIA', isMaster: false };
  }

  // Check MIME types
  if (isHlsContentType(lowerMime)) {
    if (trimmed.includes('#EXT-X-STREAM-INF')) {
      return { mediaType: 'HLS_MASTER', isMaster: true };
    }
    return { mediaType: 'HLS_MEDIA', isMaster: false };
  }

  if (
    lowerMime.includes('video/') ||
    lowerMime.includes('application/mp4') ||
    lowerMime.includes('application/vnd.apple.mp4')
  ) {
    return { mediaType: 'DIRECT_VIDEO', isMaster: false };
  }

  // Check binary magic bytes for MP4 (ftyp)
  if (bodyText.includes('ftyp') || bodyText.startsWith('\x00\x00\x00')) {
    return { mediaType: 'DIRECT_VIDEO', isMaster: false };
  }

  return { mediaType: 'UNKNOWN', isMaster: false };
}

/**
 * Unescapes and cleans encoded URLs found in inline scripts or player configs (Requirement 7).
 */
export function cleanDiscoveredUrl(raw: string, baseUrl: string): string | null {
  if (!raw || typeof raw !== 'string') return null;

  let cleaned = raw.trim();

  // Strip wrapping quotes
  cleaned = cleaned.replace(/^['"`]|['"`]$/g, '');

  // Unescape unicode slashes \u002F and \u003A
  cleaned = cleaned.replace(/\\u002f/gi, '/').replace(/\\u003a/gi, ':');

  // Unescape backslashes: https:\/\/cdn.com\/hls\/ -> https://cdn.com/hls/
  cleaned = cleaned.replace(/\\\//g, '/').replace(/\\/g, '');

  // Handle URL-encoded HTTP: http%3A%2F%2F
  if (/^https?%3A%2F%2F/i.test(cleaned)) {
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {}
  }

  // Handle Base64 encoded URLs: e.g. aHR0cHM6Ly9...
  if (/^aHR0c(HM6Ly|HM6Ly9|DOTov)/.test(cleaned)) {
    try {
      const decoded = Buffer.from(cleaned, 'base64').toString('utf8');
      if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
        cleaned = decoded;
      }
    } catch {}
  }

  // Normalize relative or protocol-relative URL
  const normalized = normalizeMediaUrl(cleaned, baseUrl);
  if (!normalized) return null;

  // Filter out image/font/analytics junk
  const lower = normalized.toLowerCase();
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.css') ||
    lower.endsWith('.woff') ||
    lower.endsWith('.woff2') ||
    lower.includes('google-analytics') ||
    lower.includes('googletagmanager') ||
    lower.includes('doubleclick')
  ) {
    return null;
  }

  return normalized;
}

/**
 * Checks if a URL string looks like a media candidate, extension-agnostic (Requirement 3).
 */
export function isCandidateMediaUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();

  // 1. Obvious extensions
  if (
    lower.includes('.m3u8') ||
    lower.includes('.m3u') ||
    lower.includes('.mpd') ||
    lower.includes('.mp4') ||
    lower.includes('.webm') ||
    lower.includes('.ts')
  ) {
    return true;
  }

  // 2. Structural patterns without extensions
  if (
    lower.includes('multi=') ||
    lower.includes('/master') ||
    lower.includes('/index') ||
    lower.includes('/playlist') ||
    lower.includes('/manifest') ||
    lower.includes('/stream') ||
    lower.includes('/hls') ||
    lower.includes('/video') ||
    lower.includes('format=m3u8') ||
    lower.includes('type=m3u8') ||
    lower.includes('type=hls') ||
    lower.includes('output=m3u8') ||
    lower.includes('output=hls') ||
    lower.includes('/api/stream') ||
    lower.includes('/api/media') ||
    lower.includes('/player/') ||
    lower.includes('/embed/') ||
    lower.includes('token=')
  ) {
    return true;
  }

  return false;
}

/**
 * Recursively scans JavaScript / JSON objects for media URLs and thumbnails (Requirement 7).
 */
function deepScanObject(
  obj: unknown,
  baseUrl: string,
  candidates: Set<string>,
  thumbnails: Set<string>,
  depth = 0
): void {
  if (!obj || depth > 9) return;

  if (typeof obj === 'string') {
    const cleaned = cleanDiscoveredUrl(obj, baseUrl);
    if (cleaned && isCandidateMediaUrl(cleaned)) {
      candidates.add(cleaned);
    }
    // Also look for image poster
    if (
      obj.includes('.jpg') ||
      obj.includes('.jpeg') ||
      obj.includes('.png') ||
      obj.includes('.webp')
    ) {
      const thumb = normalizeMediaUrl(obj, baseUrl);
      if (thumb) thumbnails.add(thumb);
    }
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepScanObject(item, baseUrl, candidates, thumbnails, depth + 1);
    }
    return;
  }

  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      // Look for media keys: file, src, source, url, stream, manifest, playlist, hls, dash, video
      if (
        lowerKey.includes('file') ||
        lowerKey.includes('src') ||
        lowerKey.includes('source') ||
        lowerKey.includes('url') ||
        lowerKey.includes('stream') ||
        lowerKey.includes('manifest') ||
        lowerKey.includes('playlist') ||
        lowerKey.includes('hls') ||
        lowerKey.includes('dash') ||
        lowerKey.includes('video')
      ) {
        if (typeof value === 'string') {
          const cleaned = cleanDiscoveredUrl(value, baseUrl);
          if (cleaned && isCandidateMediaUrl(cleaned)) {
            candidates.add(cleaned);
          }
        }
      }

      if (
        lowerKey.includes('poster') ||
        lowerKey.includes('thumb') ||
        lowerKey.includes('image') ||
        lowerKey.includes('preview')
      ) {
        if (typeof value === 'string') {
          const thumb = normalizeMediaUrl(value, baseUrl);
          if (thumb) thumbnails.add(thumb);
        }
      }

      deepScanObject(value, baseUrl, candidates, thumbnails, depth + 1);
    }
  }
}

/**
 * Extracts all candidate media URLs from HTML, iframes, inline scripts, and player configurations (Requirement 2, 7).
 */
export function extractMediaCandidatesFromHtml(
  html: string,
  pageUrl: string
): {
  candidates: DiscoveredCandidate[];
  iframesToFollow: string[];
  sourceThumbnail?: string;
} {
  const candidatesMap = new Map<string, DiscoveredCandidate>();
  const iframesToFollow = new Set<string>();
  const thumbnails = new Set<string>();

  const addCandidate = (rawUrl: string, source: DiscoveredCandidate['source'], baseScore = 40) => {
    const cleaned = cleanDiscoveredUrl(rawUrl, pageUrl);
    if (!cleaned) return;
    if (!candidatesMap.has(cleaned)) {
      candidatesMap.set(cleaned, {
        url: cleaned,
        source,
        discoveredAt: Date.now(),
        rankScore: baseScore,
      });
      logger.info(`[DISCOVERY] Found candidate: ${cleaned} (source: ${source})`);
    }
  };

  try {
    const $ = cheerio.load(html);

    // 1. Scanning HTML tags (<video>, <source>)
    $('source, video').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-url');
      if (src) addCandidate(src, 'html_tag', 60);

      const poster = $(el).attr('poster') || $(el).attr('data-poster');
      if (poster) {
        const normThumb = normalizeMediaUrl(poster, pageUrl);
        if (normThumb) thumbnails.add(normThumb);
      }
    });

    // 2. Scanning iframes
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src) {
        const normIframe = normalizeMediaUrl(src, pageUrl);
        if (normIframe) {
          const lower = normIframe.toLowerCase();
          // Filter out ads / social widgets
          if (
            !lower.includes('google') &&
            !lower.includes('facebook') &&
            !lower.includes('twitter') &&
            !lower.includes('recaptcha') &&
            !lower.includes('cloudflare')
          ) {
            iframesToFollow.add(normIframe);
            logger.info(`[DISCOVERY] Scanning iframe candidate: ${normIframe}`);
          }
        }
      }
    });

    // 3. Scanning data attributes
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
        if (attr) addCandidate(attr, 'html_tag', 50);
      }

      // Check embedded JSON in data-config or data-setup
      const dataConfig = $(el).attr('data-config') || $(el).attr('data-setup');
      if (dataConfig) {
        try {
          const parsed = JSON.parse(dataConfig);
          const objCandidates = new Set<string>();
          deepScanObject(parsed, pageUrl, objCandidates, thumbnails);
          objCandidates.forEach(u => addCandidate(u, 'player_config', 65));
        } catch {}
      }
    });

    // 4. Scanning JSON scripts (__NEXT_DATA__, __NUXT_DATA__, ld+json, etc.)
    $('script').each((_, el) => {
      const type = ($(el).attr('type') || '').toLowerCase();
      const id = ($(el).attr('id') || '').toLowerCase();
      const content = $(el).html() || '';
      if (!content.trim()) return;

      if (type.includes('json') || id.includes('json') || id.includes('next') || id.includes('nuxt')) {
        try {
          const parsed = JSON.parse(content);
          const objCandidates = new Set<string>();
          deepScanObject(parsed, pageUrl, objCandidates, thumbnails);
          objCandidates.forEach(u => addCandidate(u, 'json_data', 70));
        } catch {}
      }
    });

    // 5. Scanning inline JavaScript code and player configurations
    const scriptContents = $('script').map((_, el) => $(el).html() || '').get().join('\n');

    // 5a. Look for JW Player setup: jwplayer(...).setup({ file: "...", ... })
    const jwMatches = scriptContents.matchAll(/jwplayer\([^)]*\)\.setup\(\s*({[\s\S]*?})\s*\)/gi);
    for (const m of jwMatches) {
      try {
        const jsonLike = m[1].replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
        const parsed = JSON.parse(jsonLike);
        const objCandidates = new Set<string>();
        deepScanObject(parsed, pageUrl, objCandidates, thumbnails);
        objCandidates.forEach(u => addCandidate(u, 'player_config', 80));
      } catch {}
    }

    // 5b. Look for Hls.js, Video.js, Plyr, Clappr, DPlayer, Artplayer patterns:
    // e.g. player({ source: "..." }), hls.loadSource("..."), player.src("...")
    const playerPatterns = [
      /hls\.loadSource\(\s*["']([^"']+)["']\s*\)/gi,
      /(?:player|video)\.src\(\s*["']([^"']+)["']\s*\)/gi,
      /(?:source|file|manifest|playlist|stream|url)\s*:\s*["']([^"']+)["']/gi,
      /const\s+(?:video|stream|source|manifest|hlsUrl)\s*=\s*["']([^"']+)["']/gi,
      /let\s+(?:video|stream|source|manifest|hlsUrl)\s*=\s*["']([^"']+)["']/gi,
      /var\s+(?:video|stream|source|manifest|hlsUrl)\s*=\s*["']([^"']+)["']/gi,
    ];

    for (const pat of playerPatterns) {
      const matches = scriptContents.matchAll(pat);
      for (const m of matches) {
        if (m[1]) {
          addCandidate(m[1], 'player_config', 75);
        }
      }
    }

    // 5c. Regex for direct m3u8, mpd, or stream URLs in scripts
    const generalUrlRegex = /["'](https?:\\?\/\\?\/[^"'\\s\s]+(?:m3u8|m3u|mpd|mp4|multi=|\/master|\/playlist|\/stream|\/video)[^"'\\s\s]*)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = generalUrlRegex.exec(scriptContents)) !== null) {
      addCandidate(match[1], 'inline_script', 60);
    }

    // 5d. Regex for poster/image in scripts
    const posterRegex = /(?:poster|image|thumbnail)\s*:\s*["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi;
    while ((match = posterRegex.exec(scriptContents)) !== null) {
      const norm = normalizeMediaUrl(match[1], pageUrl);
      if (norm) thumbnails.add(norm);
    }
  } catch (err: any) {
    logger.warn(`[DISCOVERY] HTML parsing warning: ${err.message || err}`);
  }

  const candidates = Array.from(candidatesMap.values());
  const sourceThumbnail = Array.from(thumbnails)[0];

  return {
    candidates,
    iframesToFollow: Array.from(iframesToFollow),
    sourceThumbnail,
  };
}

/**
 * Lightweight HTTP content-based probing of a candidate (Requirement 4, 9).
 * Avoids downloading the entire file while accurately inspecting content signatures.
 */
export async function probeCandidateMedia(
  candidate: DiscoveredCandidate,
  sessionHeaders?: Record<string, string>
): Promise<DiscoveredCandidate> {
  if (candidate.probed) return candidate;

  const reqHeaders: Record<string, string> = {
    'User-Agent':
      sessionHeaders?.['user-agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: '*/*',
    ...sessionHeaders,
    ...candidate.headers,
  };

  try {
    // Attempt lightweight GET with Range: bytes=0-4096 to read headers and body signature
    const res = await fetch(candidate.url, {
      method: 'GET',
      headers: {
        ...reqHeaders,
        Range: 'bytes=0-4096',
      },
      signal: AbortSignal.timeout(6000),
    });

    const status = res.status;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);

    candidate.contentType = contentType;
    candidate.contentLength = contentLength;
    candidate.probed = true;

    logger.info(`[PROBE] Content-Type: ${contentType} (status: ${status}) for ${candidate.url}`);

    if (status >= 200 && status < 400) {
      // If server returned HTML, this candidate is likely a webpage or error page
      if (contentType.includes('text/html') && !candidate.url.includes('.m3u8')) {
        candidate.mediaType = 'UNKNOWN';
        candidate.rankScore = 5;
        return candidate;
      }

      const bodyText = await res.text();
      candidate.rawBodySnippet = bodyText.slice(0, 1000);

      const inspection = inspectContentSignature(bodyText, contentType);
      candidate.mediaType = inspection.mediaType;

      if (inspection.mediaType === 'HLS_MASTER') {
        logger.info(`[PROBE] HLS Master detected at ${candidate.url}`);
        candidate.rankScore += 100;
        // Parse variants if available
        try {
          const parsed = parseHlsManifest(bodyText, candidate.url);
          if (parsed.type === 'MASTER' && parsed.variants.length > 0) {
            candidate.variants = parsed.variants.map(v => {
              const h = v.height || (v.resolution ? parseInt(v.resolution.split('x')[1], 10) : 720);
              const w = v.width || (v.resolution ? parseInt(v.resolution.split('x')[0], 10) : undefined);
              return {
                width: w,
                height: h,
                label: `${h}p`,
                url: v.uri,
                bandwidth: v.bandwidth,
                codec: v.codecs,
                sourceType: 'm3u8_stream_inf',
                isValidated: true,
              };
            });
            logger.info(`[HLS] Found ${candidate.variants.length} variants in master manifest`);
          }
        } catch {}
      } else if (inspection.mediaType === 'HLS_MEDIA') {
        logger.info(`[PROBE] HLS Media detected at ${candidate.url}`);
        candidate.rankScore += 80;
      } else if (inspection.mediaType === 'DIRECT_VIDEO') {
        logger.info(`[PROBE] Direct Video detected at ${candidate.url}`);
        candidate.rankScore += 60;
      }
    } else {
      candidate.mediaType = 'UNKNOWN';
      candidate.rankScore = 0;
    }
  } catch (err: any) {
    logger.debug(`[PROBE] Probing failed for ${candidate.url}: ${err.message}`);
    candidate.probed = true;
    candidate.mediaType = 'UNKNOWN';
    candidate.rankScore = 0;
  }

  return candidate;
}

/**
 * Universal Candidate Ranking Algorithm (Requirement 9):
 * 1. Valid HLS Master Playlist (with variants)
 * 2. Valid HLS Media Playlist
 * 3. Candidates with native resolution information (<= 720p preferred)
 * 4. Direct playable media (MP4)
 * 5. Candidate from network discovery
 * 6. Candidate from HTML/JS discovery
 */
export function rankCandidates(candidates: DiscoveredCandidate[]): DiscoveredCandidate[] {
  return [...candidates].sort((a, b) => {
    // 1. HLS Master Playlist gets top priority
    const aIsMaster = a.mediaType === 'HLS_MASTER';
    const bIsMaster = b.mediaType === 'HLS_MASTER';
    if (aIsMaster && !bIsMaster) return -1;
    if (!aIsMaster && bIsMaster) return 1;

    // 2. HLS Media Playlist
    const aIsHls = a.mediaType === 'HLS_MEDIA' || a.url.includes('.m3u8');
    const bIsHls = b.mediaType === 'HLS_MEDIA' || b.url.includes('.m3u8');
    if (aIsHls && !bIsHls) return -1;
    if (!aIsHls && bIsHls) return 1;

    // 3. Direct Video
    const aIsVideo = a.mediaType === 'DIRECT_VIDEO' || a.url.includes('.mp4');
    const bIsVideo = b.mediaType === 'DIRECT_VIDEO' || b.url.includes('.mp4');
    if (aIsVideo && !bIsVideo) return -1;
    if (!aIsVideo && bIsVideo) return 1;

    // 4. Fallback to rankScore descending
    return b.rankScore - a.rankScore;
  });
}

/**
 * Universal Media Discovery Pipeline (Requirement 2, 7, 9, 10, 13, 14):
 * Auto-discovers media from regular web page URLs (HTML, scripts, player configs, nested iframes, content probing).
 */
export async function discoverMediaFromPage(
  pageUrl: string,
  options?: {
    headers?: Record<string, string>;
    cookies?: string;
    onProgress?: (text: string, percent?: number) => void;
  }
): Promise<UniversalDiscoveryResult> {
  const onProgress = options?.onProgress;
  logger.info(`[DISCOVERY] Page URL detected: ${pageUrl}`);
  onProgress?.('Scanning web page for media...', 10);

  const sessionHeaders: Record<string, string> = {
    'user-agent':
      options?.headers?.['user-agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    referer: pageUrl,
    ...options?.headers,
  };

  try {
    sessionHeaders['origin'] = new URL(pageUrl).origin;
  } catch {}

  let sessionCookies = options?.cookies || '';
  let discoveredCandidates: DiscoveredCandidate[] = [];
  let sourceThumbnail: string | undefined;

  // Step 1: HTTP Fetch of main page URL
  try {
    const res = await fetch(pageUrl, {
      headers: sessionHeaders,
      signal: AbortSignal.timeout(12000),
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      sessionCookies = mergeCookieStrings(sessionCookies, normalizeCookies(setCookie));
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    // Check if the page URL was directly an M3U8 or Video stream
    if (isHlsContentType(contentType) || contentType.includes('video/')) {
      logger.info(`[DISCOVERY] URL returned direct media stream header (${contentType})`);
      const directCandidate: DiscoveredCandidate = {
        url: pageUrl,
        source: 'html_tag',
        discoveredAt: Date.now(),
        mediaType: isHlsContentType(contentType) ? 'HLS_MEDIA' : 'DIRECT_VIDEO',
        contentType,
        probed: true,
        rankScore: 100,
      };
      return {
        pageUrl,
        selectedMediaUrl: pageUrl,
        mediaType: directCandidate.mediaType,
        candidates: [directCandidate],
        sessionHeaders,
        cookies: sessionCookies,
        availableVariants: [],
        strategyUsed: 'direct_stream_header',
      };
    }

    const htmlText = await res.text();

    // If response body is raw M3U8 playlist
    if (htmlText.trim().startsWith('#EXTM3U')) {
      logger.info(`[DISCOVERY] Page URL returned raw M3U8 playlist content directly`);
      const inspection = inspectContentSignature(htmlText, contentType);
      const directCandidate: DiscoveredCandidate = {
        url: pageUrl,
        source: 'html_tag',
        discoveredAt: Date.now(),
        mediaType: inspection.mediaType,
        contentType: 'application/vnd.apple.mpegurl',
        rawBodySnippet: htmlText.slice(0, 1000),
        probed: true,
        rankScore: 120,
      };
      return {
        pageUrl,
        selectedMediaUrl: pageUrl,
        mediaType: inspection.mediaType,
        candidates: [directCandidate],
        sessionHeaders,
        cookies: sessionCookies,
        availableVariants: [],
        strategyUsed: 'raw_m3u8_body',
      };
    }

    // Step 2 & 3: Scan HTML, inline scripts, player configurations
    logger.info('[DISCOVERY] Scanning HTML...');
    logger.info('[DISCOVERY] Scanning player configuration...');
    onProgress?.('Extracting players and inline configurations...', 20);

    const htmlExtraction = extractMediaCandidatesFromHtml(htmlText, pageUrl);
    discoveredCandidates.push(...htmlExtraction.candidates);
    sourceThumbnail = htmlExtraction.sourceThumbnail;

    // Step 4: Scan nested iframes (Requirement 2)
    if (htmlExtraction.iframesToFollow.length > 0) {
      logger.info(`[DISCOVERY] Scanning ${htmlExtraction.iframesToFollow.length} iframe targets...`);
      for (const iframeUrl of htmlExtraction.iframesToFollow.slice(0, 3)) {
        try {
          logger.info(`[DISCOVERY] Scanning iframe: ${iframeUrl}`);
          const iframeRes = await fetch(iframeUrl, {
            headers: {
              ...sessionHeaders,
              referer: pageUrl,
            },
            signal: AbortSignal.timeout(8000),
          });

          const iframeCookie = iframeRes.headers.get('set-cookie');
          if (iframeCookie) {
            sessionCookies = mergeCookieStrings(sessionCookies, normalizeCookies(iframeCookie));
          }

          const iframeHtml = await iframeRes.text();
          if (iframeHtml.trim().startsWith('#EXTM3U')) {
            discoveredCandidates.push({
              url: iframeUrl,
              source: 'iframe',
              discoveredAt: Date.now(),
              mediaType: 'HLS_MEDIA',
              probed: true,
              rankScore: 110,
            });
          } else {
            const iframeExtraction = extractMediaCandidatesFromHtml(iframeHtml, iframeUrl);
            discoveredCandidates.push(...iframeExtraction.candidates);
            if (!sourceThumbnail && iframeExtraction.sourceThumbnail) {
              sourceThumbnail = iframeExtraction.sourceThumbnail;
            }
          }
        } catch (err: any) {
          logger.debug(`[DISCOVERY] Iframe scan warning for ${iframeUrl}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    logger.warn(`[DISCOVERY] Main page fetch warning: ${err.message}`);
  }

  // Deduplicate candidates by normalized URL
  const uniqueMap = new Map<string, DiscoveredCandidate>();
  for (const c of discoveredCandidates) {
    if (!uniqueMap.has(c.url)) {
      uniqueMap.set(c.url, c);
    }
  }
  let allCandidates = Array.from(uniqueMap.values());

  logger.info(`[DISCOVERY] Collected ${allCandidates.length} potential media candidates. Probing top candidates...`);
  onProgress?.(`Probing ${allCandidates.length} media candidates...`, 30);

  // Step 5: Probe top candidates with lightweight content-based inspection (Requirement 4, 9)
  const probeLimit = Math.min(allCandidates.length, 6);
  for (let i = 0; i < probeLimit; i++) {
    allCandidates[i] = await probeCandidateMedia(allCandidates[i], sessionHeaders);
  }

  // Step 6: Rank candidates (Requirement 9)
  const ranked = rankCandidates(allCandidates);

  let selectedMediaUrl: string | undefined;
  let selectedMediaType: CandidateMediaType = 'UNKNOWN';
  let selectedVariant: VideoVariant | undefined;
  let availableVariants: VideoVariant[] = [];

  // Pick top ranked valid candidate
  const topCandidate = ranked.find(c => c.mediaType === 'HLS_MASTER' || c.mediaType === 'HLS_MEDIA' || c.mediaType === 'DIRECT_VIDEO');

  if (topCandidate) {
    selectedMediaUrl = topCandidate.url;
    selectedMediaType = topCandidate.mediaType || 'UNKNOWN';

    // If Master playlist with parsed variants, resolve native variant
    if (topCandidate.variants && topCandidate.variants.length > 0) {
      availableVariants = topCandidate.variants;
      const resolved = await resolveNativeVideoVariant(topCandidate.url, {
        headers: sessionHeaders,
        cookies: sessionCookies,
        skipNetworkValidation: true,
        manifestContent: topCandidate.rawBodySnippet,
      });
      selectedVariant = resolved.selectedVariant;
      selectedMediaUrl = selectedVariant.url;
    } else {
      // Run through Native Variant Resolver
      const resolved = await resolveNativeVideoVariant(topCandidate.url, {
        headers: sessionHeaders,
        cookies: sessionCookies,
      });
      selectedVariant = resolved.selectedVariant;
      availableVariants = resolved.availableVariants;
      selectedMediaUrl = selectedVariant.url;
    }

    if (selectedVariant) {
      logger.info(`[HLS] Selected native ${selectedVariant.label}`);
    }
    logger.info(`[DOWNLOAD] Starting native stream download: ${selectedMediaUrl}`);
  }

  return {
    pageUrl,
    selectedMediaUrl,
    mediaType: selectedMediaType,
    candidates: ranked,
    sessionHeaders,
    cookies: sessionCookies,
    selectedVariant,
    availableVariants,
    sourceThumbnail,
    strategyUsed: topCandidate ? `discovery_${topCandidate.source}` : 'none_found',
  };
}
