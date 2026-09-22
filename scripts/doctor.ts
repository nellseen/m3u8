import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { chromium } from 'playwright';
import { config, isConfigured } from '../src/config.ts';
import {
  isCommandAvailable,
  getCommandOutput,
  getFfmpegPath,
  getYtdlpPath,
  getStreamlinkPath,
  getChromiumPath,
  isTermuxOrPRoot,
} from '../src/utils/system.ts';
import { DoctorCheckItem } from '../src/types.ts';

const checks: DoctorCheckItem[] = [];

function check(
  category: DoctorCheckItem['category'],
  name: string,
  fn: () => { pass: boolean; warn?: boolean; details: string; remedy?: string }
) {
  try {
    const res = fn();
    checks.push({
      category,
      name,
      status: res.warn ? 'WARN' : res.pass ? 'PASS' : 'FAIL',
      details: res.details,
      remedy: res.remedy,
    });
  } catch (err: any) {
    checks.push({
      category,
      name,
      status: 'FAIL',
      details: `Exception: ${err.message || String(err)}`,
      remedy: 'Check system logs and permissions',
    });
  }
}

async function runDoctor() {
  console.log('\n======================================================');
  console.log('   🔍 Telegram Userbot - System & Doctor Diagnostics');
  console.log('======================================================\n');

  // 1. Environment Check
  check('Environment', 'Runtime Environment', () => {
    const info = isTermuxOrPRoot();
    const osType = process.platform;
    const arch = process.arch;
    let desc = `${osType} (${arch})`;
    if (info.isTermux) desc += ' [Termux]';
    if (info.isPRoot) desc += ' [PRoot Container]';
    return { pass: true, details: desc };
  });

  // 2. Node.js
  check('Dependencies', 'Node.js Runtime', () => {
    const ver = process.version;
    const major = parseInt(ver.replace('v', '').split('.')[0], 10);
    if (major >= 18) {
      return { pass: true, details: `${ver} (compatible >= 18)` };
    }
    return {
      pass: false,
      details: `${ver} is too old`,
      remedy: 'Update Node.js to version 18 or higher.',
    };
  });

  // 3. pnpm
  check('Dependencies', 'pnpm Package Manager', () => {
    if (isCommandAvailable('pnpm')) {
      const ver = getCommandOutput('pnpm -v');
      return { pass: true, details: `v${ver}` };
    }
    return {
      pass: false,
      details: 'pnpm not found in PATH',
      remedy: 'Install pnpm: run "npm install -g pnpm"',
    };
  });

  // 4. FFmpeg
  check('Binaries', 'FFmpeg Multimedia Engine', () => {
    const bin = getFfmpegPath();
    const out = getCommandOutput(`"${bin}" -version`);
    if (out) {
      const firstLine = out.split('\n')[0];
      return { pass: true, details: `${bin} (${firstLine.slice(0, 40)}...)` };
    }
    return {
      pass: false,
      details: 'FFmpeg not found',
      remedy: 'Install FFmpeg: run "bash scripts/setup.sh" or "apt-get install -y ffmpeg" or "pkg install ffmpeg"',
    };
  });

  // 5. yt-dlp
  check('Binaries', 'yt-dlp Video Downloader', () => {
    const bin = getYtdlpPath();
    const out = getCommandOutput(`"${bin}" --version`);
    if (out) {
      return { pass: true, details: `${bin} (version ${out})` };
    }
    return {
      pass: false,
      details: 'yt-dlp binary not found',
      remedy: 'Install yt-dlp: run "pip3 install --break-system-packages yt-dlp" or "bash scripts/setup.sh"',
    };
  });

  // 6. Streamlink
  check('Binaries', 'Streamlink Stream Processor', () => {
    const bin = getStreamlinkPath();
    const out = getCommandOutput(`"${bin}" --version`);
    if (out) {
      return { pass: true, details: `${bin} (${out.split('\n')[0]})` };
    }
    return {
      pass: false,
      details: 'streamlink not found in PATH',
      remedy: 'Install Streamlink: run "pip3 install --break-system-packages streamlink" or "bash scripts/setup.sh"',
    };
  });

  // 7. Chromium & Playwright
  console.log('Testing Playwright / Chromium headless launch (may take a moment)...');
  let playwrightPass = false;
  let playwrightDetail = '';
  let playwrightRemedy = '';
  try {
    const execPath = getChromiumPath();
    const browser = await chromium.launch({
      executablePath: execPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: 15000,
    });
    playwrightDetail = `Browser launch OK (version: ${browser.version()})`;
    await browser.close();
    playwrightPass = true;
  } catch (err: any) {
    playwrightDetail = `Playwright launch failed: ${err.message?.slice(0, 70)}`;
    playwrightRemedy = 'Run "npx playwright install --with-deps chromium" or "apt-get install -y chromium-browser"';
  }
  checks.push({
    category: 'Binaries',
    name: 'Playwright / Chromium Sniffer',
    status: playwrightPass ? 'PASS' : 'WARN',
    details: playwrightDetail,
    remedy: playwrightRemedy,
  });

  // 8. Package Installation (node_modules check)
  try {
    const tg = await import('telegram');
    checks.push({
      category: 'Dependencies',
      name: 'GramJS (telegram) Package',
      status: tg && tg.TelegramClient ? 'PASS' : 'FAIL',
      details: tg && tg.TelegramClient ? 'Loaded successfully from node_modules' : 'Invalid package export',
    });
  } catch {
    checks.push({
      category: 'Dependencies',
      name: 'GramJS (telegram) Package',
      status: 'FAIL',
      details: 'Missing from node_modules',
      remedy: 'Run "pnpm install" to install dependencies',
    });
  }

  // 9. Executable PATH check
  check('Environment', 'System Executable PATH', () => {
    const currentPath = process.env.PATH || '';
    const hasLocalBin = currentPath.includes('/usr/local/bin') || currentPath.includes('/usr/bin');
    if (hasLocalBin) {
      return { pass: true, details: `PATH verified (${currentPath.split(':').length} directories)` };
    }
    return {
      pass: false,
      warn: true,
      details: 'Standard binary paths may be missing from PATH',
      remedy: 'Ensure /usr/local/bin and /usr/bin are in your PATH environment variable.',
    };
  });

  // 9. Filesystem & Directory Permissions
  check('Filesystem', 'Runtime Directories & Permissions', () => {
    const dirs = [config.tempDir, config.outputDir, config.logDir];
    for (const d of dirs) {
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
      }
      // Test write & delete
      const testFile = path.join(d, `.perm_test_${Date.now()}`);
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
    }
    return {
      pass: true,
      details: `Write/read verified: temp (${config.tempDir}), output (${config.outputDir}), logs (${config.logDir})`,
    };
  });

  // 10. Telegram Configuration
  check('Telegram', 'API Credentials & Session', () => {
    const hasConfig = isConfigured();
    const hasSession = Boolean(config.session);

    if (hasConfig && hasSession) {
      return { pass: true, details: 'API ID, API HASH, and Session String are loaded' };
    }
    if (hasConfig && !hasSession) {
      return {
        pass: true,
        warn: true,
        details: 'API ID & HASH are configured, but TELEGRAM_SESSION is missing.',
        remedy: 'Run "pnpm run login" in your terminal to authenticate your Telegram account.',
      };
    }
    return {
      pass: false,
      warn: true,
      details: 'TELEGRAM_API_ID and TELEGRAM_API_HASH belum diisi',
      remedy: 'Cukup jalankan "pnpm run login" di terminal untuk memasukkan API ID & Hash secara interaktif tanpa perlu mengedit file secara manual.',
    };
  });

  // Print Formatted Output Table
  console.log('--------------------------------------------------------------------------------------------------');
  console.log('| Status | Category       | Check Name                          | Details                        |');
  console.log('--------------------------------------------------------------------------------------------------');

  for (const c of checks) {
    const statusCol =
      c.status === 'PASS'
        ? '\x1b[32m PASS \x1b[0m'
        : c.status === 'WARN'
        ? '\x1b[33m WARN \x1b[0m'
        : '\x1b[31m FAIL \x1b[0m';
    const catCol = c.category.padEnd(14);
    const nameCol = c.name.padEnd(35);
    const detCol = c.details.length > 30 ? c.details.slice(0, 27) + '...' : c.details.padEnd(30);

    console.log(`| ${statusCol} | ${catCol} | ${nameCol} | ${detCol} |`);
  }
  console.log('--------------------------------------------------------------------------------------------------\n');

  // Print Remedies if any failed or warned
  const issues = checks.filter(c => c.status !== 'PASS');
  if (issues.length > 0) {
    console.log('\x1b[33mRemediation Guidance:\x1b[0m');
    for (const issue of issues) {
      console.log(`\n• [${issue.status}] ${issue.name}:`);
      console.log(`  Details: ${issue.details}`);
      if (issue.remedy) {
        console.log(`  Fix:     ${issue.remedy}`);
      }
    }
    console.log('\n');
  }

  const passCount = checks.filter(c => c.status === 'PASS').length;
  const warnCount = checks.filter(c => c.status === 'WARN').length;
  const failCount = checks.filter(c => c.status === 'FAIL').length;

  console.log(`Doctor Summary: \x1b[32m${passCount} PASS\x1b[0m, \x1b[33m${warnCount} WARN\x1b[0m, \x1b[31m${failCount} FAIL\x1b[0m`);

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log('\x1b[32mSystem is ready to run the Telegram Userbot!\x1b[0m\n');
    process.exit(0);
  }
}

runDoctor().catch(err => {
  console.error('Fatal doctor execution error:', err);
  process.exit(1);
});
