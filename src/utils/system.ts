import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { chromium, Browser } from 'playwright';
import { config } from '../config.ts';
import { ChromiumCandidate, PlaywrightHealthResult, ResolvedChromium } from '../types.ts';

// Cached resolved working Chromium
let cachedResolvedChromium: ResolvedChromium | null = null;

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
  const home = os.homedir();
  const pwFfmpeg = path.join(home, '.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux');
  if (fs.existsSync(pwFfmpeg)) {
    return pwFfmpeg;
  }
  return 'ffmpeg';
}

export function getFfprobePath(): string {
  if (config.customPaths.ffmpeg) {
    const dir = path.dirname(config.customPaths.ffmpeg);
    const candidate = path.join(dir, 'ffprobe');
    if (fs.existsSync(candidate)) return candidate;
  }
  if (isCommandAvailable('ffprobe')) {
    return 'ffprobe';
  }
  if (fs.existsSync('/usr/bin/ffprobe')) {
    return '/usr/bin/ffprobe';
  }
  return 'ffprobe';
}

export function getAvailableDiskSpace(dirPath: string): number {
  try {
    const targetDir = fs.existsSync(dirPath) ? dirPath : '.';
    const stat = fs.statfsSync(targetDir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return Infinity; // Fallback if statfs is unavailable
  }
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

export function isTermuxOrPRoot(): { isTermux: boolean; isPRoot: boolean; arch: string } {
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
  return { isTermux, isPRoot, arch: process.arch };
}

/**
 * Shell configuration detection for zsh / bash
 */
export function detectShellConfig(): { shell: string; configFile: string } {
  const shellEnv = process.env.SHELL || '';
  const home = os.homedir();
  let shell = 'bash';
  let configFile = path.join(home, '.bashrc');

  if (shellEnv.includes('zsh')) {
    shell = 'zsh';
    configFile = path.join(home, '.zshrc');
  } else if (shellEnv.includes('bash')) {
    shell = 'bash';
    configFile = path.join(home, '.bashrc');
  } else if (fs.existsSync(path.join(home, '.zshrc'))) {
    shell = 'zsh';
    configFile = path.join(home, '.zshrc');
  }

  return { shell, configFile };
}

/**
 * Ensures a directory is in the user's shell config PATH without duplication
 */
export function ensurePathInShellConfig(dirToAdd: string): boolean {
  try {
    const { configFile } = detectShellConfig();
    const currentPath = process.env.PATH || '';

    // Already in running process PATH
    if (currentPath.split(':').includes(dirToAdd)) {
      return true;
    }

    if (fs.existsSync(configFile)) {
      const content = fs.readFileSync(configFile, 'utf8');
      if (content.includes(dirToAdd)) {
        return true;
      }
      fs.appendFileSync(configFile, `\n# Added by telegram-hls-userbot\nexport PATH="${dirToAdd}:$PATH"\n`);
      return true;
    } else {
      fs.writeFileSync(configFile, `export PATH="${dirToAdd}:$PATH"\n`);
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Robust launch arguments for containerized / PRoot / Termux environments
 */
export function getChromiumLaunchArgs(isPRoot = false, forceSingleProcess = false): string[] {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-first-run',
    '--no-zygote',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
  ];

  // In PRoot / Termux, zygote fork IPC often crashes with seccomp/ptrace issues.
  // Running --single-process makes Chromium run inside a single process without crashing.
  if (isPRoot || forceSingleProcess) {
    args.push('--single-process');
  }

  return args;
}

/**
 * Verifies if an executable file exists and has executable permissions
 */
export function probeExecutable(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gathers all Chromium candidates across Levels 1-4
 */
export function getChromiumCandidates(): ChromiumCandidate[] {
  const candidates: ChromiumCandidate[] = [];
  const arch = process.arch;

  // LEVEL 1: Configured CHROMIUM_PATH in .env or config
  const custom = config.customPaths.chromium || process.env.CHROMIUM_PATH;
  if (custom) {
    candidates.push({
      path: custom,
      source: 'configured',
      architecture: arch,
      exists: probeExecutable(custom),
    });
  }

  // LEVEL 2: System Chromium in PATH and standard Linux/Android locations
  const systemBinaryNames = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
  for (const name of systemBinaryNames) {
    if (isCommandAvailable(name)) {
      const resolved = getCommandOutput(`which ${name}`);
      if (resolved && !candidates.some(c => c.path === resolved)) {
        candidates.push({
          path: resolved,
          source: 'system-path',
          architecture: arch,
          exists: probeExecutable(resolved),
        });
      }
    }
  }

  const knownLocations = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/lib/chromium-browser/chromium-browser',
    '/usr/lib/chromium/chromium',
    '/data/data/com.termux/files/usr/bin/chromium',
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/var/lib/snapd/snap/bin/chromium',
  ];

  for (const loc of knownLocations) {
    if (probeExecutable(loc) && !candidates.some(c => c.path === loc)) {
      candidates.push({
        path: loc,
        source: 'system-known-location',
        architecture: arch,
        exists: true,
      });
    }
  }

  // LEVEL 3: Playwright bundled browser (let Playwright resolve its default)
  candidates.push({
    path: undefined,
    source: 'playwright-bundled',
    architecture: arch,
    exists: true,
  });

  // LEVEL 4: Scanned bundled paths in ~/.cache/ms-playwright
  try {
    const home = os.homedir();
    const pwCacheDir = path.join(home, '.cache/ms-playwright');
    if (fs.existsSync(pwCacheDir)) {
      const entries = fs.readdirSync(pwCacheDir);
      for (const entry of entries) {
        if (entry.includes('chromium') || entry.includes('chrome')) {
          const entryPath = path.join(pwCacheDir, entry);
          const scanExecs = [
            path.join(entryPath, 'chrome-linux/chrome'),
            path.join(entryPath, 'chrome-linux64/chrome'),
            path.join(entryPath, 'chrome-linux-arm64/chrome'),
            path.join(entryPath, 'chrome-headless-shell-linux64/chrome-headless-shell'),
            path.join(entryPath, 'chrome-headless-shell-linux-arm64/chrome-headless-shell'),
          ];
          for (const se of scanExecs) {
            if (probeExecutable(se) && !candidates.some(c => c.path === se)) {
              candidates.push({
                path: se,
                source: 'scanned-cache',
                architecture: arch,
                exists: true,
              });
            }
          }
        }
      }
    }
  } catch {
    // Ignore cache scan errors
  }

  return candidates;
}

/**
 * Reusable full health check: Launch -> Context -> Page -> Navigate -> JS Eval -> Close
 */
export async function checkPlaywrightHealth(
  executablePath?: string,
  forceSingleProcess = false
): Promise<PlaywrightHealthResult> {
  const { isPRoot } = isTermuxOrPRoot();
  let browser: Browser | null = null;
  const launchArgs = getChromiumLaunchArgs(isPRoot, forceSingleProcess);

  // 1. Stage: Launch
  try {
    browser = await chromium.launch({
      executablePath: executablePath || undefined,
      headless: true,
      args: launchArgs,
      timeout: 15000,
    });
  } catch (launchErr: any) {
    // If standard launch fails in PRoot or container and we haven't tried single-process yet, retry!
    if (!forceSingleProcess) {
      return checkPlaywrightHealth(executablePath, true);
    }
    return {
      success: false,
      stage: 'launch',
      executablePath,
      isSingleProcess: forceSingleProcess,
      error: launchErr?.message || String(launchErr),
    };
  }

  const browserVersion = browser.version();

  // 2. Stage: Context
  let context: any = null;
  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
  } catch (ctxErr: any) {
    try { await browser.close(); } catch {}
    return {
      success: false,
      stage: 'context',
      version: browserVersion,
      executablePath,
      isSingleProcess: forceSingleProcess,
      error: ctxErr?.message || String(ctxErr),
    };
  }

  // 3. Stage: Page & Navigate
  let page: any = null;
  try {
    page = await context.newPage();
    await page.goto('about:blank', { timeout: 10000 });
  } catch (pageErr: any) {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
    return {
      success: false,
      stage: 'page',
      version: browserVersion,
      executablePath,
      isSingleProcess: forceSingleProcess,
      error: pageErr?.message || String(pageErr),
    };
  }

  // 4. Stage: JavaScript Evaluation
  let userAgent = '';
  try {
    const evalResult = await page.evaluate(() => {
      return {
        calc: 1 + 1,
        ua: navigator.userAgent,
      };
    });
    if (evalResult.calc !== 2) {
      throw new Error(`Unexpected JS evaluation result: ${evalResult.calc}`);
    }
    userAgent = evalResult.ua;
  } catch (evalErr: any) {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
    return {
      success: false,
      stage: 'evaluate',
      version: browserVersion,
      executablePath,
      isSingleProcess: forceSingleProcess,
      error: evalErr?.message || String(evalErr),
    };
  }

  // 5. Stage: Close / Cleanup
  try {
    await page.close();
    await context.close();
    await browser.close();
  } catch (closeErr: any) {
    return {
      success: false,
      stage: 'close',
      version: browserVersion,
      executablePath,
      isSingleProcess: forceSingleProcess,
      error: closeErr?.message || String(closeErr),
    };
  }

  return {
    success: true,
    stage: 'close',
    version: browserVersion,
    userAgent,
    executablePath,
    isSingleProcess: forceSingleProcess,
  };
}

/**
 * Resolves the optimal working Chromium executable using real health checks
 */
export async function resolveChromiumExecutable(forceVerify = false): Promise<ResolvedChromium> {
  if (cachedResolvedChromium && !forceVerify) {
    return cachedResolvedChromium;
  }

  const candidates = getChromiumCandidates();
  let lastError = 'No Chromium candidates available';

  for (const candidate of candidates) {
    // Only test candidate if it exists or is bundled
    if (candidate.path && !candidate.exists) {
      continue;
    }

    const health = await checkPlaywrightHealth(candidate.path);
    if (health.success) {
      cachedResolvedChromium = {
        path: candidate.path,
        source: candidate.source,
        architecture: candidate.architecture,
        verified: true,
        version: health.version,
        isSingleProcess: health.isSingleProcess,
      };
      return cachedResolvedChromium;
    } else {
      lastError = `[${candidate.source}] ${health.stage} failed: ${health.error}`;
    }
  }

  cachedResolvedChromium = {
    path: undefined,
    source: 'none',
    architecture: process.arch,
    verified: false,
    error: lastError,
  };

  return cachedResolvedChromium;
}

/**
 * Legacy accessor returning string or undefined, backed by the resolver
 */
export function getChromiumPath(): string | undefined {
  if (cachedResolvedChromium && cachedResolvedChromium.verified) {
    return cachedResolvedChromium.path;
  }
  if (config.customPaths.chromium && fs.existsSync(config.customPaths.chromium)) {
    return config.customPaths.chromium;
  }
  const knownLocations = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/data/data/com.termux/files/usr/bin/chromium',
  ];
  for (const loc of knownLocations) {
    if (probeExecutable(loc)) return loc;
  }
  return undefined;
}
