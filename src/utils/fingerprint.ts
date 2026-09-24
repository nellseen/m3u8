import crypto from 'crypto';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'ref',
  'ref_src',
  'spm',
  'from',
]);

/**
 * Normalizes a URL for deterministic fingerprinting:
 * - Lowercases hostname
 * - Removes default ports (80, 443)
 * - Removes common tracking query parameters
 * - Sorts query parameters alphabetically
 * - Normalizes trailing slash
 */
export function normalizeUrlForFingerprint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl.trim());
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

    // Remove tracking query parameters
    const searchParams = new URLSearchParams(url.search);
    const keysToDelete: string[] = [];
    searchParams.forEach((_, key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.startsWith('utm_')) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      searchParams.delete(key);
    }

    // Sort query parameters
    searchParams.sort();
    url.search = searchParams.toString();

    // Normalize trailing slash in pathname
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    // Strip hash fragment
    url.hash = '';

    return url.toString();
  } catch {
    // If not a valid standard URL, return sanitized trimmed string
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Computes a deterministic job fingerprint from a URL and optional manifest / media content:
 * - Normalized URL
 * - Optional manifest content hash (for same stream content on dynamic URLs)
 */
export function createJobFingerprint(rawUrl: string, manifestContent?: string): string {
  const normalizedUrl = normalizeUrlForFingerprint(rawUrl);

  const hash = crypto.createHash('sha256');
  hash.update(`url:${normalizedUrl}`);

  if (manifestContent && manifestContent.trim().length > 0) {
    // Normalize manifest content by extracting media segment structure
    const cleanedManifest = manifestContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#EXT-X-PROGRAM-DATE-TIME'))
      .join('\n');
    hash.update(`;manifest:${cleanedManifest}`);
  }

  return hash.digest('hex');
}

/**
 * Checks whether two URLs/requests correspond to the same underlying media job
 */
export function areJobsEquivalent(urlA: string, urlB: string): boolean {
  return createJobFingerprint(urlA) === createJobFingerprint(urlB);
}
