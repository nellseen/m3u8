/**
 * Signed URL and Token Expiration Utilities
 * Ensures discovery URLs with signed tokens/expirations are not cached excessively,
 * and detects when URLs require re-discovery of fresh manifests.
 */

const SIGNED_PARAM_NAMES = new Set([
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
    // If URL parsing fails, check regex on query string
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
