import { logger } from '../logger.ts';
import { parseHlsManifest, isManifestContent, HlsVariant } from './m3u8-parser.ts';
import { buildPropagatedHeaders } from './header-propagator.ts';

export interface VideoVariant {
  width?: number;
  height: number;
  label: string; // e.g. "144p", "240p", "480p", "720p", "1080p"
  url: string;
  bandwidth?: number;
  codec?: string; // e.g. "av1", "h264", "hevc"
  sourceType: 'multi_param' | 'url_pattern' | 'm3u8_stream_inf' | 'direct_candidate' | 'source_native';
  isValidated?: boolean;
}

export interface VariantResolutionResult {
  originalUrl: string;
  selectedVariant: VideoVariant;
  availableVariants: VideoVariant[];
  targetMaxHeight: number;
  strategyUsed: string;
  resolutionNote?: string;
}

export const TARGET_MAX_HEIGHT = 720;

/**
 * Standard known resolution profiles used for regex matching and candidate derivation
 */
export const STANDARD_PROFILES: Array<{ height: number; width: number; label: string }> = [
  { height: 144, width: 256, label: '144p' },
  { height: 240, width: 426, label: '240p' },
  { height: 360, width: 640, label: '360p' },
  { height: 480, width: 854, label: '480p' },
  { height: 576, width: 1024, label: '576p' },
  { height: 720, width: 1280, label: '720p' },
  { height: 1080, width: 1920, label: '1080p' },
  { height: 1440, width: 2560, label: '1440p' },
  { height: 2160, width: 3840, label: '2160p' },
];

/**
 * Target Selection Algorithm (Requirement 2, 3, 17):
 * - Target Max Height: 720
 * - Filter variants: height <= 720
 * - Select: MAX(height) amongst compliant (720p > 576p > 480p > 360p > 240p > 144p)
 * - If tie, choose highest bandwidth
 * - Zero upscaling: lower resolutions (e.g. 480p, 360p) stay native without upscale.
 * - If only higher resolutions exist (e.g. only 1080p): NEVER transcode; return closest native variant.
 */
export function selectBestVariant(variants: VideoVariant[], maxTargetHeight = TARGET_MAX_HEIGHT): VideoVariant | undefined {
  if (!variants || variants.length === 0) return undefined;
  if (variants.length === 1) return variants[0];

  // 1. Filter variants <= maxTargetHeight
  const compliant = variants.filter(v => v.height <= maxTargetHeight && v.height > 0);

  if (compliant.length > 0) {
    // Pick the highest resolution among compliant (prefer 720p over 480p over 360p)
    compliant.sort((a, b) => {
      const hDiff = b.height - a.height;
      if (hDiff !== 0) return hDiff;
      return (b.bandwidth || 0) - (a.bandwidth || 0);
    });
    return compliant[0];
  }

  // 2. If NO variants <= maxTargetHeight (e.g. only 1080p or 1440p):
  // NEVER transcode. Return the lowest available resolution above 720p
  const above = [...variants].sort((a, b) => {
    const hDiff = a.height - b.height;
    if (hDiff !== 0) return hDiff;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });
  return above[0];
}

/**
 * Parses the "multi=" parameter from CDN URLs (Requirement 1, 5).
 * Example:
 * multi=256x144:144p:,426x240:240p:,854x480:480p:,1280x720:720p:,1920x1080:1080p:
 *
 * Produces structured array:
 * [
 *   { width: 256, height: 144, label: "144p" },
 *   { width: 426, height: 240, label: "240p" },
 *   ...
 * ]
 */
export function parseMultiParameter(url: string): Array<{ width: number; height: number; label: string }> {
  if (!url || !url.includes('multi=')) return [];

  // Match multi=... up to the next slash or query delimiter
  const multiMatch = url.match(/multi=([^/?#]+)/i);
  if (!multiMatch) return [];

  const rawMulti = multiMatch[1];
  const entries = rawMulti.split(',').map(s => s.trim()).filter(Boolean);
  const results: Array<{ width: number; height: number; label: string }> = [];

  for (const entry of entries) {
    // Format: 256x144:144p: or 256x144:144p or 1280x720:720p
    const match = entry.match(/^(\d{2,5})x(\d{2,5}):([a-zA-Z0-9_-]+):?/i);
    if (match) {
      const width = parseInt(match[1], 10);
      const height = parseInt(match[2], 10);
      let label = match[3].toLowerCase();
      if (!label.endsWith('p')) {
        label = `${height}p`;
      }
      results.push({ width, height, label });
    }
  }

  return results;
}

/**
 * Derives variant URLs from a multi= URL by substituting the resolution label / dimensions in the path.
 */
export function deriveMultiVariantUrls(
  originalUrl: string,
  multiEntries: Array<{ width: number; height: number; label: string }>
): VideoVariant[] {
  if (!multiEntries || multiEntries.length === 0) return [];

  const variants: VideoVariant[] = [];

  // Find existing label or dimension in the path / filename (e.g. 720p.av1.mp4, 1080p.mp4, 1280x720.mp4)
  const currentLabelMatch = originalUrl.match(/(?:^|[/_.-])(144p|240p|360p|480p|576p|720p|1080p|1440p|2160p)(?:[._-]|$)/i);
  const currentDimMatch = originalUrl.match(/(?:^|[/_.-])(\d{3,4})x(\d{3,4})(?:[._-]|$)/i);

  for (const entry of multiEntries) {
    let variantUrl = originalUrl;

    if (currentLabelMatch) {
      const currentToken = currentLabelMatch[1];
      // Replace last occurrence of the label token with entry label
      const lastIndex = variantUrl.lastIndexOf(currentToken);
      if (lastIndex !== -1) {
        variantUrl =
          variantUrl.substring(0, lastIndex) +
          entry.label +
          variantUrl.substring(lastIndex + currentToken.length);
      }
    } else if (currentDimMatch) {
      const currentDim = `${currentDimMatch[1]}x${currentDimMatch[2]}`;
      const targetDim = `${entry.width}x${entry.height}`;
      const lastIndex = variantUrl.lastIndexOf(currentDim);
      if (lastIndex !== -1) {
        variantUrl =
          variantUrl.substring(0, lastIndex) +
          targetDim +
          variantUrl.substring(lastIndex + currentDim.length);
      }
    }

    variants.push({
      width: entry.width,
      height: entry.height,
      label: entry.label,
      url: variantUrl,
      sourceType: 'multi_param',
    });
  }

  return variants;
}

/**
 * Detects resolution information embedded in the URL path or query string (Requirement 4, 8).
 */
export function detectUrlResolutionPattern(url: string): { height?: number; width?: number; label?: string } {
  if (!url) return {};

  // Check dimension pattern: 1280x720, 1920x1080, etc.
  const dimMatch = url.match(/(?:^|[/_.-])(\d{3,4})x(\d{3,4})(?:[._-]|$)/i);
  if (dimMatch) {
    const w = parseInt(dimMatch[1], 10);
    const h = parseInt(dimMatch[2], 10);
    if (h >= 100 && h <= 4320 && w >= 100 && w <= 7680) {
      return { width: w, height: h, label: `${h}p` };
    }
  }

  // Check label pattern: 720p, 1080p, 480p, etc.
  const labelMatch = url.match(/(?:^|[/_.-])(144|240|360|480|576|720|1080|1440|2160)p(?:[._-]|$)/i);
  if (labelMatch) {
    const h = parseInt(labelMatch[1], 10);
    const standard = STANDARD_PROFILES.find(p => p.height === h);
    return {
      height: h,
      width: standard?.width,
      label: `${h}p`,
    };
  }

  // Check video_720, video_1080 pattern
  const videoNumMatch = url.match(/video[_-](\d{3,4})(?:[._-]|$)/i);
  if (videoNumMatch) {
    const h = parseInt(videoNumMatch[1], 10);
    const standard = STANDARD_PROFILES.find(p => p.height === h);
    if (standard) {
      return { height: h, width: standard.width, label: `${h}p` };
    }
  }

  return {};
}

/**
 * Generates candidate variant URLs for direct MP4 URLs by substituting resolution labels (Requirement 8).
 */
export function generateDirectMp4Candidates(originalUrl: string): VideoVariant[] {
  const detected = detectUrlResolutionPattern(originalUrl);
  if (!detected.height || !detected.label) return [];

  const currentHeight = detected.height;
  const currentLabel = detected.label;

  const candidates: VideoVariant[] = [];

  // Generate candidates for all standard resolutions <= 720p plus current if > 720p
  const targetProfiles = STANDARD_PROFILES.filter(p => p.height <= 720 || p.height === currentHeight);

  for (const profile of targetProfiles) {
    let candidateUrl = originalUrl;

    if (profile.height === currentHeight) {
      candidates.push({
        width: profile.width,
        height: profile.height,
        label: profile.label,
        url: originalUrl,
        sourceType: 'url_pattern',
      });
      continue;
    }

    // Replace label token (e.g. 1080p -> 720p)
    const labelRegex = new RegExp(`([/_.-])${currentLabel}([._-])`, 'i');
    if (labelRegex.test(candidateUrl)) {
      candidateUrl = candidateUrl.replace(labelRegex, `$1${profile.label}$2`);
    } else {
      // Replace dimension token (e.g. 1920x1080 -> 1280x720)
      const currentDim = `${STANDARD_PROFILES.find(p => p.height === currentHeight)?.width}x${currentHeight}`;
      const targetDim = `${profile.width}x${profile.height}`;
      if (candidateUrl.includes(currentDim)) {
        candidateUrl = candidateUrl.replace(currentDim, targetDim);
      } else {
        continue;
      }
    }

    candidates.push({
      width: profile.width,
      height: profile.height,
      label: profile.label,
      url: candidateUrl,
      sourceType: 'direct_candidate',
    });
  }

  return candidates;
}

/**
 * Validates a candidate variant URL via lightweight HTTP HEAD or Range request (Requirement 9).
 * Avoids downloading the entire file.
 */
export async function validateCandidateUrl(
  url: string,
  headers?: Record<string, string>
): Promise<boolean> {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return false;
  }

  const reqHeaders: Record<string, string> = {
    'User-Agent':
      headers?.['user-agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ...headers,
  };

  // Try HTTP HEAD first
  try {
    const headRes = await fetch(url, {
      method: 'HEAD',
      headers: reqHeaders,
      signal: AbortSignal.timeout(4000),
    });

    if (headRes.ok) {
      const contentType = (headRes.headers.get('content-type') || '').toLowerCase();
      // Ensure not HTML error page
      if (!contentType.includes('text/html') && !contentType.includes('application/json')) {
        return true;
      }
    }
  } catch {
    // HEAD failed or blocked by server; fallback to Range GET
  }

  // Fallback: Lightweight GET with Range: bytes=0-1024
  try {
    const getRes = await fetch(url, {
      method: 'GET',
      headers: {
        ...reqHeaders,
        Range: 'bytes=0-1024',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (getRes.status === 200 || getRes.status === 206) {
      const contentType = (getRes.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('application/json')) {
        return true;
      }
    }
  } catch {
    // Network failure
  }

  return false;
}

/**
 * Resolves variants from an HLS Master Playlist (Requirement 6, 7).
 */
export function extractVariantsFromMasterM3u8(masterUrl: string, manifestContent: string): VideoVariant[] {
  const parsed = parseHlsManifest(manifestContent, masterUrl);
  if (parsed.type !== 'MASTER' || !parsed.variants || parsed.variants.length === 0) {
    return [];
  }

  return parsed.variants.map((v: HlsVariant) => {
    const height = v.height || (v.resolution ? parseInt(v.resolution.split('x')[1], 10) : 720);
    const width = v.width || (v.resolution ? parseInt(v.resolution.split('x')[0], 10) : undefined);
    return {
      width,
      height,
      label: `${height}p`,
      url: v.uri,
      bandwidth: v.bandwidth,
      codec: v.codecs,
      sourceType: 'm3u8_stream_inf',
      isValidated: true,
    };
  });
}

/**
 * Universal Native Video Variant Resolver (Requirement 1, 16, 21, 24).
 * Order of execution:
 * 1. Parse `multi=` parameter in URL if present.
 * 2. Check for Master M3U8 (#EXT-X-STREAM-INF).
 * 3. Detect resolution pattern in URL path and derive MP4 candidates.
 * 4. Validate candidates via HTTP HEAD/Range requests.
 * 5. Apply Target Selection Algorithm (TARGET_MAX_HEIGHT = 720, max <= 720p).
 * 6. Return selected native variant with zero transcoding.
 */
export async function resolveNativeVideoVariant(
  rawUrl: string,
  options?: {
    headers?: Record<string, string>;
    cookies?: any;
    targetMaxHeight?: number;
    onProgress?: (text: string, percent?: number) => void;
    skipNetworkValidation?: boolean;
    manifestContent?: string;
  }
): Promise<VariantResolutionResult> {
  const maxTarget = options?.targetMaxHeight || TARGET_MAX_HEIGHT;
  const onProgress = options?.onProgress;

  logger.info(`[Resolver] URL detected: ${rawUrl}`);
  onProgress?.('Resolving video variants...', 5);

  let availableVariants: VideoVariant[] = [];
  let strategyUsed = 'native_direct';

  // Strategy 1: Check for "multi=" parameter in URL
  if (rawUrl.includes('multi=')) {
    logger.info('[Resolver] Parsing variants from multi= parameter...');
    const multiEntries = parseMultiParameter(rawUrl);
    if (multiEntries.length > 0) {
      strategyUsed = 'multi_parameter';
      availableVariants = deriveMultiVariantUrls(rawUrl, multiEntries);
      logger.info(`[Resolver] Found ${availableVariants.length} variants from multi= parameter`);
    }
  }

  // Strategy 2: Check for Master M3U8 Manifest
  if (availableVariants.length === 0 && (rawUrl.includes('.m3u8') || options?.manifestContent)) {
    let manifestText = options?.manifestContent;
    if (!manifestText && (rawUrl.startsWith('http://') || rawUrl.startsWith('https://'))) {
      try {
        const reqHeaders = buildPropagatedHeaders(options?.headers, options?.cookies, { targetUrl: rawUrl });
        const res = await fetch(rawUrl, { headers: reqHeaders, signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const text = await res.text();
          if (isManifestContent(text)) {
            manifestText = text;
          }
        }
      } catch {}
    }

    if (manifestText && isManifestContent(manifestText)) {
      const m3u8Variants = extractVariantsFromMasterM3u8(rawUrl, manifestText);
      if (m3u8Variants.length > 0) {
        strategyUsed = 'master_m3u8';
        availableVariants = m3u8Variants;
        logger.info(`[Resolver] Found ${availableVariants.length} variants from Master M3U8`);
      }
    }
  }

  // Strategy 3: Check for direct MP4 resolution patterns in URL path
  if (availableVariants.length === 0) {
    const candidates = generateDirectMp4Candidates(rawUrl);
    if (candidates.length > 1) {
      strategyUsed = 'direct_mp4_pattern';
      availableVariants = candidates;
      logger.info(`[Resolver] Found ${availableVariants.length} potential variants from direct URL pattern`);
    }
  }

  // Fallback: If no variants detected, use source URL as native variant
  if (availableVariants.length === 0) {
    const detected = detectUrlResolutionPattern(rawUrl);
    const nativeHeight = detected.height || 720;
    availableVariants = [
      {
        width: detected.width,
        height: nativeHeight,
        label: detected.label || `${nativeHeight}p`,
        url: rawUrl,
        sourceType: 'source_native',
        isValidated: true,
      },
    ];
  }

  // Log all found variants in required format (Requirement 21)
  logger.info(`[Resolver] Found ${availableVariants.length} variants:`);
  for (const v of availableVariants) {
    const dim = v.width ? `${v.width}x${v.height}` : `${v.height}p`;
    logger.info(`[Resolver] ${v.label} ${dim}`);
  }
  onProgress?.(`Found ${availableVariants.length} variants`, 8);

  // Strategy 4: Selection with validation
  // Filter and sort candidates according to priority policy
  const sortedCandidates = [...availableVariants];
  sortedCandidates.sort((a, b) => {
    const aCompliant = a.height <= maxTarget;
    const bCompliant = b.height <= maxTarget;

    // Both compliant: highest height first (720p > 480p > 360p)
    if (aCompliant && bCompliant) {
      return b.height - a.height;
    }
    // Only one compliant: prefer compliant
    if (aCompliant && !bCompliant) return -1;
    if (!aCompliant && bCompliant) return 1;

    // Neither compliant (both > 720p): lowest height above 720p first (1080p < 1440p)
    return a.height - b.height;
  });

  let selectedVariant: VideoVariant | undefined;

  // Validate candidates if network validation enabled
  if (!options?.skipNetworkValidation) {
    for (const candidate of sortedCandidates) {
      // If it's the original URL, it's inherently assumed valid unless tested
      if (candidate.url === rawUrl) {
        selectedVariant = candidate;
        break;
      }

      // Check if candidate URL is reachable
      const isValid = await validateCandidateUrl(candidate.url, options?.headers);
      if (isValid) {
        candidate.isValidated = true;
        selectedVariant = candidate;
        break;
      } else {
        logger.warn(`[Resolver] Candidate variant ${candidate.label} (${candidate.url}) failed validation. Trying next.`);
      }
    }
  }

  // If no candidate validated (or validation skipped), pick best compliant variant directly
  if (!selectedVariant) {
    selectedVariant = selectBestVariant(availableVariants, maxTarget) || availableVariants[0];
  }

  logger.info(`[Resolver] Selected native ${selectedVariant.label}`);
  onProgress?.(`Selecting ${selectedVariant.label}...`, 10);

  let resolutionNote: string | undefined;
  if (selectedVariant.height > maxTarget) {
    resolutionNote = `Source only provides >${maxTarget}p variants (${selectedVariant.label}). Processing native stream without transcoding.`;
    logger.info(`[Resolver] ${resolutionNote}`);
  }

  return {
    originalUrl: rawUrl,
    selectedVariant,
    availableVariants,
    targetMaxHeight: maxTarget,
    strategyUsed,
    resolutionNote,
  };
}
