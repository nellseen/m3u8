/**
 * HLS Segment Validator
 * Validates that an HLS stream's segments can actually be fetched and played,
 * enforcing the rule: "HTTP 200 manifest does NOT mean video is downloadable".
 *
 * Handles:
 * - 403, 401 (Expired token / signature / forbidden)
 * - 404 (Missing segment / dead stream)
 * - 429 (Rate limited)
 * - 5xx (Server error)
 * - Timeout / Connection reset
 * - Partial or truncated segment
 * - Invalid segment (e.g. HTML/JSON error page disguised as HTTP 200)
 * - DRM detection and rejection without bypass
 */

import { ErrorCategory, HlsEncryptionAnalysis } from '../types.ts';
import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  detectHlsEncryption,
  selectTargetVariant,
} from './m3u8-parser.ts';
import { normalizeCookies } from './cookie-manager.ts';
import { isUrlExpired, isSignedUrl } from './signed-url.ts';
import { logger } from '../logger.ts';

export interface SegmentValidationOptions {
  maxSegmentsToTest?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface SegmentValidationResult {
  valid: boolean;
  error?: string;
  errorType?: ErrorCategory;
  isDrm?: boolean;
  isExpiredUrl?: boolean;
  requiresRefresh?: boolean;
  encryption?: HlsEncryptionAnalysis;
  segmentCount?: number;
  testedSegmentUrl?: string;
  testedStatusCode?: number;
}

/**
 * Builds HTTP fetch headers with genuine session headers and cookies
 */
function buildRequestHeaders(
  headers?: Record<string, string>,
  cookies?: string,
  rangeBytes?: string
): Record<string, string> {
  const reqHeaders: Record<string, string> = {
    'User-Agent':
      headers?.['user-agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept:
      headers?.['accept'] ||
      '*/*',
    'Accept-Language': headers?.['accept-language'] || 'en-US,en;q=0.9',
  };

  if (headers?.['referer']) reqHeaders['Referer'] = headers['referer'];
  if (headers?.['origin']) reqHeaders['Origin'] = headers['origin'];
  if (headers?.['authorization']) reqHeaders['Authorization'] = headers['authorization'];

  const normCookies = normalizeCookies(cookies || headers?.['cookie']);
  if (normCookies) reqHeaders['Cookie'] = normCookies;

  if (rangeBytes) {
    reqHeaders['Range'] = rangeBytes;
  }

  return reqHeaders;
}

/**
 * Inspects a byte buffer to verify if it contains valid media segment data
 * (MPEG-TS, fMP4/ISOBMFF, AAC ADTS, or AES-128 encrypted cipher blocks)
 * and detects invalid payloads (such as HTML error/captcha pages).
 */
export function validateSegmentBytes(
  buffer: Uint8Array,
  isEncrypted = false
): { valid: boolean; reason?: string } {
  if (!buffer || buffer.length < 16) {
    return { valid: false, reason: 'Segment payload is empty or truncated (< 16 bytes)' };
  }

  // 1. Check for HTML or JSON error payloads disguised as 200 OK
  const textPrefix = new TextDecoder('utf-8', { fatal: false })
    .decode(buffer.slice(0, Math.min(256, buffer.length)))
    .trim()
    .toLowerCase();

  if (
    textPrefix.startsWith('<!doctype') ||
    textPrefix.startsWith('<html') ||
    textPrefix.startsWith('<?xml') ||
    textPrefix.includes('<title>403') ||
    textPrefix.includes('<title>access denied') ||
    textPrefix.includes('<title>just a moment') ||
    textPrefix.includes('<title>cloudflare') ||
    textPrefix.startsWith('{"error"') ||
    textPrefix.startsWith('{"message"') ||
    textPrefix.startsWith('{"status":')
  ) {
    return {
      valid: false,
      reason: 'Server returned HTML/JSON error page disguised as media segment (status 200 CDN error/captcha)',
    };
  }

  // If stream is AES-128 encrypted, the payload is high-entropy encrypted ciphertext
  if (isEncrypted) {
    if (buffer.length % 16 !== 0 && buffer.length < 188) {
      return { valid: false, reason: 'Encrypted segment length does not align with AES cipher block boundaries' };
    }
    return { valid: true };
  }

  // 2. Check for MPEG-TS: Sync byte 0x47 (71)
  // MPEG-TS packets are 188 bytes long.
  if (buffer[0] === 0x47) {
    // If buffer has at least 189 bytes, check for second sync byte at offset 188
    if (buffer.length > 188 && buffer[188] === 0x47) {
      return { valid: true };
    }
    return { valid: true };
  }

  // 3. Check for fMP4 / ISOBMFF box (ftyp, styp, moof, mdat, free, skip)
  if (buffer.length >= 8) {
    const boxType = String.fromCharCode(buffer[4], buffer[5], buffer[6], buffer[7]);
    if (['ftyp', 'styp', 'moof', 'mdat', 'free', 'skip', 'wide'].includes(boxType)) {
      return { valid: true };
    }
  }

  // 4. Check for AAC ADTS: 0xFFF syncword (first 12 bits set to 1)
  if (buffer[0] === 0xff && (buffer[1] & 0xf0) === 0xf0) {
    return { valid: true };
  }

  // 5. Check for WebVTT
  if (textPrefix.startsWith('webvtt')) {
    return { valid: true };
  }

  // If buffer has reasonable size (> 512 bytes) and non-zero contents
  if (buffer.length >= 512) {
    return { valid: true };
  }

  return { valid: false, reason: 'Invalid media bitstream: neither MPEG-TS, fMP4, nor AAC ADTS detected' };
}

/**
 * Validates an HLS stream by checking manifest encryption and fetching sample segments.
 */
export async function validateHlsSegments(
  manifestUrl: string,
  manifestContent?: string,
  headers?: Record<string, string>,
  cookies?: string,
  options?: SegmentValidationOptions
): Promise<SegmentValidationResult> {
  const maxRetries = options?.maxRetries ?? 2;
  const retryDelayMs = options?.retryDelayMs ?? 400;
  const timeoutMs = options?.timeoutMs ?? 10000;

  let currentUrl = manifestUrl;
  let currentContent = manifestContent;

  // 1. Fetch manifest content if not supplied
  if (!currentContent) {
    if (manifestUrl.startsWith('http://') || manifestUrl.startsWith('https://')) {
      const reqHeaders = buildRequestHeaders(headers, cookies);
      let res: globalThis.Response;
      try {
        res = await fetch(manifestUrl, {
          headers: reqHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (fetchErr: any) {
        const isTimeout = fetchErr.name === 'AbortError' || String(fetchErr).includes('timeout');
        return {
          valid: false,
          error: `Manifest request failed: ${fetchErr.message}`,
          errorType: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        };
      }

      if (!res.ok) {
        const status = res.status;
        const isExpired = status === 401 || status === 403 || isUrlExpired(manifestUrl);
        let errorType: ErrorCategory = 'NETWORK_ERROR';
        if (status === 401 || status === 403) errorType = 'EXPIRED_URL';
        else if (status === 404) errorType = 'NO_MEDIA_FOUND';

        return {
          valid: false,
          error: `Manifest returned HTTP ${status}: ${res.statusText}`,
          errorType,
          isExpiredUrl: isExpired,
          requiresRefresh: isExpired,
          testedStatusCode: status,
        };
      }

      currentContent = await res.text();
    } else {
      // Not an HTTP URL (e.g. local file)
      return { valid: true };
    }
  }

  // 2. Encryption Detection & Strict Policy Enforcement
  const enc = detectHlsEncryption(currentContent);

  // A. DRM: Halt immediately without attempting bypass
  if (enc.isDrm) {
    logger.warn(`[SegmentValidator] DRM detected for ${manifestUrl}: ${enc.reason}`);
    return {
      valid: false,
      isDrm: true,
      errorType: 'DRM_PROTECTED',
      error: enc.reason || 'DRM Protection detected. DRM cannot be bypassed.',
      encryption: enc,
    };
  }

  // B. SAMPLE-AES or unsupported encryption
  if (!enc.isSupported) {
    logger.warn(`[SegmentValidator] Unsupported encryption for ${manifestUrl}: ${enc.reason}`);
    return {
      valid: false,
      errorType: 'UNSUPPORTED_ENCRYPTION',
      error: enc.reason || 'Unsupported HLS encryption scheme.',
      encryption: enc,
    };
  }

  // 3. Master Playlist handling: if Master, resolve target variant media playlist
  let mediaManifestContent = currentContent;
  let mediaBaseUrl = currentUrl;

  if (currentContent.includes('#EXT-X-STREAM-INF')) {
    const masterParsed = parseMasterPlaylist(currentContent, currentUrl);
    if (masterParsed.isMaster && masterParsed.selectedVariant) {
      const variant = masterParsed.selectedVariant;
      mediaBaseUrl = variant.uri;

      if (variant.uri.startsWith('http://') || variant.uri.startsWith('https://')) {
        try {
          const vRes = await fetch(variant.uri, {
            headers: buildRequestHeaders(headers, cookies),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!vRes.ok) {
            const status = vRes.status;
            const isExpired = status === 401 || status === 403 || isUrlExpired(variant.uri);
            return {
              valid: false,
              error: `Target variant playlist returned HTTP ${status}`,
              errorType: isExpired ? 'EXPIRED_URL' : status === 404 ? 'NO_MEDIA_FOUND' : 'NETWORK_ERROR',
              isExpiredUrl: isExpired,
              requiresRefresh: isExpired,
              testedStatusCode: status,
            };
          }
          mediaManifestContent = await vRes.text();
        } catch (vErr: any) {
          return {
            valid: false,
            error: `Failed to fetch variant playlist: ${vErr.message}`,
            errorType: 'NETWORK_ERROR',
          };
        }
      }
    }
  }

  // Check encryption on the resolved media playlist as well
  const mediaEnc = detectHlsEncryption(mediaManifestContent);
  if (mediaEnc.isDrm) {
    return {
      valid: false,
      isDrm: true,
      errorType: 'DRM_PROTECTED',
      error: mediaEnc.reason || 'DRM Protection detected on media variant. Cannot bypass.',
      encryption: mediaEnc,
    };
  }
  if (!mediaEnc.isSupported) {
    return {
      valid: false,
      errorType: 'UNSUPPORTED_ENCRYPTION',
      error: mediaEnc.reason || 'Unsupported encryption on media variant.',
      encryption: mediaEnc,
    };
  }

  // 4. Validate Encryption Key Accessibility if AES-128
  if (mediaEnc.isAes128 && mediaEnc.keyUri) {
    const keyUrl = mediaEnc.keyUri;
    if (keyUrl.startsWith('http://') || keyUrl.startsWith('https://')) {
      logger.info(`[SegmentValidator] Verifying AES-128 key accessibility: ${keyUrl}`);
      try {
        const keyRes = await fetch(keyUrl, {
          headers: buildRequestHeaders(headers, cookies),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!keyRes.ok) {
          const status = keyRes.status;
          const isExpired = status === 401 || status === 403;
          logger.warn(`[SegmentValidator] AES-128 key returned HTTP ${status}`);
          return {
            valid: false,
            error: `AES-128 encryption key inaccessible (HTTP ${status}). Key credentials or session unavailable.`,
            errorType: isExpired ? 'EXPIRED_URL' : 'NETWORK_ERROR',
            isExpiredUrl: isExpired,
            requiresRefresh: isExpired,
            testedStatusCode: status,
            encryption: mediaEnc,
          };
        }

        const keyBytes = new Uint8Array(await keyRes.arrayBuffer());
        if (keyBytes.length !== 16) {
          return {
            valid: false,
            error: `Invalid AES-128 key size (${keyBytes.length} bytes, expected 16 bytes).`,
            errorType: 'INVALID_MEDIA',
            encryption: mediaEnc,
          };
        }
        logger.info(`[SegmentValidator] AES-128 key verified (16 bytes)`);
      } catch (keyErr: any) {
        return {
          valid: false,
          error: `Failed to retrieve encryption key: ${keyErr.message}`,
          errorType: 'NETWORK_ERROR',
          encryption: mediaEnc,
        };
      }
    }
  }

  // 5. Parse Media Playlist segments
  const mediaParsed = parseMediaPlaylist(mediaManifestContent, mediaBaseUrl);
  if (!mediaParsed.segments || mediaParsed.segments.length === 0) {
    return {
      valid: false,
      error: 'Media playlist has 0 segment entries (stream is empty or ended)',
      errorType: 'NO_MEDIA_FOUND',
      segmentCount: 0,
      encryption: mediaEnc,
    };
  }

  // 6. Test initial segments
  const segmentsToTest: string[] = [];
  if (mediaParsed.initSegmentUri) {
    segmentsToTest.push(mediaParsed.initSegmentUri);
  }
  const maxSegs = options?.maxSegmentsToTest ?? 1;
  for (let i = 0; i < Math.min(mediaParsed.segments.length, maxSegs); i++) {
    const seg = mediaParsed.segments[i];
    if (seg.uri && !segmentsToTest.includes(seg.uri)) {
      segmentsToTest.push(seg.uri);
    }
  }

  for (const segUrl of segmentsToTest) {
    if (!segUrl.startsWith('http://') && !segUrl.startsWith('https://')) {
      continue;
    }

    let attempt = 0;
    let lastError: Error | null = null;
    let lastStatus = 0;

    while (attempt <= maxRetries) {
      attempt++;
      try {
        // Use Range request for probe (first 64KB) to avoid downloading whole segment
        const probeHeaders = buildRequestHeaders(headers, cookies, 'bytes=0-65535');
        const segRes = await fetch(segUrl, {
          headers: probeHeaders,
          signal: AbortSignal.timeout(timeoutMs),
        });

        lastStatus = segRes.status;

        // Check for 401 / 403 (Expired token or forbidden)
        if (lastStatus === 401 || lastStatus === 403) {
          const isSigned = isSignedUrl(segUrl) || isSignedUrl(manifestUrl);
          const isExpired = isUrlExpired(segUrl) || isSigned;
          logger.warn(`[SegmentValidator] Segment returned HTTP ${lastStatus} for ${segUrl}`);
          return {
            valid: false,
            error: `Segment request failed: HTTP ${lastStatus} Forbidden/Unauthorized. URL token or session has expired.`,
            errorType: 'EXPIRED_URL',
            isExpiredUrl: isExpired,
            requiresRefresh: true,
            testedSegmentUrl: segUrl,
            testedStatusCode: lastStatus,
            segmentCount: mediaParsed.segments.length,
            encryption: mediaEnc,
          };
        }

        // Check for 404 (Missing segment)
        if (lastStatus === 404) {
          logger.warn(`[SegmentValidator] Segment returned HTTP 404 for ${segUrl}`);
          return {
            valid: false,
            error: 'Segment request returned HTTP 404 Not Found. Media segment is missing from server.',
            errorType: 'NO_MEDIA_FOUND',
            testedSegmentUrl: segUrl,
            testedStatusCode: 404,
            segmentCount: mediaParsed.segments.length,
            encryption: mediaEnc,
          };
        }

        // Check for 429 or 5xx (Transient server / rate limit error) -> Retry with backoff
        if (lastStatus === 429 || (lastStatus >= 500 && lastStatus <= 599)) {
          logger.warn(`[SegmentValidator] Segment returned HTTP ${lastStatus} (attempt ${attempt}/${maxRetries + 1})`);
          if (attempt <= maxRetries) {
            await new Promise(r => setTimeout(r, retryDelayMs * attempt));
            continue;
          }
          return {
            valid: false,
            error: `Segment request failed with HTTP ${lastStatus} (${lastStatus === 429 ? 'Rate Limited' : 'Server Error'})`,
            errorType: 'NETWORK_ERROR',
            testedSegmentUrl: segUrl,
            testedStatusCode: lastStatus,
            segmentCount: mediaParsed.segments.length,
            encryption: mediaEnc,
          };
        }

        if (!segRes.ok && segRes.status !== 206) {
          return {
            valid: false,
            error: `Segment request returned HTTP ${segRes.status}`,
            errorType: 'NETWORK_ERROR',
            testedSegmentUrl: segUrl,
            testedStatusCode: segRes.status,
            segmentCount: mediaParsed.segments.length,
            encryption: mediaEnc,
          };
        }

        // Fetch segment bytes
        const chunk = new Uint8Array(await segRes.arrayBuffer());

        // Check partial or empty segment
        if (chunk.length < 50) {
          return {
            valid: false,
            error: `Segment payload received is truncated or empty (${chunk.length} bytes)`,
            errorType: 'INVALID_MEDIA',
            testedSegmentUrl: segUrl,
            segmentCount: mediaParsed.segments.length,
            encryption: mediaEnc,
          };
        }

        // Validate bitstream signature and detect HTML errors
        const byteCheck = validateSegmentBytes(chunk, mediaEnc.isAes128);
        if (!byteCheck.valid) {
          return {
            valid: false,
            error: `Invalid segment payload: ${byteCheck.reason}`,
            errorType: 'INVALID_MEDIA',
            testedSegmentUrl: segUrl,
            segmentCount: mediaParsed.segments.length,
            encryption: mediaEnc,
          };
        }

        // Success on this segment!
        break;
      } catch (err: any) {
        lastError = err;
        const isTimeout = err.name === 'AbortError' || String(err).includes('timeout');
        const isConnReset = String(err).includes('ECONNRESET') || String(err).includes('connection reset');

        logger.warn(
          `[SegmentValidator] Segment request error (${isTimeout ? 'timeout' : isConnReset ? 'conn reset' : err.message}) on attempt ${attempt}/${maxRetries + 1}`
        );

        if (attempt <= maxRetries) {
          await new Promise(r => setTimeout(r, retryDelayMs * attempt));
          continue;
        }

        return {
          valid: false,
          error: `Segment download failed: ${err.message}`,
          errorType: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
          testedSegmentUrl: segUrl,
          segmentCount: mediaParsed.segments.length,
          encryption: mediaEnc,
        };
      }
    }
  }

  logger.info(
    `[SegmentValidator] Successfully validated stream segments (${mediaParsed.segments.length} segments, encryption: ${mediaEnc.primaryMethod})`
  );

  return {
    valid: true,
    encryption: mediaEnc,
    segmentCount: mediaParsed.segments.length,
  };
}
