import fs from 'fs';
import path from 'path';
import { extractUrlsFromText, analyzeUrl } from '../src/utils/url-extractor.ts';
import { DownloadQueue } from '../src/queue/download-queue.ts';
import { FallbackOrchestrator } from '../src/engines/orchestrator.ts';
import { probeMedia, generateThumbnail, remuxToTelegramMp4 } from '../src/utils/ffmpeg.ts';
import { cleanupTaskTemp } from '../src/utils/cleaner.ts';
import { config } from '../src/config.ts';
import { DownloadTask } from '../src/types.ts';

async function runSelfAudit() {
  console.log('\n========================================================');
  console.log('       🛠️ Running Self-Audit & Pipeline Verification    ');
  console.log('========================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`\x1b[32m[PASS]\x1b[0m ${testName}${detail ? ` - ${detail}` : ''}`);
      passed++;
    } else {
      console.error(`\x1b[31m[FAIL]\x1b[0m ${testName}${detail ? ` - ${detail}` : ''}`);
      failed++;
    }
  }

  // TEST 1: URL Detection and Extraction
  console.log('\n--- 1. Testing URL Extraction & Detection ---');
  const sampleText = 'Check out this video: https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8 and also http://example.com/video.mp4!';
  const extracted = extractUrlsFromText(sampleText);
  assert(extracted.length === 2, 'Extract multiple URLs from text', `Found: ${extracted.length}`);
  assert(extracted[0] === 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', 'Extract M3U8 URL cleanly');
  assert(extracted[1] === 'http://example.com/video.mp4', 'Extract MP4 URL cleanly');

  const m3u8Analysis = analyzeUrl('https://example.com/stream/master.m3u8?token=123');
  assert(m3u8Analysis.isDirectM3u8 === true, 'Classify direct M3U8 URL with query params');

  const mp4Analysis = analyzeUrl('https://example.com/files/sample.mp4');
  assert(mp4Analysis.isDirectVideo === true, 'Classify direct MP4 URL');

  // TEST 2: Engines Initialization & Availability
  console.log('\n--- 2. Testing Fallback Orchestrator Engines ---');
  const orchestrator = new FallbackOrchestrator();
  const engines = orchestrator.getEngines();
  assert(engines.length === 5, 'Orchestrator registers 5 fallback engines', `Registered: ${engines.length}`);

  for (const eng of engines) {
    const avail = await eng.isAvailable();
    console.log(`   • ${eng.name}: ${avail ? '\x1b[32mAvailable\x1b[0m' : '\x1b[33mUnavailable\x1b[0m'}`);
  }

  // TEST 3: Temporary Directory Isolation & Cleanup
  console.log('\n--- 3. Testing Temporary Directory Isolation ---');
  const testTaskId = `audit_${Date.now()}`;
  const testTempDir = path.join(config.tempDir, testTaskId);
  fs.mkdirSync(testTempDir, { recursive: true });
  const dummyFile = path.join(testTempDir, 'dummy.tmp');
  fs.writeFileSync(dummyFile, 'audit test payload');

  assert(fs.existsSync(dummyFile), 'Created isolated job temp directory and file');

  const dummyTask: DownloadTask = {
    id: testTaskId,
    originalUrl: 'https://example.com',
    chatId: 12345,
    messageId: 1,
    status: 'detecting',
    failedEngines: [],
    tempDir: testTempDir,
    startTime: Date.now(),
    abortController: new AbortController(),
    subprocesses: [],
  };

  await cleanupTaskTemp(dummyTask);
  assert(!fs.existsSync(testTempDir), 'cleanupTaskTemp successfully purged isolated job directory');

  // TEST 4: FFmpeg Synthetic Video Generation & Probing
  console.log('\n--- 4. Testing FFmpeg Probing & Remuxing ---');
  const sampleVideo = path.join(config.tempDir, `sample_test_${Date.now()}.mp4`);
  const sampleThumb = path.join(config.tempDir, `sample_thumb_${Date.now()}.jpg`);
  const remuxOutput = path.join(config.tempDir, `sample_remuxed_${Date.now()}.mp4`);

  // Generate 2-second synthetic color bar video with tone audio via ffmpeg
  const { execSync } = await import('child_process');
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=2:size=640x360:rate=30 -f lavfi -i sine=frequency=1000:duration=2 -c:v libx264 -c:a aac "${sampleVideo}"`,
    { stdio: 'ignore' }
  );

  assert(fs.existsSync(sampleVideo), 'Generated synthetic test video via FFmpeg');

  const probe = await probeMedia(sampleVideo);
  assert(typeof probe.duration === 'number' && probe.duration > 1.5, 'Probe media duration', `${probe.duration}s`);
  assert(probe.width === 640 && probe.height === 360, 'Probe video dimensions', `${probe.width}x${probe.height}`);

  const thumbSuccess = await generateThumbnail(sampleVideo, sampleThumb);
  assert(thumbSuccess && fs.existsSync(sampleThumb), 'Generate video thumbnail image via FFmpeg');

  const remuxSuccess = await remuxToTelegramMp4(sampleVideo, remuxOutput);
  assert(remuxSuccess && fs.existsSync(remuxOutput), 'Faststart MP4 remux for Telegram streaming');

  // Clean up synthetic test files
  try {
    fs.unlinkSync(sampleVideo);
    fs.unlinkSync(sampleThumb);
    fs.unlinkSync(remuxOutput);
  } catch {}

  // TEST 5: Fallback Orchestrator with Failure Recovery
  console.log('\n--- 5. Testing Fallback Execution when an engine fails ---');
  const fallbackTaskId = `fallback_audit_${Date.now()}`;
  const fallbackTemp = path.join(config.tempDir, fallbackTaskId);
  fs.mkdirSync(fallbackTemp, { recursive: true });

  const fallbackTask: DownloadTask = {
    id: fallbackTaskId,
    originalUrl: 'https://httpstat.us/404', // Guaranteed 404
    chatId: 9999,
    messageId: 2,
    status: 'detecting',
    failedEngines: [],
    tempDir: fallbackTemp,
    startTime: Date.now(),
    abortController: new AbortController(),
    subprocesses: [],
  };

  const fallbackResult = await orchestrator.executeWithFallback(fallbackTask);
  assert(fallbackResult.success === false, 'Orchestrator handles 404 stream correctly');
  assert(fallbackTask.failedEngines.length > 0, 'Orchestrator recorded failed engines', `Failed count: ${fallbackTask.failedEngines.length}`);
  await cleanupTaskTemp(fallbackTask);

  // TEST 6: Real Downloader Pipeline with HLS (.m3u8) Stream
  console.log('\n--- 6. Testing Downloader Pipeline with Synthetic HLS (.m3u8) Manifest ---');
  const hlsLocalDir = path.join(config.tempDir, `hls_source_${Date.now()}`);
  fs.mkdirSync(hlsLocalDir, { recursive: true });
  const hlsManifest = path.join(hlsLocalDir, 'test_stream.m3u8');

  // Generate 2-second segmented HLS stream
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=25 -c:v libx264 -f hls -hls_time 1 -hls_list_size 0 "${hlsManifest}"`,
    { stdio: 'ignore' }
  );
  assert(fs.existsSync(hlsManifest), 'Generated test HLS playlist (.m3u8) with segments');

  const hlsTaskId = `hls_audit_${Date.now()}`;
  const hlsTemp = path.join(config.tempDir, hlsTaskId);
  fs.mkdirSync(hlsTemp, { recursive: true });

  const hlsTask: DownloadTask = {
    id: hlsTaskId,
    originalUrl: hlsManifest,
    chatId: 8888,
    messageId: 3,
    status: 'detecting',
    failedEngines: [],
    tempDir: hlsTemp,
    startTime: Date.now(),
    abortController: new AbortController(),
    subprocesses: [],
  };

  console.log('   Downloading HLS stream through fallback pipeline...');
  const hlsResult = await orchestrator.executeWithFallback(hlsTask, (text) => {
    console.log(`   [Progress] ${text}`);
  });

  assert(hlsResult.success === true, 'HLS Pipeline downloaded sample stream successfully', `Engine: ${hlsResult.engineName}`);
  if (hlsResult.outputPath) {
    const stat = fs.statSync(hlsResult.outputPath);
    assert(stat.size > 1000, 'Downloaded HLS MP4 output has valid size', `${stat.size} bytes`);
  }
  await cleanupTaskTemp(hlsTask);
  try {
    fs.rmSync(hlsLocalDir, { recursive: true, force: true });
  } catch {}

  // SUMMARY
  console.log('\n========================================================');
  console.log(` Self-Audit Results: \x1b[32m${passed} PASSED\x1b[0m, \x1b[31m${failed} FAILED\x1b[0m`);
  console.log('========================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSelfAudit().catch(err => {
  console.error('Audit fatal error:', err);
  process.exit(1);
});
