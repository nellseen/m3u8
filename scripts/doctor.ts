import fs from 'fs';
import path from 'path';
import { config, isConfigured } from '../src/config.ts';
import {
  isCommandAvailable,
  getCommandOutput,
  getFfmpegPath,
  getFfprobePath,
  getYtdlpPath,
  getStreamlinkPath,
  isTermuxOrPRoot,
  getAvailableDiskSpace,
  formatBytes,
  getChromiumCandidates,
  checkPlaywrightHealth,
  resolveChromiumExecutable,
  detectShellConfig,
} from '../src/utils/system.ts';
import { DoctorCheckItem, PlaywrightHealthResult, ResolvedChromium } from '../src/types.ts';

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

  const { isTermux, isPRoot, arch } = isTermuxOrPRoot();
  const { shell, configFile } = detectShellConfig();

  // Engine readiness state
  const readyStatus: Record<string, { status: 'READY' | 'NOT READY' | 'WARNING'; note?: string }> = {
    'Direct HLS': { status: 'READY' },
    'Playwright': { status: 'NOT READY' },
    'Chromium': { status: 'NOT READY' },
    'Streamlink': { status: 'NOT READY' },
    'yt-dlp': { status: 'NOT READY' },
    'FFmpeg': { status: 'NOT READY' },
    'Telegram': { status: 'WARNING', note: 'SESSION MISSING' },
  };

  // 1. Environment & Architecture
  check('Environment', 'Runtime Architecture', () => {
    let desc = `${process.platform} (${arch})`;
    if (isTermux) desc += ' [Termux]';
    if (isPRoot) desc += ' [Ubuntu/PRoot]';
    return { pass: true, details: desc };
  });

  check('Environment', 'Active Shell & Config', () => {
    return {
      pass: true,
      details: `${shell} (${path.basename(configFile)})`,
    };
  });

  check('Environment', 'System Executable PATH', () => {
    const currentPath = process.env.PATH || '';
    const dirCount = currentPath.split(':').filter(Boolean).length;
    return {
      pass: true,
      details: `${dirCount} directories in PATH`,
    };
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
      details: `${ver} is unsupported (< 18)`,
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
      remedy: 'Install pnpm: run "npm install -g pnpm" or "corepack enable pnpm"',
    };
  });

  // 4. FFmpeg
  check('Binaries', 'FFmpeg Multimedia Engine', () => {
    const bin = getFfmpegPath();
    const out = getCommandOutput(`"${bin}" -version`);
    if (out) {
      readyStatus['FFmpeg'].status = 'READY';
      const firstLine = out.split('\n')[0];
      return { pass: true, details: `${bin} (${firstLine.slice(0, 28)}...)` };
    }
    return {
      pass: false,
      details: 'FFmpeg not found',
      remedy: 'Install FFmpeg: run "bash scripts/setup.sh" or "apt-get install -y ffmpeg" or "pkg install ffmpeg"',
    };
  });

  // 4b. ffprobe
  check('Binaries', 'ffprobe Media Analyzer', () => {
    const bin = getFfprobePath();
    const out = getCommandOutput(`"${bin}" -version`);
    if (out) {
      return { pass: true, details: `${bin} (available)` };
    }
    return {
      pass: true,
      warn: true,
      details: 'ffprobe not found (fallback probe active)',
      remedy: 'Install ffmpeg/ffprobe via package manager',
    };
  });

  // 5. yt-dlp
  check('Binaries', 'yt-dlp Video Downloader', () => {
    const bin = getYtdlpPath();
    const out = getCommandOutput(`"${bin}" --version`);
    if (out) {
      readyStatus['yt-dlp'].status = 'READY';
      return { pass: true, details: `${bin} (v${out})` };
    }
    return {
      pass: true,
      warn: true,
      details: 'yt-dlp binary not found in PATH',
      remedy: 'Install yt-dlp: run "pip3 install --break-system-packages yt-dlp" or "bash scripts/setup.sh"',
    };
  });

  // 6. Streamlink
  check('Binaries', 'Streamlink Stream Processor', () => {
    const bin = getStreamlinkPath();
    const out = getCommandOutput(`"${bin}" --version`);
    if (out) {
      readyStatus['Streamlink'].status = 'READY';
      return { pass: true, details: `${bin} (${out.split('\n')[0]})` };
    }
    return {
      pass: true,
      warn: true,
      details: 'streamlink not found in PATH',
      remedy: 'Install Streamlink: run "pip3 install --break-system-packages streamlink" or "bash scripts/setup.sh"',
    };
  });

  // 7. Storage Check
  check('Filesystem', 'Storage & Disk Space', () => {
    const freeBytes = getAvailableDiskSpace(config.tempDir);
    const freeFormatted = formatBytes(freeBytes);
    if (freeBytes > 500 * 1024 * 1024) {
      return { pass: true, details: `${freeFormatted} free disk space` };
    }
    if (freeBytes > 250 * 1024 * 1024) {
      return { pass: true, warn: true, details: `${freeFormatted} free (low storage)` };
    }
    return {
      pass: false,
      details: `Critically low disk: ${freeFormatted} free`,
      remedy: 'Free up storage space before running downloads.',
    };
  });

  // 8. Filesystem Permissions
  check('Filesystem', 'Directory Permissions', () => {
    const dirs = [config.tempDir, config.outputDir, config.logDir];
    for (const d of dirs) {
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
      }
      const testFile = path.join(d, `.perm_test_${Date.now()}`);
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
    }
    return { pass: true, details: 'Write/read verified: temp, output, logs' };
  });

  // 9. Playwright Package Test (Separated from Chromium runtime)
  console.log('Testing Playwright package & Chromium runtime...');
  let playwrightPkgPass = false;
  let playwrightPkgDetail = '';
  try {
    const pw = await import('playwright');
    if (pw && pw.chromium) {
      playwrightPkgPass = true;
      playwrightPkgDetail = 'Loaded successfully from node_modules';
    } else {
      playwrightPkgDetail = 'Playwright chromium export missing';
    }
  } catch (err: any) {
    playwrightPkgDetail = `Import failed: ${err.message?.slice(0, 60)}`;
  }

  checks.push({
    category: 'Playwright',
    name: 'Playwright Package',
    status: playwrightPkgPass ? 'PASS' : 'FAIL',
    details: playwrightPkgDetail,
    remedy: playwrightPkgPass ? undefined : 'Run "pnpm install" to install playwright',
  });

  // 10. Chromium Candidate Discovery & Real Multi-Stage Launch Test
  const candidates = getChromiumCandidates();
  const existingCandidates = candidates.filter(c => !c.path || c.exists);
  const candidateSummary = existingCandidates
    .map(c => `${c.source}:${c.path ? path.basename(c.path) : 'bundled'}`)
    .join(', ');

  checks.push({
    category: 'Chromium',
    name: 'Chromium Candidates Found',
    status: existingCandidates.length > 0 ? 'PASS' : 'WARN',
    details: `${existingCandidates.length} candidate(s): ${candidateSummary || 'none'}`,
    remedy:
      existingCandidates.length === 0
        ? 'Run "pnpm exec playwright install chromium" or "apt-get install -y chromium-browser"'
        : undefined,
  });

  // Resolve working executable with REAL LAUNCH TEST
  const resolved = await resolveChromiumExecutable(true);

  // Individual detailed stages for doctor reporting
  let healthResult: PlaywrightHealthResult = {
    success: false,
    stage: 'resolve',
    error: resolved.error,
  };

  if (resolved.verified) {
    healthResult = await checkPlaywrightHealth(resolved.path);
  } else if (existingCandidates.length > 0) {
    // Test the first candidate to record where it fails
    healthResult = await checkPlaywrightHealth(existingCandidates[0].path);
  }

  // Chromium Launch stage check
  const launchPassed = Boolean(healthResult.version);
  checks.push({
    category: 'Chromium',
    name: 'Chromium Launch',
    status: launchPassed ? 'PASS' : 'FAIL',
    details: launchPassed
      ? `Launched OK (v${healthResult.version})${healthResult.isSingleProcess ? ' [single-process]' : ''}`
      : `Failed at launch stage: ${healthResult.error?.slice(0, 50)}`,
    remedy: !launchPassed
      ? isPRoot || arch === 'arm64'
        ? 'In ARM64/PRoot, install system Chromium: "apt-get update && apt-get install -y chromium-browser" or "pkg install chromium", then add CHROMIUM_PATH to .env'
        : 'Run "pnpm exec playwright install chromium" or check missing libraries'
      : undefined,
  });

  // Browser Context stage check
  const contextPassed = launchPassed && healthResult.stage !== 'context';
  checks.push({
    category: 'Chromium',
    name: 'Browser Context Creation',
    status: contextPassed ? 'PASS' : launchPassed ? 'FAIL' : 'WARN',
    details: contextPassed
      ? 'Context created (1280x720)'
      : launchPassed
      ? `Context error: ${healthResult.error?.slice(0, 45)}`
      : 'NOT TESTED (Launch failed)',
  });

  // Browser Page & JS Evaluation check
  const pagePassed = contextPassed && healthResult.stage !== 'page' && healthResult.stage !== 'evaluate';
  checks.push({
    category: 'Chromium',
    name: 'Browser Page & JS Evaluation',
    status: pagePassed ? 'PASS' : contextPassed ? 'FAIL' : 'WARN',
    details: pagePassed
      ? 'Page navigated to about:blank & JS executed'
      : contextPassed
      ? `Page/JS error: ${healthResult.error?.slice(0, 45)}`
      : 'NOT TESTED',
  });

  // Update overall readiness based on real health verification
  if (playwrightPkgPass && resolved.verified && pagePassed) {
    readyStatus['Playwright'].status = 'READY';
    readyStatus['Chromium'].status = 'READY';
  } else {
    readyStatus['Playwright'].status = 'NOT READY';
    readyStatus['Chromium'].status = 'NOT READY';
  }

  // 11. Telegram Credentials & Session
  check('Telegram', 'API Credentials', () => {
    const configured = isConfigured();
    if (configured) {
      return { pass: true, details: 'API ID and API HASH are configured' };
    }
    return {
      pass: false,
      warn: true,
      details: 'TELEGRAM_API_ID / TELEGRAM_API_HASH not set in .env',
      remedy: 'Run "pnpm run login" to input your Telegram credentials interactively.',
    };
  });

  check('Telegram', 'Telegram Session', () => {
    const hasSession = Boolean(config.session);
    if (hasSession) {
      readyStatus['Telegram'].status = 'READY';
      readyStatus['Telegram'].note = undefined;
      return { pass: true, details: 'Telegram session active' };
    }
    readyStatus['Telegram'].status = 'WARNING';
    readyStatus['Telegram'].note = 'SESSION MISSING';
    return {
      pass: true,
      warn: true,
      details: 'Session string missing (run "pnpm run login")',
      remedy: 'Run "pnpm run login" in terminal to authenticate your Telegram account.',
    };
  });

  check('Telegram', 'Target Channel (Upload Target)', () => {
    const hasChannel = Boolean(config.targetChannelId && config.targetChannelId.trim());
    if (hasChannel) {
      return { pass: true, details: `Target: ${config.targetChannelId.trim()}` };
    }
    return {
      pass: false,
      warn: true,
      details: 'TARGET_CHANNEL_ID not set in .env (Mandatory)',
      remedy: 'Set TARGET_CHANNEL_ID in .env or run "pnpm run login" to configure channel destination.',
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

  // Print Engine Readiness Summary (Requirement 22 & L)
  console.log('======================================================');
  console.log('            🚀 Engine & Service Readiness             ');
  console.log('======================================================');
  for (const [engine, info] of Object.entries(readyStatus)) {
    const label = engine.padEnd(16);
    if (info.status === 'READY') {
      console.log(`${label} \x1b[32mREADY\x1b[0m`);
    } else if (info.status === 'WARNING') {
      const note = info.note ? ` (${info.note})` : '';
      console.log(`${label} \x1b[33mWARNING\x1b[0m${note}`);
    } else {
      const note = info.note ? ` (${info.note})` : ' (NOT READY)';
      console.log(`${label} \x1b[31mNOT READY\x1b[0m${note}`);
    }
  }
  console.log('======================================================\n');

  // Diagnosis for Chromium if failed
  if (!resolved.verified) {
    console.log('\x1b[31m⚠️ Chromium Diagnostic Analysis:\x1b[0m');
    console.log(`  • Platform Architecture: ${arch} | OS: ${process.platform} | PRoot: ${isPRoot}`);
    console.log(`  • Error Stage:           ${healthResult.stage.toUpperCase()}`);
    console.log(`  • Failure Cause:         ${healthResult.error || 'Chromium exited unexpectedly'}`);

    if (isPRoot || arch === 'arm64') {
      console.log('\n\x1b[36m💡 Recommended Solution for PRoot / ARM64 (Bypassing Snap wrapper):\x1b[0m');
      console.log('  1. Run the automatic setup script:');
      console.log('     bash scripts/setup.sh  (or: bash up.sh)');
      console.log('  2. Or manually add Debian Bookworm repo & install native Chromium:');
      console.log('     echo "deb [trusted=yes] http://deb.debian.org/debian bookworm main" > /etc/apt/sources.list.d/debian-bookworm.list');
      console.log('     apt-get update && apt-get install -y --no-install-recommends chromium');
      console.log('  3. Ensure CHROMIUM_PATH in .env:');
      console.log('     echo "CHROMIUM_PATH=/usr/bin/chromium" >> .env');
      console.log('  4. Re-run: pnpm doctor\n');
    }
  } else {
    console.log(`\x1b[32m✓ Verified Working Chromium: ${resolved.path || 'Playwright Bundled'} (${resolved.source})\x1b[0m\n`);
  }

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

  console.log(`Doctor Summary: \x1b[32m${passCount} PASS\x1b[0m, \x1b[33m${warnCount} WARN\x1b[0m, \x1b[31m${failCount} FAIL\x1b[0m\n`);

  if (failCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runDoctor().catch(err => {
  console.error('Fatal doctor execution error:', err);
  process.exit(1);
});
