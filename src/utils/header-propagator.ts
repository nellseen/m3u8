import { normalizeCookies } from './cookie-manager.ts';
import { logger } from '../logger.ts';

export interface HeaderPropagationOptions {
  includeDefaults?: boolean;
  targetUrl?: string;
  sourceUrl?: string;
  defaultUserAgent?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_ACCEPT = '*/*';
const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9,id;q=0.8';

// Headers managed by network transport stack - do not manually override
const HOP_BY_HOP_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Builds a clean, case-preserving dictionary of HTTP request headers.
 * Strictly propagates:
 * - User-Agent
 * - Referer
 * - Origin
 * - Authorization
 * - Cookie (normalized and merged)
 * - Accept
 * - Accept-Language
 * - Sec-Fetch-* (Mode, Site, Dest)
 * - Sec-Ch-Ua-*
 * - Custom application/player headers (X-*, App-*, Player-*, etc.)
 */
export function buildPropagatedHeaders(
  headers?: Record<string, string>,
  cookies?: string,
  options?: HeaderPropagationOptions | string
): Record<string, string> {
  const opts: HeaderPropagationOptions =
    typeof options === 'string' ? { targetUrl: options } : options || {};

  const result: Record<string, string> = {};
  const normalizedKeyMap = new Map<string, string>(); // lowercase -> canonical key

  // 1. Process provided headers
  if (headers && typeof headers === 'object') {
    for (const [rawKey, rawValue] of Object.entries(headers)) {
      if (rawValue === undefined || rawValue === null || rawValue === '') continue;
      const trimmedKey = rawKey.trim();
      const lower = trimmedKey.toLowerCase();

      if (HOP_BY_HOP_HEADERS.has(lower)) continue;

      const trimmedVal = String(rawValue).trim();
      if (!trimmedVal) continue;

      // Canonical name formatting
      let canonicalKey = trimmedKey;
      if (lower === 'user-agent') canonicalKey = 'User-Agent';
      else if (lower === 'referer') canonicalKey = 'Referer';
      else if (lower === 'origin') canonicalKey = 'Origin';
      else if (lower === 'authorization') canonicalKey = 'Authorization';
      else if (lower === 'cookie') canonicalKey = 'Cookie';
      else if (lower === 'accept') canonicalKey = 'Accept';
      else if (lower === 'accept-language') canonicalKey = 'Accept-Language';
      else if (lower === 'sec-fetch-dest') canonicalKey = 'Sec-Fetch-Dest';
      else if (lower === 'sec-fetch-mode') canonicalKey = 'Sec-Fetch-Mode';
      else if (lower === 'sec-fetch-site') canonicalKey = 'Sec-Fetch-Site';

      // Remove previously set case-variants
      const existingKey = normalizedKeyMap.get(lower);
      if (existingKey && existingKey !== canonicalKey) {
        delete result[existingKey];
      }

      result[canonicalKey] = trimmedVal;
      normalizedKeyMap.set(lower, canonicalKey);
    }
  }

  // 2. Handle Cookies
  const normCookies = normalizeCookies(cookies);
  if (normCookies) {
    const existingCookieKey = normalizedKeyMap.get('cookie');
    if (existingCookieKey && result[existingCookieKey]) {
      // Merge with existing cookie header without duplicate key values
      const existingParts = result[existingCookieKey].split(';').map((p: string) => p.trim()).filter(Boolean);
      const newParts = normCookies.split(';').map((p: string) => p.trim()).filter(Boolean);
      const cookieMap = new Map<string, string>();

      for (const part of existingParts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
          cookieMap.set(part.slice(0, eqIdx).trim(), part.slice(eqIdx + 1).trim());
        }
      }
      for (const part of newParts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
          cookieMap.set(part.slice(0, eqIdx).trim(), part.slice(eqIdx + 1).trim());
        }
      }

      const merged = Array.from(cookieMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

      result[existingCookieKey] = merged;
    } else {
      result['Cookie'] = normCookies;
      normalizedKeyMap.set('cookie', 'Cookie');
    }
  }

  // 3. Defaults if missing
  if (opts.includeDefaults !== false) {
    if (!normalizedKeyMap.has('user-agent')) {
      result['User-Agent'] = opts.defaultUserAgent || DEFAULT_USER_AGENT;
      normalizedKeyMap.set('user-agent', 'User-Agent');
    }

    if (!normalizedKeyMap.has('accept')) {
      result['Accept'] = DEFAULT_ACCEPT;
      normalizedKeyMap.set('accept', 'Accept');
    }

    if (!normalizedKeyMap.has('accept-language')) {
      result['Accept-Language'] = DEFAULT_ACCEPT_LANGUAGE;
      normalizedKeyMap.set('accept-language', 'Accept-Language');
    }

    // Infer Referer/Origin if targetUrl or sourceUrl is supplied and Referer is absent
    const target = opts.sourceUrl || opts.targetUrl;
    if (target && !normalizedKeyMap.has('referer')) {
      try {
        const parsed = new URL(target);
        if (parsed.protocol.startsWith('http')) {
          result['Referer'] = target;
          normalizedKeyMap.set('referer', 'Referer');

          if (!normalizedKeyMap.has('origin')) {
            result['Origin'] = parsed.origin;
            normalizedKeyMap.set('origin', 'Origin');
          }
        }
      } catch {}
    }
  }

  return result;
}

/**
 * Builds HTTP headers string for FFmpeg `-headers` argument
 * CRLF terminated string: "Key: Value\r\n"
 */
export function buildFfmpegHeaderString(
  headers?: Record<string, string>,
  cookies?: string,
  targetUrl?: string
): string {
  const propagated = buildPropagatedHeaders(headers, cookies, {
    includeDefaults: true,
    targetUrl,
  });

  let str = '';
  for (const [k, v] of Object.entries(propagated)) {
    str += `${k}: ${v}\r\n`;
  }
  return str;
}

/**
 * Builds header strings formatted for aria2c
 * Format: "Name: Value"
 */
export function buildAria2Headers(
  headers?: Record<string, string>,
  cookies?: string,
  targetUrl?: string
): string[] {
  const propagated = buildPropagatedHeaders(headers, cookies, {
    includeDefaults: true,
    targetUrl,
  });

  const list: string[] = [];
  for (const [k, v] of Object.entries(propagated)) {
    list.push(`${k}: ${v}`);
  }
  return list;
}

/**
 * Builds header arguments formatted for yt-dlp
 * Format: ['--add-header', 'Name: Value', ...]
 */
export function buildYtdlpHeaderArgs(
  headers?: Record<string, string>,
  cookies?: string,
  targetUrl?: string
): string[] {
  const propagated = buildPropagatedHeaders(headers, cookies, {
    includeDefaults: false,
    targetUrl,
  });

  const args: string[] = [];
  for (const [k, v] of Object.entries(propagated)) {
    args.push('--add-header', `${k}: ${v}`);
  }
  return args;
}

/**
 * Builds header arguments formatted for Streamlink
 * Format: ['--http-header', 'Name=Value', ...]
 */
export function buildStreamlinkHeaderArgs(
  headers?: Record<string, string>,
  cookies?: string,
  targetUrl?: string
): string[] {
  const propagated = buildPropagatedHeaders(headers, cookies, {
    includeDefaults: false,
    targetUrl,
  });

  const args: string[] = [];
  for (const [k, v] of Object.entries(propagated)) {
    args.push('--http-header', `${k}=${v}`);
  }
  return args;
}
