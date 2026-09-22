import { execSync } from 'child_process';
import fs from 'fs';
import { config } from '../config.ts';

export function isCommandAvailable(cmd: string): boolean {
  try {
    const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getCommandOutput(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function getFfmpegPath(): string {
  if (config.customPaths.ffmpeg && fs.existsSync(config.customPaths.ffmpeg)) {
    return config.customPaths.ffmpeg;
  }
  if (isCommandAvailable('ffmpeg')) {
    return 'ffmpeg';
  }
  // Check common Playwright ffmpeg install path
  const pwFfmpeg = '/root/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux';
  if (fs.existsSync(pwFfmpeg)) {
    return pwFfmpeg;
  }
  return 'ffmpeg';
}

export function getYtdlpPath(): string {
  if (config.customPaths.ytdlp && fs.existsSync(config.customPaths.ytdlp)) {
    return config.customPaths.ytdlp;
  }
  if (isCommandAvailable('yt-dlp')) {
    return 'yt-dlp';
  }
  if (fs.existsSync('/usr/local/bin/yt-dlp')) {
    return '/usr/local/bin/yt-dlp';
  }
  return 'yt-dlp';
}

export function getStreamlinkPath(): string {
  if (config.customPaths.streamlink && fs.existsSync(config.customPaths.streamlink)) {
    return config.customPaths.streamlink;
  }
  if (isCommandAvailable('streamlink')) {
    return 'streamlink';
  }
  if (fs.existsSync('/usr/local/bin/streamlink')) {
    return '/usr/local/bin/streamlink';
  }
  return 'streamlink';
}

export function getChromiumPath(): string | undefined {
  if (config.customPaths.chromium && fs.existsSync(config.customPaths.chromium)) {
    return config.customPaths.chromium;
  }
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/data/data/com.termux/files/usr/bin/chromium',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return undefined; // Playwright will use its bundled browser
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0 || isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0 || isNaN(seconds)) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function isTermuxOrPRoot(): { isTermux: boolean; isPRoot: boolean } {
  const isTermux = Boolean(
    process.env.PREFIX?.includes('com.termux') ||
    fs.existsSync('/data/data/com.termux')
  );
  let isPRoot = false;
  try {
    const cmdline = fs.readFileSync('/proc/1/cmdline', 'utf8');
    if (cmdline.includes('proot')) isPRoot = true;
  } catch {
    // Ignore proc read errors
  }
  if (fs.existsSync('/dev/proot') || Boolean(process.env.PROOT_PID)) {
    isPRoot = true;
  }
  return { isTermux, isPRoot };
}
