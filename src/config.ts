import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { BotConfig } from './types.ts';
import { registerSensitiveValue } from './logger.ts';

// Auto-create .env from .env.example if missing
const envPath = path.resolve(process.cwd(), '.env');
const examplePath = path.resolve(process.cwd(), '.env.example');
if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
  try {
    fs.copyFileSync(examplePath, envPath);
  } catch {
    // Ignore error
  }
}

// Load .env
dotenv.config();

function getEnvString(key: string, defaultValue = ''): string {
  const val = process.env[key];
  return val ? val.trim() : defaultValue;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultValue;
  return val.toLowerCase() === 'true' || val === '1';
}

const sessionFilePath = path.resolve(getEnvString('SESSION_FILE_PATH', './session.txt'));

// Load session from file if not present in env
let sessionString = getEnvString('TELEGRAM_SESSION', '');
if (!sessionString && fs.existsSync(sessionFilePath)) {
  try {
    sessionString = fs.readFileSync(sessionFilePath, 'utf8').trim();
  } catch {
    // Ignore file read error
  }
}

const apiId = getEnvNumber('TELEGRAM_API_ID', 0);
const apiHash = getEnvString('TELEGRAM_API_HASH', '');

// Register sensitive values to prevent accidental logging
registerSensitiveValue(apiId);
registerSensitiveValue(apiHash);
registerSensitiveValue(sessionString);

export const config: BotConfig = {
  apiId,
  apiHash,
  session: sessionString,
  sessionFilePath,
  maxConcurrentJobs: Math.max(1, getEnvNumber('MAX_CONCURRENT_JOBS', 2)),
  downloadTimeoutSeconds: Math.max(60, getEnvNumber('DOWNLOAD_TIMEOUT_SECONDS', 900)),
  tempDir: path.resolve(getEnvString('TEMP_DIR', './temp')),
  outputDir: path.resolve(getEnvString('OUTPUT_DIR', './output')),
  logDir: path.resolve(getEnvString('LOG_DIR', './logs')),
  port: getEnvNumber('PORT', 3000),
  autoDownloadSavedMessages: getEnvBool('AUTO_DOWNLOAD_SAVED_MESSAGES', true),
  autoDownloadPrivate: getEnvBool('AUTO_DOWNLOAD_PRIVATE', true),
  autoDownloadGroups: getEnvBool('AUTO_DOWNLOAD_GROUPS', false),
  commandPrefix: getEnvString('COMMAND_PREFIX', '.'),
  targetChannelId: getEnvString('TARGET_CHANNEL_ID', ''),
  customPaths: {
    ffmpeg: getEnvString('FFMPEG_PATH', ''),
    ytdlp: getEnvString('YTDLP_PATH', ''),
    streamlink: getEnvString('STREAMLINK_PATH', ''),
    chromium: getEnvString('CHROMIUM_PATH', ''),
  },
};

// Auto ensure working directories exist
try {
  fs.mkdirSync(config.tempDir, { recursive: true });
  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.mkdirSync(config.logDir, { recursive: true });
} catch {
  // Ignore filesystem init errors
}

/**
 * Updates keys directly in .env file without requiring manual editing
 */
export function saveEnvConfig(updates: Record<string, string | number>): void {
  try {
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
    } else if (fs.existsSync(examplePath)) {
      content = fs.readFileSync(examplePath, 'utf8');
    }

    for (const [key, rawValue] of Object.entries(updates)) {
      const value = String(rawValue).trim();
      const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
      const newLine = `${key}="${value}"`;

      if (regex.test(content)) {
        content = content.replace(regex, newLine);
      } else {
        content += (content.endsWith('\n') ? '' : '\n') + newLine + '\n';
      }

      // Sync process.env and internal config
      process.env[key] = value;
      if (key === 'TELEGRAM_API_ID') {
        config.apiId = parseInt(value, 10) || 0;
        registerSensitiveValue(config.apiId);
      } else if (key === 'TELEGRAM_API_HASH') {
        config.apiHash = value;
        registerSensitiveValue(config.apiHash);
      } else if (key === 'TELEGRAM_SESSION') {
        config.session = value;
        registerSensitiveValue(config.session);
      } else if (key === 'TARGET_CHANNEL_ID') {
        config.targetChannelId = value;
      }
    }

    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err) {
    console.error('Failed to update .env automatically:', err);
  }
}

export function saveTargetChannel(newChannelId: string): void {
  const cleanId = newChannelId.trim();
  config.targetChannelId = cleanId;
  saveEnvConfig({ TARGET_CHANNEL_ID: cleanId });
}

export function saveApiCredentials(newApiId: number, newApiHash: string): void {
  config.apiId = newApiId;
  config.apiHash = newApiHash.trim();
  registerSensitiveValue(newApiId);
  registerSensitiveValue(newApiHash);

  saveEnvConfig({
    TELEGRAM_API_ID: newApiId,
    TELEGRAM_API_HASH: newApiHash.trim(),
  });
}

export function saveSessionString(newSession: string): void {
  try {
    const cleanSession = newSession.trim();
    fs.writeFileSync(config.sessionFilePath, cleanSession, 'utf8');
    config.session = cleanSession;
    registerSensitiveValue(cleanSession);

    // Also persist into .env automatically
    saveEnvConfig({ TELEGRAM_SESSION: cleanSession });
  } catch (err) {
    console.error('Failed to save session to file:', err);
  }
}

export function isConfigured(): boolean {
  return config.apiId > 0 && config.apiHash.length > 0;
}
