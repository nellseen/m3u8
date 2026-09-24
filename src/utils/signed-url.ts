/**
 * Signed URL, Token Expiration, and Manifest Refresh Utilities
 * Ensures discovery URLs with signed tokens/expirations are not cached excessively,
 * detects expired segment URLs, and refreshes manifests to generate fresh candidate URLs
 * instead of repeatedly requesting expired streams.
 */

import { buildPropagatedHeaders } from './header-propagator.ts';
import { parseHlsManifest, parseMediaPlaylist, HlsSegmentItem } from './m3u8-parser.ts';
import { isM3u8Url } from './url-extractor.ts';
import { logger } from '../logger.ts';
import { DownloadTask } from '../types.ts';

export const SIGNED_PARAM_NAMES = new Set([
  'token',
  'expires',
  'expires_at',
  'expire',
  'exp',
  'signature',
  'sig',
  'sign',
  'h',
  'st',
  'md5',
  'auth_key',
  'key',
  'wssecret',
  'wstime',
  'timestamp',
  'ts',
  'endtime',
  'validuntil',
  'access_token',
]);

export interface SignedUrlAnalysis {
  isSigned: boolean;
  signedParams: string[];
  expiresAt?: number; // Epoch ms
  isExpired: boolean;
}

export interface FreshManifestResult {
  freshManifestUrl: string;
  freshVariantUrl: string;
  freshSegments: HlsSegmentItem[];
  freshHeaders?: Record<string, string>;
  isMaster: boolean;
}

/**
 * Checks if a given URL contains query parameters typical of signed / expiring media streams
 */
export function isSignedUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (SIGNED_PARAM_NAMES.has(key.toLowerCase())) {
        return true;
      }
    }
  } catch {
    const lower = url.toLowerCase();
    for (const p of SIGNED_PARAM_NAMES) {
      if (lower.includes(`${p}=`)) return true;
    }
  }
  return false;
}

/**
 * Extracts expiration timestamp (in epoch milliseconds) from URL query parameters if present
 */
export function parseUrlExpiration(url: string): number | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const expParamCandidates = [
      'expires',
      'expires_at',
      'expire',
      'exp',
      'wstime',
      'endtime',
      'validuntil',
      'ts',
      'timestamp',
    ];

    const searchMap = new Map<string, string>();
    for (const [k, v] of parsed.searchParams.entries()) {
      searchMap.set(k.toLowerCase(), v);
    }

    for (const param of expParamCandidates) {
      const val = searchMap.get(param);
      if (val) {
        // 1. Numeric decimal string (e.g. 1711234567 or 1711234567000)
        if (/^\d{9,13}$/.test(val)) {
          const num = parseInt(val, 10);
          if (num > 100000000000) {
            // Already milliseconds
            return num;
          } else if (num > 1000000000) {
            // Seconds to milliseconds
            return num * 1000;
          }
        }

        // 2. Hex timestamp (commonly used in CDN wsTime e.g. 6600a1b2)
        if (/^[0-9a-fA-F]{8}$/.test(val)) {
          const hexNum = parseInt(val, 16);
          if (hexNum > 1000000000 && hexNum < 3000000000) {
            return hexNum * 1000;
          }
        }
      }
    }
  } catch {
    // Ignore URL parse error
  }

  return null;
}

/**
 * Determines whether a signed URL is expired or close to expiring (within marginSeconds)
 */
export function isUrlExpired(url: string, marginSeconds = 15): boolean {
  const expiresAt = parseUrlExpiration(url);
  if (!expiresAt) {
    return false;
  }
  const now = Date.now();
  return now + marginSeconds * 1000 >= expiresAt;
}

/**
 * Detects if an error or status represents an expired signed URL / token.
 * Detects:
 * - expires, expire, exp, expires_at, token timestamp
 * - HTTP 401, HTTP 403
 * - expired signature, forbidden segment, manifest expired, segment expired, access denied
 */
export function isExpiredFailure(err: any, url?: string): boolean {
  if (url && isUrlExpired(url)) {
    return true;
  }

  const statusCode =
    typeof err?.status === 'number'
      ? err.status
      : typeof err?.statusCode === 'number'
      ? err.statusCode
      : null;

  if (statusCode === 401 || statusCode === 403) {
    return true;
  }

  const errStr = (err?.message || String(err || '')).toLowerCase();

  if (
    errStr.includes('401') ||
    errStr.includes('403') ||
    errStr.includes('forbidden') ||
    errStr.includes('unauthorized') ||
    errStr.includes('expired signature') ||
    errStr.includes('signature expired') ||
    errStr.includes('forbidden segment') ||
    errStr.includes('manifest expired') ||
    errStr.includes('segment expired') ||
    errStr.includes('token expired') ||
    errStr.includes('token timestamp') ||
    errStr.includes('token or session has expired') ||
    errStr.includes('access denied') ||
    errStr.includes('url expired') ||
    errStr.includes('signature has expired') ||
    errStr.includes('wstime')
  ) {
    return true;
  }

  // Check URL query parameters for expiration
  if (url) {
    const lowerUrl = url.toLowerCase();
    const hasExpParam =
      lowerUrl.includes('expires=') ||
      lowerUrl.includes('expire=') ||
      lowerUrl.includes('exp=') ||
      lowerUrl.includes('expires_at=') ||
      lowerUrl.includes('wstime=');

    if (hasExpParam) {
      const exp = parseUrlExpiration(url);
      if (exp && Date.now() >= exp) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Analyzes full signed state of a stream URL
 */
export function analyzeSignedUrl(url: string): SignedUrlAnalysis {
  const isSigned = isSignedUrl(url);
  const expiresAt = parseUrlExpiration(url) || undefined;
  const isExpired = expiresAt ? isUrlExpired(url) : false;

  const signedParams: string[] = [];
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (SIGNED_PARAM_NAMES.has(key.toLowerCase())) {
        signedParams.push(key);
      }
    }
  } catch {}

  return {
    isSigned,
    signedParams,
    expiresAt,
    isExpired,
  };
}

/**
 * Enforces policy: do not retain discovery URLs excessively.
 * For signed URLs, if age since discovery exceeds maxAgeMs (default: 45s),
 * or if URL timestamp is already expired, source page must be re-discovered for fresh manifest.
 */
export function shouldRefreshManifest(
  discoveredAt?: number,
  url?: string,
  maxAgeMs = 45000
): boolean {
  if (!url) return false;

  if (isUrlExpired(url)) {
    return true;
  }

  if (discoveredAt && isSignedUrl(url)) {
    const age = Date.now() - discoveredAt;
    if (age > maxAgeMs) {
      return true;
    }
  }

  return false;
}

/**
 * Rediscover and refresh manifest to generate fresh segment candidates.
 * Workflow:
 *   segment failure
 *         ↓
 *   determine expired
 *         ↓
 *   rediscover / refresh manifest
 *         ↓
 *   generate fresh candidates
 *         ↓
 *   continue download
 *
 * Avoids repeated attempts on dead expired URLs.
 */
export async function refreshStreamManifest(
  task: DownloadTask,
  currentMediaUrl?: string,
  timeoutMs = 15000
): Promise<FreshManifestResult | null> {
  const targetManifest = typeof currentMediaUrl === 'string' ? currentMediaUrl : (task.streamUrl || task.originalUrl);
  logger.info(`[SignedUrl] Refreshing manifest for task ${task.id} (target: ${(targetManifest || '').slice(0, 100)}...)`);

  const headers = buildPropagatedHeaders(task.streamHeaders, task.cookies, targetManifest);

  // 1. Fetch fresh manifest content
  let manifestText = '';
  let finalManifestUrl = targetManifest;

  try {
    const res = await fetch(targetManifest, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      logger.warn(`[SignedUrl] Direct manifest refresh returned HTTP ${res.status}`);
      return null;
    }

    manifestText = await res.text();
    finalManifestUrl = res.url || targetManifest;
  } catch (err: any) {
    logger.warn(`[SignedUrl] Failed to re-fetch manifest directly: ${err.message}`);
    return null;
  }

  if (!manifestText.includes('#EXTM3U')) {
    logger.warn(`[SignedUrl] Refreshed content is not a valid M3U8 manifest`);
    return null;
  }

  // 2. Parse manifest
  const parsed = parseHlsManifest(manifestText, finalManifestUrl);

  if (parsed.type === 'MASTER') {
    let variantUrl = finalManifestUrl;
    if (parsed.selectedVariant) {
      variantUrl = parsed.selectedVariant.uri;
    } else if (parsed.variants.length > 0) {
      variantUrl = parsed.variants[0].uri;
    }

    logger.info(`[SignedUrl] Refreshed MASTER manifest. Selected fresh variant: ${variantUrl.slice(0, 100)}...`);

    // Fetch the fresh variant media playlist
    try {
      const vHeaders = buildPropagatedHeaders(task.streamHeaders, task.cookies, variantUrl);
      const vRes = await fetch(variantUrl, {
        headers: vHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!vRes.ok) {
        logger.warn(`[SignedUrl] Fresh variant playlist returned HTTP ${vRes.status}`);
        return null;
      }

      const vContent = await vRes.text();
      const mediaParsed = parseMediaPlaylist(vContent, variantUrl);

      // Update task with fresh stream info
      task.streamUrl = variantUrl;
      task.discoveredAt = Date.now();

      return {
        freshManifestUrl: finalManifestUrl,
        freshVariantUrl: variantUrl,
        freshSegments: mediaParsed.segments,
        freshHeaders: headers,
        isMaster: true,
      };
    } catch (vErr: any) {
      logger.warn(`[SignedUrl] Failed to fetch fresh variant playlist: ${vErr.message}`);
      return null;
    }
  } else if (parsed.type === 'MEDIA') {
    logger.info(`[SignedUrl] Refreshed MEDIA manifest. Generated ${parsed.segments.length} fresh segment candidates.`);
    task.streamUrl = finalManifestUrl;
    task.discoveredAt = Date.now();

    return {
      freshManifestUrl: finalManifestUrl,
      freshVariantUrl: finalManifestUrl,
      freshSegments: parsed.segments,
      freshHeaders: headers,
      isMaster: false,
    };
  }

  return null;
}
