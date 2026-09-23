import { normalizeMediaUrl } from './url-extractor.ts';

export interface HlsAudioGroup {
  groupId: string;
  name: string;
  uri?: string;
  language?: string;
  isDefault: boolean;
  autoSelect: boolean;
}

export interface HlsSubtitleGroup {
  groupId: string;
  name: string;
  uri?: string;
  language?: string;
  isDefault: boolean;
  autoSelect: boolean;
}

export interface HlsVariant {
  uri: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  resolution?: string; // e.g. "1280x720"
  codecs?: string;
  fps?: number;
  audioGroupId?: string;
  subtitleGroupId?: string;
  audioTrackUri?: string;
  isMasterPlaylist: boolean;
}

export interface MasterPlaylistParseResult {
  isMaster: boolean;
  variants: HlsVariant[];
  audioGroups: HlsAudioGroup[];
  subtitleGroups: HlsSubtitleGroup[];
  selectedVariant?: HlsVariant;
}

/**
 * Parses HLS Master Playlist (#EXT-X-STREAM-INF, #EXT-X-MEDIA:TYPE=AUDIO, #EXT-X-MEDIA:TYPE=SUBTITLES)
 * and extracts all variant streams and audio groups.
 */
export function parseMasterPlaylist(
  manifestContent: string,
  manifestBaseUrl: string
): MasterPlaylistParseResult {
  const lines = manifestContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const variants: HlsVariant[] = [];
  const audioGroups: HlsAudioGroup[] = [];
  const subtitleGroups: HlsSubtitleGroup[] = [];

  let isMaster = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect Audio Groups: #EXT-X-MEDIA:TYPE=AUDIO,...
    if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
      isMaster = true;
      const attributes = parseHlsAttributes(line.replace('#EXT-X-MEDIA:', ''));
      const groupId = attributes['GROUP-ID'] || '';
      const name = attributes['NAME'] || '';
      const uriRaw = attributes['URI'];
      const uri = uriRaw ? normalizeMediaUrl(uriRaw, manifestBaseUrl) || undefined : undefined;
      const language = attributes['LANGUAGE'];
      const isDefault = attributes['DEFAULT'] === 'YES';
      const autoSelect = attributes['AUTOSELECT'] === 'YES';

      if (groupId) {
        audioGroups.push({
          groupId,
          name,
          uri,
          language,
          isDefault,
          autoSelect,
        });
      }
    }

    // Detect Subtitle Groups: #EXT-X-MEDIA:TYPE=SUBTITLES,...
    if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=SUBTITLES')) {
      isMaster = true;
      const attributes = parseHlsAttributes(line.replace('#EXT-X-MEDIA:', ''));
      const groupId = attributes['GROUP-ID'] || '';
      const name = attributes['NAME'] || '';
      const uriRaw = attributes['URI'];
      const uri = uriRaw ? normalizeMediaUrl(uriRaw, manifestBaseUrl) || undefined : undefined;
      const language = attributes['LANGUAGE'];
      const isDefault = attributes['DEFAULT'] === 'YES';
      const autoSelect = attributes['AUTOSELECT'] === 'YES';

      if (groupId) {
        subtitleGroups.push({
          groupId,
          name,
          uri,
          language,
          isDefault,
          autoSelect,
        });
      }
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
        const absUri = normalizeMediaUrl(streamUri, manifestBaseUrl);
        if (absUri) {
          const bandwidth = attributes['BANDWIDTH'] ? parseInt(attributes['BANDWIDTH'], 10) : undefined;
          const codecs = attributes['CODECS'];
          const audioGroupId = attributes['AUDIO'];
          const subtitleGroupId = attributes['SUBTITLES'];

          let width: number | undefined;
          let height: number | undefined;
          let resolution = attributes['RESOLUTION'];
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
            width,
            height,
            resolution,
            codecs,
            fps,
            audioGroupId,
            subtitleGroupId,
            isMasterPlaylist: true,
          });
        }
      }
    }
  }

  // Associate audio track URIs with variants based on matching audio group ID
  for (const variant of variants) {
    if (variant.audioGroupId) {
      const matchingAudio = audioGroups.find(
        ag => ag.groupId === variant.audioGroupId && (ag.isDefault || ag.autoSelect || ag.uri)
      );
      if (matchingAudio?.uri) {
        variant.audioTrackUri = matchingAudio.uri;
      }
    }
  }

  const selectedVariant = selectTargetVariant(variants, 720);

  return {
    isMaster,
    variants,
    audioGroups,
    subtitleGroups,
    selectedVariant,
  };
}

/**
 * Parses key=value attributes in HLS tags, handling quotes and commas inside quotes
 * e.g. BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
 */
function parseHlsAttributes(attrString: string): Record<string, string> {
  const result: Record<string, string> = {};
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
 * Selects the optimal variant based on target policy:
 * - Default maximum 720p height
 * - Prioritize variants with height <= 720 (highest bandwidth amongst <= 720p)
 * - If no variant is <= 720p, choose the closest variant (lowest above 720p)
 * - NEVER automatically pick 1080p/1440p/2160p when 720p or lower is available.
 */
export function selectTargetVariant(variants: HlsVariant[], maxTargetHeight = 720): HlsVariant | undefined {
  if (!variants || variants.length === 0) return undefined;
  if (variants.length === 1) return variants[0];

  // Separate variants with known heights and unknown heights
  const withHeight = variants.filter(v => v.height && v.height > 0);

  if (withHeight.length > 0) {
    // 1. Variants that comply with <= maxTargetHeight (e.g. 720p, 480p, 360p)
    const compliant = withHeight.filter(v => (v.height || 0) <= maxTargetHeight);

    if (compliant.length > 0) {
      // Sort compliant variants:
      // Priority 1: Height descending (prefer 720p over 480p over 360p)
      // Priority 2: Bandwidth descending (highest quality within chosen resolution)
      compliant.sort((a, b) => {
        const heightDiff = (b.height || 0) - (a.height || 0);
        if (heightDiff !== 0) return heightDiff;
        return (b.bandwidth || 0) - (a.bandwidth || 0);
      });
      return compliant[0];
    }

    // 2. If NO variants are <= 720p (e.g. all are 1080p, 1440p, 4K):
    // Choose the closest variant (lowest height above 720p)
    withHeight.sort((a, b) => {
      const heightDiff = (a.height || 0) - (b.height || 0);
      if (heightDiff !== 0) return heightDiff;
      return (a.bandwidth || 0) - (b.bandwidth || 0);
    });
    return withHeight[0];
  }

  // If no resolution tags available, sort by bandwidth (moderate bandwidth preferred)
  const withBandwidth = [...variants].filter(v => v.bandwidth && v.bandwidth > 0);
  if (withBandwidth.length > 0) {
    // Target approx 2.5 Mbps (~720p) or closest
    withBandwidth.sort((a, b) => {
      const diffA = Math.abs((a.bandwidth || 0) - 2500000);
      const diffB = Math.abs((b.bandwidth || 0) - 2500000);
      return diffA - diffB;
    });
    return withBandwidth[0];
  }

  return variants[0];
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
    trimmed.includes('#EXTINF:')
  );
}
