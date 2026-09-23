import { URL } from 'url';

const URL_REGEX = /https?:\/\/[^\s<>"'()]+(?:\([^\s<>"']+\)|[^\s<>"'.,:;!?[\]])/gi;

/**
 * Standard HLS Content-Type MIME types
 */
export const HLS_MIME_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/vnd.apple.mpegurl.audio',
] as const;

export interface DetectedUrl {
  url: string;
  isDirectM3u8: boolean;
  isDirectMpd: boolean;
  isDirectVideo: boolean;
}

export function extractUrlsFromText(text?: string): string[] {
  if (!text) return [];
  const matches = text.match(URL_REGEX);
  if (!matches) return [];

  // Clean up trailing punctuation
  return Array.from(
    new Set(
      matches.map(u => {
        let clean = u.trim();
        while (/[.,;:!?)\]]$/.test(clean)) {
          clean = clean.slice(0, -1);
        }
        return clean;
      })
    )
  ).filter(u => isValidHttpUrl(u));
}

export function isValidHttpUrl(string: string): boolean {
  try {
    const parsed = new URL(string);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalizes URL candidate from relative, escaped, or query-encoded paths
 */
export function normalizeMediaUrl(candidate: string, baseUrl?: string): string | null {
  if (!candidate || typeof candidate !== 'string') return null;

  let cleaned = candidate.trim();
  // Strip enclosing quotes and backslashes (JSON or JS string escape)
  cleaned = cleaned.replace(/^['"`]|['"`]$/g, '').replace(/\\/g, '');

  // Handle protocol-relative URLs e.g. //cdn.example.com/live.m3u8
  if (cleaned.startsWith('//')) {
    cleaned = `https:${cleaned}`;
  }

  // If already absolute http/https
  if (isValidHttpUrl(cleaned)) {
    try {
      const u = new URL(cleaned);
      return u.href;
    } catch {
      return null;
    }
  }

  // If relative path and baseUrl is provided
  if (baseUrl && isValidHttpUrl(baseUrl)) {
    try {
      const resolved = new URL(cleaned, baseUrl);
      return resolved.href;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Enhanced check for HLS MIME types from HTTP Content-Type headers
 */
export function isHlsContentType(contentType?: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase().trim();
  return HLS_MIME_TYPES.some(mime => lower.includes(mime));
}

/**
 * Enhanced M3U8 string/url analyzer
 * Detects .m3u8, .m3u, .m3u8?, .m3u8#, manifest, playlist, master playlist, media playlist
 */
export function isM3u8Url(urlString: string): boolean {
  if (!urlString) return false;
  const lower = urlString.toLowerCase().trim();

  // 1. Direct or parameterized .m3u8 / .m3u extensions
  if (
    lower.includes('.m3u8') ||
    lower.endsWith('.m3u8') ||
    /\.m3u8(\?|#|$)/i.test(lower) ||
    lower.includes('.m3u') ||
    lower.endsWith('.m3u') ||
    /\.m3u(\?|#|$)/i.test(lower)
  ) {
    return true;
  }

  // 2. Typical manifest and playlist naming patterns
  try {
    const parsed = new URL(urlString);
    const path = parsed.pathname.toLowerCase();
    
    // Master playlist, media playlist, index, manifest patterns
    if (
      path.includes('master.m3u8') ||
      path.includes('playlist.m3u8') ||
      path.includes('index.m3u8') ||
      path.includes('manifest.m3u8') ||
      path.includes('chunklist.m3u8')
    ) {
      return true;
    }

    // Manifest URL with hls/m3u8 keyword in path or query
    if (
      (path.includes('/manifest') || path.includes('/playlist') || path.includes('/master')) &&
      (path.includes('hls') || parsed.search.includes('hls') || parsed.search.includes('m3u8'))
    ) {
      return true;
    }

    // e.g. /hls-live/.../manifest.m3u8 or /hls/.../master
    if (path.includes('/hls/') && (path.includes('master') || path.includes('playlist') || path.includes('manifest'))) {
      return true;
    }
  } catch {
    // If not a full URL, fallback string inspection
    if (
      (lower.includes('manifest') || lower.includes('playlist') || lower.includes('master')) &&
      (lower.includes('hls') || lower.includes('m3u8'))
    ) {
      return true;
    }
  }

  return false;
}

export function analyzeUrl(url: string): DetectedUrl {
  const lower = url.toLowerCase();
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = lower;
  }

  const isDirectM3u8 = isM3u8Url(url);
  const isDirectMpd = pathname.endsWith('.mpd') || lower.includes('.mpd?') || lower.includes('.mpd&') || lower.includes('.mpd#');
  const isDirectVideo =
    pathname.endsWith('.mp4') ||
    pathname.endsWith('.mkv') ||
    pathname.endsWith('.webm') ||
    pathname.endsWith('.ts') ||
    pathname.endsWith('.mov') ||
    pathname.endsWith('.avi') ||
    /\.(mp4|mkv|webm|ts|mov|avi)(\?|#|$)/i.test(lower);

  return {
    url,
    isDirectM3u8,
    isDirectMpd,
    isDirectVideo,
  };
}
