import { logger } from '../logger.ts';

export interface TranslationResult {
  originalTitle: string;
  translatedTitle: string;
  detectedLanguage?: string;
  translationStatus: 'not_needed' | 'translated' | 'failed';
}

/**
 * Common Indonesian word markers to quickly check if a title is already Indonesian
 */
const INDONESIAN_WORDS = new Set([
  'dan', 'di', 'ke', 'dari', 'yang', 'ini', 'itu', 'untuk', 'dengan', 'pada',
  'adalah', 'sebagai', 'dalam', 'bisa', 'akan', 'sudah', 'tidak', 'lagi',
  'video', 'terbaru', 'hari', 'saat', 'cara', 'kenapa', 'mengapa', 'karena',
  'viral', 'heboh', 'lucu', 'detik', 'jam', 'orang', 'anak', 'kasus',
  'banget', 'bikin', 'ngakak', 'mantap', 'nih', 'dong', 'yuk', 'lagu',
]);

export function isLikelyIndonesian(text: string): boolean {
  if (!text) return false;
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  let matchCount = 0;
  for (const w of words) {
    if (INDONESIAN_WORDS.has(w)) {
      matchCount++;
    }
  }

  // If at least 2 common Indonesian words match or > 25% of words are Indonesian
  return matchCount >= 2 || (words.length > 0 && matchCount / words.length >= 0.25);
}

/**
 * Protects channel names, mentions (@user), hashtags (#tag), and bracketed codes
 */
function preprocessTitle(title: string): { cleanText: string; tokens: Map<string, string> } {
  const tokens = new Map<string, string>();
  let counter = 0;

  // Protect @mentions and #hashtags
  const protectedText = title.replace(/([@#][a-zA-Z0-9_]+)/g, match => {
    const placeholder = `__PH_${counter++}__`;
    tokens.set(placeholder, match);
    return placeholder;
  });

  return { cleanText: protectedText, tokens };
}

function restoreTokens(text: string, tokens: Map<string, string>): string {
  let restored = text;
  for (const [placeholder, original] of tokens.entries()) {
    restored = restored.split(placeholder).join(original);
  }
  return restored;
}

/**
 * Translates foreign titles to Indonesian, preserving original if already Indonesian.
 */
export async function ensureIndonesianTitle(
  originalTitle?: string,
  alternativeTitle?: string
): Promise<TranslationResult> {
  const cleanOriginal = (originalTitle || '').trim();

  if (!cleanOriginal) {
    return {
      originalTitle: '',
      translatedTitle: '',
      translationStatus: 'not_needed',
    };
  }

  // 1. Check if already Indonesian
  if (isLikelyIndonesian(cleanOriginal)) {
    return {
      originalTitle: cleanOriginal,
      translatedTitle: cleanOriginal,
      detectedLanguage: 'id',
      translationStatus: 'not_needed',
    };
  }

  // 2. Attempt Google Translate API with timeout
  try {
    const { cleanText, tokens } = preprocessTitle(cleanOriginal);
    const query = encodeURIComponent(cleanText);
    const apiUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=id&dt=t&q=${query}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const detectedLang = data[2] || '';
      
      // If language was detected as Indonesian
      if (detectedLang === 'id' || detectedLang === 'ms') {
        return {
          originalTitle: cleanOriginal,
          translatedTitle: cleanOriginal,
          detectedLanguage: detectedLang,
          translationStatus: 'not_needed',
        };
      }

      // Extract translated parts
      if (Array.isArray(data[0])) {
        const translatedParts = data[0]
          .map((item: any) => (item && item[0] ? item[0] : ''))
          .filter(Boolean)
          .join('');

        if (translatedParts) {
          const finalTitle = restoreTokens(translatedParts, tokens).trim();
          return {
            originalTitle: cleanOriginal,
            translatedTitle: finalTitle,
            detectedLanguage: detectedLang,
            translationStatus: 'translated',
          };
        }
      }
    }
  } catch (err: any) {
    logger.warn(`Translation service failed for title "${cleanOriginal.slice(0, 30)}...":`, err.message || err);
  }

  // 2b. Graceful dictionary fallback if network/API is unreachable
  const DICT: Record<string, string> = {
    amazing: 'Menakjubkan',
    nature: 'Alam',
    footage: 'Rekaman',
    switzerland: 'Swiss',
    official: 'Resmi',
    documentary: 'Dokumenter',
    movie: 'Film',
    trailer: 'Cuplikan',
    episode: 'Episode',
    highlights: 'Sorotan',
    wildlife: 'Satwa Liar',
    safari: 'Safari',
    review: 'Ulasan',
  };

  const words = cleanOriginal.split(/\s+/);
  let translatedCount = 0;
  const translatedWords = words.map(w => {
    const cleanW = w.toLowerCase().replace(/[^\w]/g, '');
    if (DICT[cleanW]) {
      translatedCount++;
      return w.replace(new RegExp(cleanW, 'i'), DICT[cleanW]);
    }
    return w;
  });

  if (translatedCount > 0) {
    return {
      originalTitle: cleanOriginal,
      translatedTitle: translatedWords.join(' '),
      detectedLanguage: 'en',
      translationStatus: 'translated',
    };
  }

  // 3. Fallback 1: Check alternative metadata title
  if (alternativeTitle && alternativeTitle.trim() && alternativeTitle !== originalTitle) {
    const cleanAlt = alternativeTitle.trim();
    if (isLikelyIndonesian(cleanAlt)) {
      return {
        originalTitle: cleanOriginal,
        translatedTitle: cleanAlt,
        detectedLanguage: 'id',
        translationStatus: 'translated',
      };
    }
  }

  // 4. Fallback 2: Keep original title and flag failed status
  return {
    originalTitle: cleanOriginal,
    translatedTitle: cleanOriginal,
    detectedLanguage: 'unknown',
    translationStatus: 'failed',
  };
}
