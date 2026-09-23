import fs from 'fs';
import path from 'path';

export interface CookieObject {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Normalizes cookies from various formats:
 * - Playwright Cookie[] array
 * - HTTP Set-Cookie header strings or array
 * - Raw cookie strings ("a=b; c=d")
 *
 * Deduplicates by cookie name (latest wins), preserves critical session, auth,
 * Cloudflare (cf_clearance, __cf_bm), and player session cookies.
 */
export function normalizeCookies(
  input?: string | CookieObject[] | string[] | null
): string {
  if (!input) return '';

  const cookieMap = new Map<string, string>();

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        // e.g. "token=xyz; Path=/; HttpOnly" or "token=xyz; foo=bar"
        parseCookieHeaderLine(item, cookieMap);
      } else if (item && typeof item === 'object' && item.name && item.value !== undefined) {
        cookieMap.set(item.name.trim(), item.value.trim());
      }
    }
  } else if (typeof input === 'string') {
    parseCookieHeaderLine(input, cookieMap);
  }

  // Format into standard "name1=value1; name2=value2" string
  return Array.from(cookieMap.entries())
    .map(([name, val]) => `${name}=${val}`)
    .join('; ');
}

function parseCookieHeaderLine(line: string, cookieMap: Map<string, string>): void {
  // Strip out multiple cookies or single Set-Cookie header
  const parts = line.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();

    // Ignore standard cookie attributes when parsing Set-Cookie strings
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === 'path' ||
      lowerKey === 'domain' ||
      lowerKey === 'expires' ||
      lowerKey === 'max-age' ||
      lowerKey === 'samesite' ||
      lowerKey === 'httponly' ||
      lowerKey === 'secure' ||
      lowerKey === 'priority'
    ) {
      continue;
    }

    cookieMap.set(key, val);
  }
}

/**
 * Merges two cookie strings, prioritizing incoming/newer cookies
 */
export function mergeCookieStrings(existing?: string, incoming?: string): string {
  if (!existing) return normalizeCookies(incoming);
  if (!incoming) return normalizeCookies(existing);

  const cookieMap = new Map<string, string>();
  parseCookieHeaderLine(existing, cookieMap);
  parseCookieHeaderLine(incoming, cookieMap);

  return Array.from(cookieMap.entries())
    .map(([name, val]) => `${name}=${val}`)
    .join('; ');
}

/**
 * Exports cookies to Netscape HTTP Cookie File format (required by some tools like curl/yt-dlp)
 */
export function exportToNetscapeCookieFile(
  cookies: string | CookieObject[],
  defaultDomain: string,
  outputPath: string
): string {
  const lines: string[] = ['# Netscape HTTP Cookie File', '# https://curl.se/docs/http-cookies.html', ''];
  const domain = defaultDomain.startsWith('.') ? defaultDomain : `.${defaultDomain}`;

  if (typeof cookies === 'string') {
    const cookieMap = new Map<string, string>();
    parseCookieHeaderLine(cookies, cookieMap);

    const now = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days future
    for (const [name, value] of cookieMap.entries()) {
      // domain, domain_specified, path, secure, expires, name, value
      lines.push(`${domain}\tTRUE\t/\tFALSE\t${now}\t${name}\t${value}`);
    }
  } else if (Array.isArray(cookies)) {
    for (const c of cookies) {
      const cDomain = c.domain ? (c.domain.startsWith('.') ? c.domain : `.${c.domain}`) : domain;
      const cPath = c.path || '/';
      const cSecure = c.secure ? 'TRUE' : 'FALSE';
      const cExpires = c.expires && c.expires > 0 ? Math.floor(c.expires) : Math.floor(Date.now() / 1000) + 86400 * 30;
      lines.push(`${cDomain}\tTRUE\t${cPath}\t${cSecure}\t${cExpires}\t${c.name}\t${c.value}`);
    }
  }

  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  return outputPath;
}
