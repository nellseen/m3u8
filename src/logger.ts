import fs from 'fs';
import path from 'path';
import { LogCategory } from './types.ts';

let maskedPatterns: string[] = [];

export function registerSensitiveValue(val?: string | number) {
  if (!val) return;
  const str = String(val).trim();
  if (str.length >= 4 && !maskedPatterns.includes(str)) {
    maskedPatterns.push(str);
  }
}

/**
 * Sanitizes and redacts sensitive information from log messages:
 * - Telegram auth credentials & session strings
 * - Passwords, secret tokens, bearer auth tokens
 * - Full Authorization headers
 * - Sensitive cookies (session, tokens, cf_clearance)
 * - Registered patterns
 */
export function sanitizeLog(message: string): string {
  let result = message;

  // 1. Registered sensitive patterns (API ID, Hash, Session string, etc.)
  for (const pattern of maskedPatterns) {
    result = result.split(pattern).join('[REDACTED]');
  }

  // 2. Full Authorization headers: Authorization: Bearer ... or Authorization: Basic ...
  result = result.replace(/([Aa]uthorization\s*:\s*)([^\r\n,;]+)/gi, '$1[REDACTED]');
  result = result.replace(/(["']?[Aa]uthorization["']?\s*:\s*["'])([^"'\r\n]+)(["'])/gi, '$1[REDACTED]$3');

  // 3. Bearer tokens directly in text
  result = result.replace(/bearer\s+[A-Za-z0-9_\-\.=:]{8,}/gi, 'Bearer [REDACTED]');

  // 4. Password / secret tokens
  result = result.replace(/(password|passwd|pwd)\s*[:=]\s*["']?([^\s"',;&]+)["']?/gi, '$1=[REDACTED]');
  result = result.replace(/(access_token|refresh_token|bot_token|secret_key|private_key|api_key)\s*[:=]\s*["']?([^\s"',;&]+)["']?/gi, '$1=[REDACTED]');

  // 5. Telegram session string patterns (GramJS / Telethon long base64 sessions)
  result = result.replace(/1[A-Za-z0-9+/=]{80,}/g, '[REDACTED_TELEGRAM_SESSION]');

  // 6. Sensitive cookies in Cookie: headers or raw strings
  result = result.replace(/([Cc]ookie\s*:\s*)([^\r\n]+)/gi, (match, prefix, cookieStr) => {
    // Redact sensitive cookies while keeping harmless ones masked
    const redactedCookies = cookieStr.replace(
      /(session|sessionid|auth|token|jwt|cf_clearance|connect\.sid)=([^;]+)/gi,
      '$1=[REDACTED]'
    );
    return `${prefix}${redactedCookies}`;
  });

  return result;
}

let logFileStream: fs.WriteStream | null = null;

export function initLogger(logDir: string) {
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, `userbot-${new Date().toISOString().slice(0, 10)}.log`);
    logFileStream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch (err) {
    console.error('Failed to initialize file logger:', err);
  }
}

function writeLog(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', category: LogCategory | undefined, msg: string, ...args: unknown[]) {
  const timestamp = new Date().toISOString();
  let formattedArgs = '';
  if (args.length > 0) {
    formattedArgs = ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  }
  const cleanMsg = sanitizeLog(`${msg}${formattedArgs}`);
  const catPrefix = category ? `[${category}] ` : '';
  const line = `[${timestamp}] [${level}] ${catPrefix}${cleanMsg}`;

  switch (level) {
    case 'INFO':
      console.log('\x1b[36m%s\x1b[0m', line);
      break;
    case 'WARN':
      console.warn('\x1b[33m%s\x1b[0m', line);
      break;
    case 'ERROR':
      console.error('\x1b[31m%s\x1b[0m', line);
      break;
    case 'DEBUG':
      if (process.env.DEBUG) {
        console.log('\x1b[90m%s\x1b[0m', line);
      }
      break;
  }

  if (logFileStream) {
    try {
      logFileStream.write(line + '\n');
    } catch {
      // Ignore write errors to log file
    }
  }
}

export const logger = {
  info: (msg: string, ...args: unknown[]) => writeLog('INFO', undefined, msg, ...args),
  warn: (msg: string, ...args: unknown[]) => writeLog('WARN', undefined, msg, ...args),
  error: (msg: string, ...args: unknown[]) => writeLog('ERROR', 'ERROR', msg, ...args),
  debug: (msg: string, ...args: unknown[]) => writeLog('DEBUG', undefined, msg, ...args),

  // Explicit Category Loggers matching User Specification:
  // [JOB], [DISCOVERY], [M3U8], [HLS], [PLAYWRIGHT], [FFMPEG], [YTDLP], [STREAMLINK], [TELEGRAM], [QUEUE], [CLEANUP], [ERROR]
  category: (cat: LogCategory, msg: string, ...args: unknown[]) => writeLog('INFO', cat, msg, ...args),
  job: (msg: string, ...args: unknown[]) => writeLog('INFO', 'JOB', msg, ...args),
  discovery: (msg: string, ...args: unknown[]) => writeLog('INFO', 'DISCOVERY', msg, ...args),
  m3u8: (msg: string, ...args: unknown[]) => writeLog('INFO', 'M3U8', msg, ...args),
  hls: (msg: string, ...args: unknown[]) => writeLog('INFO', 'HLS', msg, ...args),
  playwright: (msg: string, ...args: unknown[]) => writeLog('INFO', 'PLAYWRIGHT', msg, ...args),
  ffmpeg: (msg: string, ...args: unknown[]) => writeLog('INFO', 'FFMPEG', msg, ...args),
  ytdlp: (msg: string, ...args: unknown[]) => writeLog('INFO', 'YTDLP', msg, ...args),
  streamlink: (msg: string, ...args: unknown[]) => writeLog('INFO', 'STREAMLINK', msg, ...args),
  telegram: (msg: string, ...args: unknown[]) => writeLog('INFO', 'TELEGRAM', msg, ...args),
  queue: (msg: string, ...args: unknown[]) => writeLog('INFO', 'QUEUE', msg, ...args),
  cleanup: (msg: string, ...args: unknown[]) => writeLog('INFO', 'CLEANUP', msg, ...args),

  taskError: (
    taskId: string,
    engine: string,
    stage: string,
    errorType: string,
    message: string
  ) => {
    writeLog('ERROR', 'ERROR', `[${taskId}] [${engine}] [${stage}] [${errorType}] ${message}`);
  },
};

