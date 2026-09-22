import fs from 'fs';
import path from 'path';

let maskedPatterns: string[] = [];

export function registerSensitiveValue(val?: string | number) {
  if (!val) return;
  const str = String(val).trim();
  if (str.length >= 4 && !maskedPatterns.includes(str)) {
    maskedPatterns.push(str);
  }
}

function sanitize(message: string): string {
  let result = message;
  for (const pattern of maskedPatterns) {
    result = result.split(pattern).join('[REDACTED]');
  }
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

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', msg: string, ...args: unknown[]) {
  const timestamp = new Date().toISOString();
  let formattedArgs = '';
  if (args.length > 0) {
    formattedArgs = ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  }
  const cleanMsg = sanitize(`${msg}${formattedArgs}`);
  const line = `[${timestamp}] [${level}] ${cleanMsg}`;

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
  info: (msg: string, ...args: unknown[]) => log('INFO', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log('WARN', msg, ...args),
  error: (msg: string, ...args: unknown[]) => log('ERROR', msg, ...args),
  debug: (msg: string, ...args: unknown[]) => log('DEBUG', msg, ...args),
};
