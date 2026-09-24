import { normalizeMediaUrl } from './url-extractor.ts';
import { isSignedUrl } from './signed-url.ts';
import { HlsEncryptionAnalysis, HlsKeyTag, HlsEncryptionMethod } from '../types.ts';

export type HlsPlaylistType = 'MASTER' | 'MEDIA' | 'UNKNOWN';

export interface HlsByteRange {
  length: number;
  offset: number;
  raw: string;
}

export interface HlsInitSegment {
  uri: string;
  byteRange?: HlsByteRange;
}

export interface HlsSegmentItem {
  uri: string;
  duration?: number;
  title?: string;
  byteRange?: HlsByteRange;
  discontinuity?: boolean;
  programDateTime?: string;
  key?: HlsKeyTag;
  sequenceNumber?: number;
}

export interface HlsAudioGroup {
  groupId: string;
  name: string;
  type?: 'AUDIO';
  uri?: string;
  language?: string;
  isDefault: boolean;
  autoSelect: boolean;
  forced?: boolean;
  channels?: string;
  characteristics?: string;
}

export interface HlsSubtitleGroup {
  groupId: string;
  name: string;
  type?: 'SUBTITLES' | 'CLOSED-CAPTIONS';
  uri?: string;
  language?: string;
  isDefault: boolean;
  autoSelect: boolean;
  forced?: boolean;
}

export interface HlsVariant {
  uri: string;
  bandwidth?: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  resolution?: string; // e.g. "1280x720"
  codecs?: string;
  fps?: number;
  audioGroupId?: string;
  subtitleGroupId?: string;
  closedCaptions?: string;
  hdcpLevel?: string;
  audioTrackUri?: string;
  subtitleTrackUri?: string;
  isMasterPlaylist: boolean;
}

export interface MasterPlaylistParseResult {
  isMaster: true;
  type: 'MASTER';
  version?: number;
  independentSegments?: boolean;
  variants: HlsVariant[];
  audioGroups: HlsAudioGroup[];
  subtitleGroups: HlsSubtitleGroup[];
  sessionKeys?: HlsKeyTag[];
  selectedVariant?: HlsVariant;
}

export interface MediaPlaylistParseResult {
  isMaster: false;
  type: 'MEDIA';
  version?: number;
  targetDuration?: number;
  mediaSequence?: number;
  discontinuitySequence?: number;
  playlistType?: 'VOD' | 'EVENT';
  isLive: boolean;
  hasEndlist: boolean;
  initSegment?: HlsInitSegment;
  initSegmentUri?: string;
  segments: HlsSegmentItem[];
  keyTags: HlsKeyTag[];
  encryption: HlsEncryptionAnalysis;
  totalDuration: number;
}

export type HlsParseResult = MasterPlaylistParseResult | MediaPlaylistParseResult;

/**
 * Resolves an HLS URI (relative or absolute) against a manifest base URL.
 * Intelligently preserves and propagates query parameters (tokens, signatures, auth, expires)
 * from parent URLs while strictly preserving any segment-specific query parameters.
 *
 * Example:
 *   baseUrl:  https://cdn.example.com/hls/master.m3u8
 *   cleanUri: 720/playlist.m3u8
 *   Result:   https://cdn.example.com/hls/720/playlist.m3u8 (NOT https://cdn.example.com/720/playlist.m3u8)
 *
 *   cleanUri: segment.ts?token=abc&expires=123
 *   Result preserves token=abc and expires=123
 */
export function resolveHlsUri(uri: string, baseUrl?: string, preserveSignedParams = true): string {
  if (!uri || typeof uri !== 'string') return '';
  const cleanUri = uri.trim().replace(/^['"`]|['"`]$/g, '').replace(/\\/g, '');
  if (!cleanUri) return '';

  if (!baseUrl) {
    const normalized = normalizeMediaUrl(cleanUri);
    return normalized || cleanUri;
  }

  // If protocol-relative e.g. //cdn.com/seg.ts
  if (cleanUri.startsWith('//')) {
    return `https:${cleanUri}`;
  }

  // Ensure base URL directory path is properly formatted
  let normalizedBase = baseUrl.trim();
  try {
    const baseObj = new URL(normalizedBase);
    // If base pathname does not end with a slash and does not have a dot-extension,
    // ensure it is treated as a directory so relative paths do not strip the last path component
    const lastPart = baseObj.pathname.split('/').pop() || '';
    if (!baseObj.pathname.endsWith('/') && !lastPart.includes('.')) {
      baseObj.pathname = `${baseObj.pathname}/`;
      normalizedBase = baseObj.href;
    }
  } catch {}

  let resolved: URL;
  try {
    resolved = new URL(cleanUri, normalizedBase);
  } catch {
    const fallback = normalizeMediaUrl(cleanUri, normalizedBase);
    return fallback || cleanUri;
  }

  // Propagate query parameters from baseUrl if enabled
  if (preserveSignedParams && baseUrl.includes('?')) {
    try {
      const baseParsed = new URL(baseUrl);
      if (baseParsed.search) {
        for (const [key, value] of baseParsed.searchParams.entries()) {
          // Do not overwrite parameters that the segment already defines
          if (!resolved.searchParams.has(key)) {
            resolved.searchParams.set(key, value);
          }
        }
      }
    } catch {}
  }

  return resolved.href;
}

/**
 * Resolves a segment URI strictly against its containing Media Playlist URL.
 * Guarantees that segment paths are resolved relative to the actual variant playlist,
 * not the parent master playlist.
 */
export function resolveSegmentAgainstMediaPlaylist(
  segmentUri: string,
  mediaPlaylistUrl: string,
  preserveParams = true
): string {
  return resolveHlsUri(segmentUri, mediaPlaylistUrl, preserveParams);
}

/**
 * Parses key=value attributes in HLS tags, handling quotes and commas inside quotes
 * e.g. BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
 */
export function parseHlsAttributes(attrString: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!attrString) return result;

  const regex = /([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]+))/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(attrString)) !== null) {
    const key = match[1].toUpperCase();
    const val = match[2] !== undefined ? match[2] : match[3];
    result[key] = (val || '').trim();
  }

  return result;
}

/**
 * Parses a byte range specification: length[@offset]
 * RFC 8216 Section 4.3.2.2 #EXT-X-BYTERANGE
 */
export function parseByteRange(
  raw: string,
  lastEndOffset = 0
): { byteRange: HlsByteRange; nextOffset: number } {
  const clean = raw.trim();
  const parts = clean.split('@');
  const length = parseInt(parts[0], 10) || 0;
  const offset = parts.length > 1 ? parseInt(parts[1], 10) : lastEndOffset;

  return {
    byteRange: {
      length,
      offset: isNaN(offset) ? 0 : offset,
      raw: clean,
    },
    nextOffset: (isNaN(offset) ? 0 : offset) + length,
  };
}

/**
 * Parses a single #EXT-X-KEY or #EXT-X-SESSION-KEY tag line into structured HlsKeyTag
 */
export function parseHlsKeyTag(tagLine: string): HlsKeyTag {
  const clean = tagLine.replace(/^#(?:EXT-X-KEY|EXT-X-SESSION-KEY):/i, '');
  const attrs = parseHlsAttributes(clean);

  return {
    method: (attrs['METHOD'] || 'NONE').toUpperCase(),
    uri: attrs['URI'] || undefined,
    iv: attrs['IV'] || undefined,
    keyFormat: attrs['KEYFORMAT'] || undefined,
    keyFormatVersions: attrs['KEYFORMATVERSIONS'] || undefined,
    rawTag: tagLine,
  };
}

/**
 * Accurately determines if an M3U8 manifest is a MASTER PLAYLIST, a MEDIA PLAYLIST, or UNKNOWN.
 *
 * Distinct roles:
 * MASTER PLAYLIST:
 *   Contains tags defining stream variants (#EXT-X-STREAM-INF), audio/subtitle renditions (#EXT-X-MEDIA),
 *   or session data (#EXT-X-SESSION-DATA, #EXT-X-SESSION-KEY).
 * MEDIA PLAYLIST (VARIANT PLAYLIST):
 *   Contains media segment references (#EXTINF), initialization segment (#EXT-X-MAP),
 *   playback duration/sequence control (#EXT-X-TARGETDURATION, #EXT-X-MEDIA-SEQUENCE, #EXT-X-ENDLIST).
 */
export function detectPlaylistType(manifestContent: string): HlsPlaylistType {
  if (!manifestContent) return 'UNKNOWN';

  const lines = manifestContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let hasMasterTags = false;
  let hasMediaTags = false;

  for (const line of lines) {
    if (
      line.startsWith('#EXT-X-STREAM-INF:') ||
      line.startsWith('#EXT-X-I-FRAME-STREAM-INF:') ||
      line.startsWith('#EXT-X-SESSION-DATA:') ||
      line.startsWith('#EXT-X-SESSION-KEY:')
    ) {
      hasMasterTags = true;
      break;
    }

    if (line.startsWith('#EXT-X-MEDIA:') && (line.includes('TYPE=AUDIO') || line.includes('TYPE=SUBTITLES') || line.includes('TYPE=CLOSED-CAPTIONS'))) {
      hasMasterTags = true;
    }

    if (
      line.startsWith('#EXTINF:') ||
      line.startsWith('#EXT-X-TARGETDURATION:') ||
      line.startsWith('#EXT-X-MEDIA-SEQUENCE:') ||
      line.startsWith('#EXT-X-ENDLIST') ||
      line.startsWith('#EXT-X-MAP:') ||
      line.startsWith('#EXT-X-BYTERANGE:') ||
      line.startsWith('#EXT-X-DISCONTINUITY')
    ) {
      hasMediaTags = true;
    }
  }

  if (hasMasterTags) return 'MASTER';
  if (hasMediaTags) return 'MEDIA';

  // Fallback: check if lines without comments resemble segment files (.ts, .m4s, .mp4, .aac)
  const nonCommentLines = lines.filter(l => !l.startsWith('#'));
  if (nonCommentLines.some(l => /\.(ts|m4s|mp4|aac|m4a)(\?|#|$)/i.test(l))) {
    return 'MEDIA';
  }
  if (nonCommentLines.some(l => /\.m3u8(\?|#|$)/i.test(l))) {
    return 'MASTER';
  }

  return 'UNKNOWN';
}

/**
 * Checks if a string looks like an HLS manifest content
 */
export function isManifestContent(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return (
    trimmed.startsWith('#EXTM3U') ||
    trimmed.includes('#EXT-X-STREAM-INF') ||
    trimmed.includes('#EXT-X-TARGETDURATION') ||
    trimmed.includes('#EXTINF:') ||
    trimmed.includes('#EXT-X-MEDIA:')
  );
}

/**
 * Analyzes HLS manifest content for #EXT-X-KEY and #EXT-X-SESSION-KEY tags.
 * Accurately distinguishes between:
 * - Unencrypted (NONE)
 * - AES-128 (Envelope encryption, supported with key)
 * - SAMPLE-AES (Sample-level encryption, unsupported without specialized decrypters)
 * - DRM (Widevine, FairPlay, PlayReady, ClearKey - strictly reported and halted)
 */
export function detectHlsEncryption(manifestContent: string): HlsEncryptionAnalysis {
  if (!manifestContent) {
    return {
      hasEncryption: false,
      primaryMethod: 'NONE',
      isDrm: false,
      isSampleAes: false,
      isAes128: false,
      isSupported: true,
      keys: [],
    };
  }

  const lines = manifestContent.split(/\r?\n/).map(l => l.trim());
  const keys: HlsKeyTag[] = [];

  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const keyTag = parseHlsKeyTag(line);
      keys.push(keyTag);
    }
  }

  if (keys.length === 0) {
    return {
      hasEncryption: false,
      primaryMethod: 'NONE',
      isDrm: false,
      isSampleAes: false,
      isAes128: false,
      isSupported: true,
      keys: [],
    };
  }

  // Filter out explicit METHOD=NONE
  const encryptedKeys = keys.filter(k => k.method !== 'NONE');
  if (encryptedKeys.length === 0) {
    return {
      hasEncryption: false,
      primaryMethod: 'NONE',
      isDrm: false,
      isSampleAes: false,
      isAes128: false,
      isSupported: true,
      keys,
    };
  }

  // Inspect first active encryption tag
  const primary = encryptedKeys[0];
  const methodUpper = primary.method.toUpperCase();
  const kfLower = (primary.keyFormat || '').toLowerCase();
  const uriLower = (primary.uri || '').toLowerCase();

  // 1. Check for DRM indicators
  let isDrm = false;
  let drmSystem: HlsEncryptionAnalysis['drmSystem'];

  if (
    kfLower.includes('widevine') ||
    kfLower.includes('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed') ||
    uriLower.startsWith('widevine://')
  ) {
    isDrm = true;
    drmSystem = 'Widevine';
  } else if (
    kfLower.includes('streamingkeydelivery') ||
    kfLower.includes('fairplay') ||
    uriLower.startsWith('skd://')
  ) {
    isDrm = true;
    drmSystem = 'FairPlay';
  } else if (
    kfLower.includes('playready') ||
    kfLower.includes('9a04f079-9840-4286-ab92-e65be0885f95')
  ) {
    isDrm = true;
    drmSystem = 'PlayReady';
  } else if (
    kfLower.includes('clearkey') ||
    kfLower.includes('1077efec-c0b2-4d02-ace3-3c1e52e2fb4b')
  ) {
    isDrm = true;
    drmSystem = 'ClearKey';
  } else if (
    methodUpper === 'SAMPLE-AES-CTR' ||
    methodUpper === 'SAMPLE-AES-CENC' ||
    methodUpper === 'ISO-23001-7'
  ) {
    isDrm = true;
    drmSystem = 'Generic DRM';
  }

  if (isDrm) {
    return {
      hasEncryption: true,
      primaryMethod: 'DRM',
      isDrm: true,
      isSampleAes: false,
      isAes128: false,
      isSupported: false,
      drmSystem,
      keyFormat: primary.keyFormat,
      keyUri: primary.uri,
      reason: `DRM Protection detected (${drmSystem || 'Proprietary DRM'}). Content is protected with digital rights management encryption and requires license credentials that are unavailable. DRM cannot be bypassed.`,
      keys,
    };
  }

  // 2. Check for SAMPLE-AES
  if (methodUpper === 'SAMPLE-AES') {
    return {
      hasEncryption: true,
      primaryMethod: 'SAMPLE-AES',
      isDrm: false,
      isSampleAes: true,
      isAes128: false,
      isSupported: false,
      keyFormat: primary.keyFormat,
      keyUri: primary.uri,
      reason: 'SAMPLE-AES encryption detected. Sample-level encrypted streams are not supported by standard FFmpeg/remuxing pipelines and require custom decrypters.',
      keys,
    };
  }

  // 3. Check for standard AES-128
  if (methodUpper === 'AES-128') {
    const isIdentity = !primary.keyFormat || primary.keyFormat.toLowerCase() === 'identity';
    if (isIdentity) {
      return {
        hasEncryption: true,
        primaryMethod: 'AES-128',
        isDrm: false,
        isSampleAes: false,
        isAes128: true,
        isSupported: true,
        keyFormat: primary.keyFormat || 'identity',
        keyUri: primary.uri,
        keys,
      };
    } else {
      return {
        hasEncryption: true,
        primaryMethod: 'AES-128',
        isDrm: true,
        isSampleAes: false,
        isAes128: true,
        isSupported: false,
        drmSystem: 'Generic DRM',
        keyFormat: primary.keyFormat,
        keyUri: primary.uri,
        reason: `AES-128 with proprietary key format (${primary.keyFormat}) detected. Requires external license server credentials.`,
        keys,
      };
    }
  }

  // 4. Unknown encryption
  return {
    hasEncryption: true,
    primaryMethod: 'UNKNOWN',
    isDrm: false,
    isSampleAes: false,
    isAes128: false,
    isSupported: false,
    keyFormat: primary.keyFormat,
    keyUri: primary.uri,
    reason: `Unsupported encryption method: ${primary.method}. Cannot process stream.`,
    keys,
  };
}

/**
 * Parses HLS Master Playlist (#EXT-X-STREAM-INF, #EXT-X-MEDIA, #EXT-X-VERSION)
 * Extracts all variant streams, audio groups, and subtitle groups.
 */
export function parseMasterPlaylist(
  manifestContent: string,
  manifestBaseUrl: string
): MasterPlaylistParseResult {
  const lines = manifestContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const variants: HlsVariant[] = [];
  const audioGroups: HlsAudioGroup[] = [];
  const subtitleGroups: HlsSubtitleGroup[] = [];
  const sessionKeys: HlsKeyTag[] = [];

  let isMaster = false;
  let version: number | undefined;
  let independentSegments: boolean | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-VERSION:')) {
      const v = parseInt(line.replace('#EXT-X-VERSION:', '').trim(), 10);
      if (!isNaN(v)) version = v;
      continue;
    }

    if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
      independentSegments = true;
      continue;
    }

    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      isMaster = true;
      sessionKeys.push(parseHlsKeyTag(line));
      continue;
    }

    // Detect Audio Groups: #EXT-X-MEDIA:TYPE=AUDIO,...
    if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
      isMaster = true;
      const attributes = parseHlsAttributes(line.replace('#EXT-X-MEDIA:', ''));
      const groupId = attributes['GROUP-ID'] || '';
      const name = attributes['NAME'] || '';
      const uriRaw = attributes['URI'];
      const uri = uriRaw ? resolveHlsUri(uriRaw, manifestBaseUrl) : undefined;
      const language = attributes['LANGUAGE'];
      const isDefault = attributes['DEFAULT'] === 'YES';
      const autoSelect = attributes['AUTOSELECT'] === 'YES';
      const forced = attributes['FORCED'] === 'YES';
      const channels = attributes['CHANNELS'];
      const characteristics = attributes['CHARACTERISTICS'];

      if (groupId) {
        audioGroups.push({
          groupId,
          name,
          type: 'AUDIO',
          uri,
          language,
          isDefault,
          autoSelect,
          forced,
          channels,
          characteristics,
        });
      }
      continue;
    }

    // Detect Subtitle Groups: #EXT-X-MEDIA:TYPE=SUBTITLES,... or CLOSED-CAPTIONS
    if (line.startsWith('#EXT-X-MEDIA:') && (line.includes('TYPE=SUBTITLES') || line.includes('TYPE=CLOSED-CAPTIONS'))) {
      isMaster = true;
      const attributes = parseHlsAttributes(line.replace('#EXT-X-MEDIA:', ''));
      const groupId = attributes['GROUP-ID'] || '';
      const name = attributes['NAME'] || '';
      const uriRaw = attributes['URI'];
      const uri = uriRaw ? resolveHlsUri(uriRaw, manifestBaseUrl) : undefined;
      const language = attributes['LANGUAGE'];
      const isDefault = attributes['DEFAULT'] === 'YES';
      const autoSelect = attributes['AUTOSELECT'] === 'YES';
      const forced = attributes['FORCED'] === 'YES';
      const type = line.includes('TYPE=SUBTITLES') ? 'SUBTITLES' : 'CLOSED-CAPTIONS';

      if (groupId) {
        subtitleGroups.push({
          groupId,
          name,
          type,
          uri,
          language,
          isDefault,
          autoSelect,
          forced,
        });
      }
      continue;
    }

    // Detect Stream Variants: #EXT-X-STREAM-INF:...
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      const attributes = parseHlsAttributes(line.replace('#EXT-X-STREAM-INF:', ''));

      // The next non-comment line is the URI for this stream
      let streamUri = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) {
          streamUri = lines[j];
          i = j; // Advance outer loop
          break;
        }
      }

      if (streamUri) {
        const absUri = resolveHlsUri(streamUri, manifestBaseUrl);
        if (absUri) {
          const bandwidth = attributes['BANDWIDTH'] ? parseInt(attributes['BANDWIDTH'], 10) : undefined;
          const averageBandwidth = attributes['AVERAGE-BANDWIDTH'] ? parseInt(attributes['AVERAGE-BANDWIDTH'], 10) : undefined;
          const codecs = attributes['CODECS'];
          const audioGroupId = attributes['AUDIO'];
          const subtitleGroupId = attributes['SUBTITLES'];
          const closedCaptions = attributes['CLOSED-CAPTIONS'];
          const hdcpLevel = attributes['HDCP-LEVEL'];

          let width: number | undefined;
          let height: number | undefined;
          const resolution = attributes['RESOLUTION'];
          if (resolution) {
            const resParts = resolution.split('x').map(Number);
            if (resParts.length === 2 && resParts[0] && resParts[1]) {
              width = resParts[0];
              height = resParts[1];
            }
          }

          let fps: number | undefined;
          if (attributes['FRAME-RATE']) {
            fps = Math.round(parseFloat(attributes['FRAME-RATE']));
          }

          variants.push({
            uri: absUri,
            bandwidth,
            averageBandwidth,
            width,
            height,
            resolution,
            codecs,
            fps,
            audioGroupId,
            subtitleGroupId,
            closedCaptions,
            hdcpLevel,
            isMasterPlaylist: true,
          });
        }
      }
    }
  }

  // Associate audio and subtitle tracks with variants based on matching group ID
  for (const variant of variants) {
    if (variant.audioGroupId) {
      const matchingAudio = audioGroups.find(
        ag => ag.groupId === variant.audioGroupId && (ag.isDefault || ag.autoSelect || ag.uri)
      );
      if (matchingAudio?.uri) {
        variant.audioTrackUri = matchingAudio.uri;
      }
    }
    if (variant.subtitleGroupId) {
      const matchingSub = subtitleGroups.find(
        sg => sg.groupId === variant.subtitleGroupId && (sg.isDefault || sg.autoSelect || sg.uri)
      );
      if (matchingSub?.uri) {
        variant.subtitleTrackUri = matchingSub.uri;
      }
    }
  }

  const selectedVariant = selectTargetVariant(variants, 720);

  return {
    isMaster: true,
    type: 'MASTER',
    version,
    independentSegments,
    variants,
    audioGroups,
    subtitleGroups,
    sessionKeys,
    selectedVariant,
  };
}

/**
 * Parses an HLS Media Playlist (Variant Playlist)
 * Handles:
 * - #EXTM3U
 * - #EXTINF (duration & title)
 * - #EXT-X-TARGETDURATION (maximum duration)
 * - #EXT-X-MEDIA-SEQUENCE (starting sequence number)
 * - #EXT-X-DISCONTINUITY-SEQUENCE
 * - #EXT-X-ENDLIST (VOD vs live sliding window)
 * - #EXT-X-PLAYLIST-TYPE (VOD or EVENT)
 * - #EXT-X-DISCONTINUITY (discontinuity flag on segment)
 * - #EXT-X-MAP (initialization segment URI and byte range)
 * - #EXT-X-BYTERANGE (length[@offset] with sequential tracking)
 * - #EXT-X-KEY (active key propagation across subsequent segments)
 * - #EXT-X-PROGRAM-DATE-TIME (wall-clock timestamp)
 */
export function parseMediaPlaylist(
  manifestContent: string,
  manifestBaseUrl: string
): MediaPlaylistParseResult {
  const lines = manifestContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const segments: HlsSegmentItem[] = [];
  const keyTags: HlsKeyTag[] = [];

  let version: number | undefined;
  let targetDuration: number | undefined;
  let mediaSequence = 0;
  let discontinuitySequence = 0;
  let playlistType: 'VOD' | 'EVENT' | undefined;
  let hasEndlist = false;

  let initSegment: HlsInitSegment | undefined;

  let currentDuration: number | undefined;
  let currentTitle: string | undefined;
  let currentByteRange: HlsByteRange | undefined;
  let currentDiscontinuity = false;
  let currentProgramDateTime: string | undefined;
  let currentActiveKey: HlsKeyTag | undefined;

  let byteRangeOffset = 0;
  let segmentIndex = 0;
  let totalDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-VERSION:')) {
      const v = parseInt(line.replace('#EXT-X-VERSION:', '').trim(), 10);
      if (!isNaN(v)) version = v;
      continue;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const val = parseInt(line.replace('#EXT-X-TARGETDURATION:', '').trim(), 10);
      if (!isNaN(val)) targetDuration = val;
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const val = parseInt(line.replace('#EXT-X-MEDIA-SEQUENCE:', '').trim(), 10);
      if (!isNaN(val)) mediaSequence = val;
      continue;
    }

    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      const val = parseInt(line.replace('#EXT-X-DISCONTINUITY-SEQUENCE:', '').trim(), 10);
      if (!isNaN(val)) discontinuitySequence = val;
      continue;
    }

    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      const typeStr = line.replace('#EXT-X-PLAYLIST-TYPE:', '').trim().toUpperCase();
      if (typeStr === 'VOD' || typeStr === 'EVENT') {
        playlistType = typeStr;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndlist = true;
      continue;
    }

    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      currentDiscontinuity = true;
      continue;
    }

    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      currentProgramDateTime = line.replace('#EXT-X-PROGRAM-DATE-TIME:', '').trim();
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseHlsAttributes(line.replace('#EXT-X-MAP:', ''));
      if (attrs['URI']) {
        const initUri = resolveHlsUri(attrs['URI'], manifestBaseUrl);
        let initRange: HlsByteRange | undefined;
        if (attrs['BYTERANGE']) {
          const parsedRange = parseByteRange(attrs['BYTERANGE'], 0);
          initRange = parsedRange.byteRange;
        }
        initSegment = {
          uri: initUri,
          byteRange: initRange,
        };
      }
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const keyTag = parseHlsKeyTag(line);
      keyTags.push(keyTag);
      currentActiveKey = keyTag;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const raw = line.replace('#EXT-X-BYTERANGE:', '').trim();
      const parsedRange = parseByteRange(raw, byteRangeOffset);
      currentByteRange = parsedRange.byteRange;
      byteRangeOffset = parsedRange.nextOffset;
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const parts = line.replace('#EXTINF:', '').split(',');
      const dur = parseFloat(parts[0]);
      if (!isNaN(dur)) {
        currentDuration = dur;
        totalDuration += dur;
      }
      if (parts.length > 1) {
        currentTitle = parts.slice(1).join(',');
      }
      continue;
    }

    // A non-comment line is a segment URI
    if (!line.startsWith('#')) {
      const absUri = resolveHlsUri(line, manifestBaseUrl);
      if (absUri) {
        segments.push({
          uri: absUri,
          duration: currentDuration,
          title: currentTitle,
          byteRange: currentByteRange,
          discontinuity: currentDiscontinuity ? true : undefined,
          programDateTime: currentProgramDateTime,
          key: currentActiveKey,
          sequenceNumber: mediaSequence + segmentIndex,
        });
        segmentIndex++;
      }
      currentDuration = undefined;
      currentTitle = undefined;
      currentByteRange = undefined;
      currentDiscontinuity = false;
      currentProgramDateTime = undefined;
    }
  }

  const encryption = detectHlsEncryption(manifestContent);
  const isLive = !hasEndlist && playlistType !== 'VOD';

  return {
    isMaster: false,
    type: 'MEDIA',
    version,
    targetDuration,
    mediaSequence,
    discontinuitySequence,
    playlistType,
    isLive,
    hasEndlist,
    initSegment,
    initSegmentUri: initSegment?.uri,
    segments,
    keyTags,
    encryption,
    totalDuration: Math.round(totalDuration * 100) / 100,
  };
}

/**
 * Universal HLS Manifest Parser.
 * Automatically discriminates between MASTER PLAYLIST and MEDIA PLAYLIST,
 * returning structured, fully inspected variant or segment trees.
 */
export function parseHlsManifest(
  manifestContent: string,
  manifestBaseUrl: string
): HlsParseResult {
  const type = detectPlaylistType(manifestContent);

  if (type === 'MASTER') {
    return parseMasterPlaylist(manifestContent, manifestBaseUrl);
  }

  return parseMediaPlaylist(manifestContent, manifestBaseUrl);
}

/**
 * Selects the optimal variant based on target policy:
 * - Default maximum 720p height
 * - Prioritize variants with height <= 720 (highest bandwidth amongst <= 720p)
 * - If no variant is <= 720p, choose closest variant (lowest above 720p)
 * - NEVER automatically pick 1080p/1440p/2160p when 720p or lower is available.
 */
export function selectTargetVariant(variants: HlsVariant[], maxTargetHeight = 720): HlsVariant | undefined {
  if (!variants || variants.length === 0) return undefined;
  if (variants.length === 1) return variants[0];

  const withHeight = variants.filter(v => v.height && v.height > 0);

  if (withHeight.length > 0) {
    // 1. Variants that comply with <= maxTargetHeight (e.g. 720p, 480p, 360p)
    const compliant = withHeight.filter(v => (v.height || 0) <= maxTargetHeight);

    if (compliant.length > 0) {
      // Priority 1: Height descending (prefer 720p over 480p over 360p)
      // Priority 2: Bandwidth descending (highest quality within chosen resolution)
      compliant.sort((a, b) => {
        const heightDiff = (b.height || 0) - (a.height || 0);
        if (heightDiff !== 0) return heightDiff;
        return (b.bandwidth || 0) - (a.bandwidth || 0);
      });
      return compliant[0];
    }

    // 2. If NO variants are <= 720p: choose closest variant (lowest height above 720p)
    withHeight.sort((a, b) => {
      const heightDiff = (a.height || 0) - (b.height || 0);
      if (heightDiff !== 0) return heightDiff;
      return (a.bandwidth || 0) - (b.bandwidth || 0);
    });
    return withHeight[0];
  }

  // If no resolution tags available, sort by bandwidth (moderate bandwidth preferred ~2.5Mbps)
  const withBandwidth = [...variants].filter(v => v.bandwidth && v.bandwidth > 0);
  if (withBandwidth.length > 0) {
    withBandwidth.sort((a, b) => {
      const diffA = Math.abs((a.bandwidth || 0) - 2500000);
      const diffB = Math.abs((b.bandwidth || 0) - 2500000);
      return diffA - diffB;
    });
    return withBandwidth[0];
  }

  return variants[0];
}
