const URL_REGEX = /https?:\/\/[^\s<>"'()]+(?:\([^\s<>"']+\)|[^\s<>"'.,:;!?[\]])/gi;

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

export function analyzeUrl(url: string): DetectedUrl {
  const lower = url.toLowerCase();
  const pathname = new URL(url).pathname.toLowerCase();

  const isDirectM3u8 = pathname.endsWith('.m3u8') || lower.includes('.m3u8?') || lower.includes('.m3u8&');
  const isDirectMpd = pathname.endsWith('.mpd') || lower.includes('.mpd?') || lower.includes('.mpd&');
  const isDirectVideo =
    pathname.endsWith('.mp4') ||
    pathname.endsWith('.mkv') ||
    pathname.endsWith('.webm') ||
    pathname.endsWith('.ts') ||
    pathname.endsWith('.mov') ||
    pathname.endsWith('.avi');

  return {
    url,
    isDirectM3u8,
    isDirectMpd,
    isDirectVideo,
  };
}
