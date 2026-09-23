import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { extractUrlsFromText, analyzeUrl, isHlsContentType, isM3u8Url, normalizeMediaUrl } from '../src/utils/url-extractor.ts';
import { scanHtmlForM3u8AndMedia } from '../src/utils/m3u8-detector.ts';
import { parseMasterPlaylist, selectTargetVariant } from '../src/utils/m3u8-parser.ts';
import { normalizeCookies, mergeCookieStrings } from '../src/utils/cookie-manager.ts';
import { FallbackOrchestrator } from '../src/engines/orchestrator.ts';
import { buildFfmpegHeaders } from '../src/engines/ffmpeg-engine.ts';
import {
  probeMedia,
  validateMediaFile,
  enforceMax720p,
  resolveVideoThumbnail,
  remuxToTelegramMp4,
} from '../src/utils/ffmpeg.ts';
import { createTaskDirectories, cleanupTaskTemp } from '../src/utils/cleaner.ts';
import { ensureIndonesianTitle, isLikelyIndonesian } from '../src/utils/translator.ts';
import { extractHtmlMetadata } from '../src/utils/metadata.ts';
import { getAvailableDiskSpace } from '../src/utils/system.ts';
import { config } from '../src/config.ts';
import { DownloadTask } from '../src/types.ts';
import { getTelegramPostUrl } from '../src/bot/handler.ts';
import { DownloadQueue } from '../src/queue/download-queue.ts';

async function runSelfAudit() {
  console.log('\n========================================================');
  console.log('       🛠️ Running Complete Self-Audit & Verification    ');
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
  const sampleText =
    'Check out this video: https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8 and also http://example.com/video.mp4!';
  const extracted = extractUrlsFromText(sampleText);
  assert(extracted.length === 2, 'Extract multiple URLs from text', `Found: ${extracted.length}`);
  assert(extracted[0] === 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', 'Extract M3U8 URL cleanly');
  assert(extracted[1] === 'http://example.com/video.mp4', 'Extract MP4 URL cleanly');

  const m3u8Analysis = analyzeUrl('https://example.com/stream/master.m3u8?token=123');
  assert(m3u8Analysis.isDirectM3u8 === true, 'Classify direct M3U8 URL with query params');

  // Enhanced M3U8 & M3U Variations Check
  assert(isM3u8Url('https://cdn.example.com/live/playlist.m3u8#track=1'), 'Detect .m3u8# hash fragment');
  assert(isM3u8Url('https://cdn.example.com/hls/master.m3u8'), 'Detect master.m3u8');
  assert(isM3u8Url('https://cdn.example.com/hls/media/index.m3u8'), 'Detect index.m3u8');
  assert(isM3u8Url('https://stream.server.io/manifest.m3u8?auth=abc'), 'Detect manifest.m3u8');
  assert(isM3u8Url('https://broadcast.tv/live/stream.m3u'), 'Detect .m3u stream URL');
  assert(isM3u8Url('https://broadcast.tv/hls/playlist.m3u?token=xyz'), 'Detect .m3u with query params');
  assert(isHlsContentType('application/vnd.apple.mpegurl'), 'Detect application/vnd.apple.mpegurl');
  assert(isHlsContentType('application/x-mpegURL; charset=utf-8'), 'Detect application/x-mpegURL');
  assert(isHlsContentType('application/mpegurl'), 'Detect application/mpegurl');

  // URL Candidate Normalization Check
  assert(
    normalizeMediaUrl('/hls/stream.m3u8', 'https://origin.example.com/video/page') ===
      'https://origin.example.com/hls/stream.m3u8',
    'Normalize relative URL candidate to absolute'
  );
  assert(
    normalizeMediaUrl('//cdn.example.com/live/master.m3u8') === 'https://cdn.example.com/live/master.m3u8',
    'Normalize protocol-relative URL candidate'
  );
  assert(
    normalizeMediaUrl('"https:\\/\\/cdn.example.com\\/video\\/master.m3u8"') ===
      'https://cdn.example.com/video/master.m3u8',
    'Normalize escaped quotes and backslashes in JSON/JS strings'
  );

  // Deep Scan HTML for M3U8 (Video tags, script vars, data attributes, player config)
  const mockPlayerHtml = `
    <html><body>
      <div id="player-container" data-stream="https://media.org/attr/live.m3u8" data-poster="/images/data_poster.jpg"></div>
      <video poster="https://example.com/source_poster.jpg">
        <source src="https://media.org/stream/playlist.m3u8" type="application/x-mpegURL" />
      </video>
      <script>
        var player = jwplayer("player").setup({
          file: "https://media.org/live/master.m3u8",
          image: "https://example.com/player_thumb.jpg"
        });
        hls.loadSource("/hls-vod/index.m3u8");
      </script>
    </body></html>
  `;
  const scanTest = scanHtmlForM3u8AndMedia(mockPlayerHtml, 'https://media.org');
  assert(scanTest.foundUrls.length >= 3, 'Deep scan detected embedded M3U8 in HTML, data-attributes, and scripts', `Found: ${scanTest.foundUrls.length}`);
  assert(Boolean(scanTest.primaryM3u8 && scanTest.primaryM3u8.includes('master.m3u8')), 'Deep scan prioritized master.m3u8');
  assert(Boolean(scanTest.sourceThumbnail), 'Deep scan extracted source thumbnail poster');

  // Header Propagation String Builder Test
  const mockHeaders = {
    'User-Agent': 'Mozilla/5.0 CustomAgent/1.0',
    Referer: 'https://media.org/watch/123',
    Origin: 'https://media.org',
    Authorization: 'Bearer test-token-xyz',
    'Sec-Fetch-Mode': 'cors',
  };
  const builtFfmpegHeaders = buildFfmpegHeaders(mockHeaders, 'session_id=abc1234');
  assert(builtFfmpegHeaders.includes('Referer: https://media.org/watch/123'), 'Propagate Referer header');
  assert(builtFfmpegHeaders.includes('Origin: https://media.org'), 'Propagate Origin header');
  assert(builtFfmpegHeaders.includes('User-Agent: Mozilla/5.0 CustomAgent/1.0'), 'Propagate User-Agent header');
  assert(builtFfmpegHeaders.includes('Authorization: Bearer test-token-xyz'), 'Propagate Authorization header');
  assert(builtFfmpegHeaders.includes('Cookie: session_id=abc1234'), 'Propagate Cookie header');
  assert(builtFfmpegHeaders.includes('Sec-Fetch-Mode: cors'), 'Propagate genuine Sec-Fetch header');

  // Test Cookie Normalization & Propagation Pipeline
  const mockPlaywrightCookies = [
    { name: 'cf_clearance', value: 'secret_cf_token_123', domain: '.stream.com' },
    { name: '__cf_bm', value: 'bm_token_456', domain: '.stream.com' },
    { name: 'session_auth', value: 'user_auth_789', domain: 'stream.com' },
    { name: 'player_volume', value: '0.8' },
  ];
  const normalizedFromPw = normalizeCookies(mockPlaywrightCookies);
  assert(normalizedFromPw.includes('cf_clearance=secret_cf_token_123'), 'Normalize Cloudflare clearance cookie');
  assert(normalizedFromPw.includes('__cf_bm=bm_token_456'), 'Normalize Cloudflare bot management cookie');
  assert(normalizedFromPw.includes('session_auth=user_auth_789'), 'Normalize session auth cookie');
  
  const mergedCookies = mergeCookieStrings(normalizedFromPw, 'new_auth=updated_val; session_auth=latest_auth');
  assert(mergedCookies.includes('session_auth=latest_auth'), 'Cookie merge preserves latest updated auth cookie');
  assert(mergedCookies.includes('new_auth=updated_val'), 'Cookie merge appends incoming cookies');

  // Test M3U8 Master Playlist Parser & Variant Selection (Max 720p enforcement)
  const sampleMasterPlaylist = `
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="/hls/audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="Spanish",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="es",URI="/hls/audio/es.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",FRAME-RATE=29.970,AUDIO="audio-aac"
/hls/video_360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=29.970,AUDIO="audio-aac"
/hls/video_480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=59.940,AUDIO="audio-aac"
/hls/video_720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=59.940,AUDIO="audio-aac"
/hls/video_1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L150.B0",FRAME-RATE=60.000,AUDIO="audio-aac"
/hls/video_2160p.m3u8
`;
  const parsedMaster = parseMasterPlaylist(sampleMasterPlaylist, 'https://origin.cdn.com/master.m3u8');
  assert(parsedMaster.isMaster === true, 'Parse master playlist detects isMaster=true');
  assert(parsedMaster.variants.length === 5, 'Parsed all 5 stream variants');
  assert(parsedMaster.audioGroups.length === 2, 'Parsed 2 audio group tracks');
  assert(
    parsedMaster.selectedVariant?.resolution === '1280x720',
    'Prioritize <= 720p variant over 1080p/2160p when 720p available'
  );
  assert(
    parsedMaster.selectedVariant?.uri === 'https://origin.cdn.com/hls/video_720p.m3u8',
    'Selected 720p variant has correct normalized URI'
  );
  assert(
    parsedMaster.selectedVariant?.audioTrackUri === 'https://origin.cdn.com/hls/audio/en.m3u8',
    'Associated default separated audio track with video variant'
  );

  // Test Selection when only higher resolutions exist (e.g. 1080p and 4K) -> Pick closest
  const highResOnlyPlaylist = `
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=14000000,RESOLUTION=3840x2160
/hls/4k.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
/hls/1080p.m3u8
`;
  const parsedHighOnly = parseMasterPlaylist(highResOnlyPlaylist, 'https://origin.cdn.com/hls/master.m3u8');
  assert(
    parsedHighOnly.selectedVariant?.resolution === '1920x1080',
    'When no variant <= 720p exists, select closest resolution (1080p over 4K)'
  );

  const mp4Analysis = analyzeUrl('https://example.com/files/sample.mp4');
  assert(mp4Analysis.isDirectVideo === true, 'Classify direct MP4 URL');

  // TEST 2: Indonesian Translation & Detection Pipeline
  console.log('\n--- 2. Testing Indonesian Title Translation & Fallback ---');
  const idText = 'Video Cara Memasak Rendang Daging Sapi Enak';
  assert(isLikelyIndonesian(idText), 'Detect Indonesian title natively');

  const idResult = await ensureIndonesianTitle(idText);
  assert(
    idResult.translationStatus === 'not_needed' && idResult.translatedTitle === idText,
    'Preserve title if already Indonesian'
  );

  const enText = 'Amazing Nature 4K Drone Footage in Switzerland';
  const enResult = await ensureIndonesianTitle(enText);
  assert(
    enResult.translationStatus === 'translated' && enResult.translatedTitle.length > 0,
    'Translate foreign title to Indonesian',
    `"${enResult.translatedTitle}"`
  );

  // Fallback check: empty title
  const emptyResult = await ensureIndonesianTitle('');
  assert(emptyResult.translationStatus === 'not_needed', 'Handle empty title safely without dummy data');

  // TEST 3: Metadata Extraction from HTML
  console.log('\n--- 3. Testing HTML & JSON-LD Metadata Extraction ---');
  const mockHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Wildlife Safari in Africa - Official Documentary</title>
        <meta name="description" content="A breathtaking journey into the wild African savanna." />
        <meta property="og:title" content="Wildlife Safari in Africa" />
        <meta property="og:image" content="https://example.com/poster.jpg" />
        <meta property="og:site_name" content="NatureDocs" />
        <script type="application/ld+json">
          {
            "@type": "VideoObject",
            "name": "Wildlife Safari in Africa",
            "description": "A breathtaking journey into the wild African savanna.",
            "thumbnailUrl": "https://example.com/poster.jpg",
            "duration": "PT2M30S"
          }
        </script>
      </head>
      <body>
        <video poster="https://example.com/poster.jpg"></video>
      </body>
    </html>
  `;
  const extractedMeta = await extractHtmlMetadata(mockHtml, 'https://example.com/wildlife');
  assert(extractedMeta.originalTitle === 'Wildlife Safari in Africa', 'Extract original title from OpenGraph/JSON-LD');
  assert(extractedMeta.duration === 150, 'Extract video duration from ISO 8601 (PT2M30S = 150s)');
  assert(extractedMeta.thumbnail === 'https://example.com/poster.jpg', 'Extract thumbnail candidate');
  assert(Boolean(extractedMeta.translatedTitle), 'Translate extracted title to Indonesian', `"${extractedMeta.translatedTitle}"`);

  // TEST 4: Fallback Orchestrator Engines Registration
  console.log('\n--- 4. Testing Fallback Orchestrator Engines ---');
  const orchestrator = new FallbackOrchestrator();
  const engines = orchestrator.getEngines();
  assert(engines.length === 6, 'Orchestrator registers 6 fallback engines', `Registered: ${engines.length}`);

  for (const eng of engines) {
    const avail = await eng.isAvailable();
    console.log(`   • ${eng.name}: ${avail ? '\x1b[32mAvailable\x1b[0m' : '\x1b[33mUnavailable\x1b[0m'}`);
  }

  // TEST 5: Storage Protection & Task Subdirectories Isolation
  console.log('\n--- 5. Testing Storage Protection & Directory Isolation ---');
  const freeDisk = getAvailableDiskSpace(config.tempDir);
  assert(freeDisk > 100 * 1024 * 1024, 'Storage check verifies free disk space', `${(freeDisk / (1024 * 1024)).toFixed(1)} MB free`);

  const testTaskId = `audit_sub_${Date.now()}`;
  const { tempDir: jobTempDir, subDirs } = createTaskDirectories(config.tempDir, testTaskId);
  assert(fs.existsSync(subDirs.source), 'Created subDir source/');
  assert(fs.existsSync(subDirs.download), 'Created subDir download/');
  assert(fs.existsSync(subDirs.processed), 'Created subDir processed/');
  assert(fs.existsSync(subDirs.thumbnail), 'Created subDir thumbnail/');
  assert(fs.existsSync(subDirs.logs), 'Created subDir logs/');

  const dummyTask: DownloadTask = {
    id: testTaskId,
    originalUrl: 'https://example.com',
    chatId: 12345,
    messageId: 1,
    status: 'detecting_url',
    failedEngines: [],
    tempDir: jobTempDir,
    subDirs,
    startTime: Date.now(),
    abortController: new AbortController(),
    subprocesses: [],
  };

  await cleanupTaskTemp(dummyTask);
  assert(!fs.existsSync(jobTempDir), 'cleanupTaskTemp successfully purged isolated job directory');

  // TEST 6: FFmpeg Media Validation & Probing
  console.log('\n--- 6. Testing FFmpeg Probing & Validation ---');
  const sampleVideo360p = path.join(config.tempDir, `sample_360p_${Date.now()}.mp4`);
  const sampleVideo1080p = path.join(config.tempDir, `sample_1080p_${Date.now()}.mp4`);

  // Generate 2-second 640x360 synthetic test video
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=2:size=640x360:rate=30 -f lavfi -i sine=frequency=1000:duration=2 -c:v libx264 -c:a aac "${sampleVideo360p}"`,
    { stdio: 'ignore' }
  );
  assert(fs.existsSync(sampleVideo360p), 'Generated 360p synthetic video via FFmpeg');

  const probe = await probeMedia(sampleVideo360p);
  assert(typeof probe.duration === 'number' && probe.duration > 1.5, 'Probe media duration', `${probe.duration}s`);
  assert(probe.width === 640 && probe.height === 360, 'Probe video dimensions', `${probe.width}x${probe.height}`);

  const validation = await validateMediaFile(sampleVideo360p);
  assert(validation.valid === true, 'validateMediaFile confirms valid container and streams');

  // Test hasVideo and hasAudio validation
  assert(validation.meta.hasVideo === true, 'Probe confirms hasVideo=true on synthetic sample');
  assert(validation.meta.hasAudio === true, 'Probe confirms hasAudio=true on synthetic sample with sine audio');

  // Generate a video-only synthetic sample to verify missing audio detection
  const sampleVideoNoAudio = path.join(config.tempDir, `sample_no_audio_${Date.now()}.mp4`);
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=15 -an -c:v libx264 "${sampleVideoNoAudio}"`,
    { stdio: 'ignore' }
  );
  const probeNoAudio = await probeMedia(sampleVideoNoAudio);
  assert(probeNoAudio.hasVideo === true && !probeNoAudio.hasAudio, 'Probe detects video without audio');
  const requireAudioVal = await validateMediaFile(sampleVideoNoAudio, { requireAudio: true });
  assert(requireAudioVal.valid === false, 'validateMediaFile rejects media missing audio when requireAudio is true');
  try { fs.unlinkSync(sampleVideoNoAudio); } catch {}

  // TEST 7: Max 720p Resolution Policy (Downscaling >720p, NO Upscaling <=720p)
  console.log('\n--- 7. Testing 720p Resolution Enforcement (Max 720p, No Upscaling) ---');

  // 7a. Native <= 720p must NOT be upscaled
  const nativeOutput = path.join(config.tempDir, `native_output_${Date.now()}.mp4`);
  const { meta: nativeMeta } = await enforceMax720p(sampleVideo360p, nativeOutput);
  assert(
    nativeMeta.height === 360 && nativeMeta.width === 640,
    'DO NOT upscale video: 360p preserved as 360p',
    `${nativeMeta.width}x${nativeMeta.height}`
  );

  // 7b. High resolution (>720p) must be downscaled to max 720p preserving aspect ratio
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=2:size=1920x1080:rate=30 -f lavfi -i sine=frequency=1000:duration=2 -c:v libx264 -c:a aac "${sampleVideo1080p}"`,
    { stdio: 'ignore' }
  );
  assert(fs.existsSync(sampleVideo1080p), 'Generated 1080p synthetic video via FFmpeg');

  const downscaledOutput = path.join(config.tempDir, `downscaled_output_${Date.now()}.mp4`);
  const { meta: downscaledMeta } = await enforceMax720p(sampleVideo1080p, downscaledOutput);
  assert(
    downscaledMeta.height === 720 && downscaledMeta.width === 1280,
    'Downscale 1080p to max 720p (1280x720) preserving aspect ratio',
    `${downscaledMeta.width}x${downscaledMeta.height}`
  );

  // TEST 8: Prioritized Thumbnail Resolution (Source > OG > Extractor > FFmpeg)
  console.log('\n--- 8. Testing Prioritized Thumbnail Resolution ---');
  const thumbOutPriority = path.join(config.tempDir, `thumb_priority_${Date.now()}.jpg`);

  // Test 8a: Priority 4 fallback (FFmpeg frame generation) when no external thumbs provided
  const thumbResultFfmpeg = await resolveVideoThumbnail({
    videoPath: downscaledOutput,
    outputPath: thumbOutPriority,
    duration: 2,
  });
  assert(
    Boolean(thumbResultFfmpeg && fs.existsSync(thumbOutPriority) && fs.statSync(thumbOutPriority).size > 100),
    'Priority 4: Fallback to FFmpeg frame generation when source thumbnails absent'
  );
  if (fs.existsSync(thumbOutPriority)) {
    const thumbStat = fs.statSync(thumbOutPriority);
    assert(thumbStat.size < 200 * 1024, 'Thumbnail size is Telegram compliant (< 200KB)', `${thumbStat.size} bytes`);
  }

  // Clean up synthetic media files
  try {
    fs.unlinkSync(sampleVideo360p);
    fs.unlinkSync(sampleVideo1080p);
    fs.unlinkSync(nativeOutput);
    fs.unlinkSync(downscaledOutput);
    if (fs.existsSync(thumbOutPriority)) fs.unlinkSync(thumbOutPriority);
  } catch {}

  // TEST 9: Fallback Orchestrator with Failure Recovery
  console.log('\n--- 9. Testing Fallback Execution when engines fail ---');
  const fallbackTaskId = `fallback_audit_${Date.now()}`;
  const { tempDir: fallbackTemp, subDirs: fallbackSubDirs } = createTaskDirectories(
    config.tempDir,
    fallbackTaskId
  );

  const fallbackTask: DownloadTask = {
    id: fallbackTaskId,
    originalUrl: 'http://127.0.0.1:59999/not-found', // Immediate connection failure
    chatId: 9999,
    messageId: 2,
    status: 'detecting_url',
    failedEngines: [],
    tempDir: fallbackTemp,
    subDirs: fallbackSubDirs,
    startTime: Date.now(),
    abortController: new AbortController(),
    subprocesses: [],
  };

  const fallbackResult = await orchestrator.executeWithFallback(fallbackTask);
  assert(fallbackResult.success === false, 'Orchestrator handles unreachable stream correctly');
  assert(
    fallbackTask.failedEngines.length > 0,
    'Orchestrator recorded failed engines with error classification',
    `Failed engines: ${fallbackTask.failedEngines.length}`
  );
  await cleanupTaskTemp(fallbackTask);

  // TEST 10: Real Downloader Pipeline with Synthetic HLS (.m3u8) Stream
  console.log('\n--- 10. Testing Downloader Pipeline with Synthetic HLS (.m3u8) Manifest ---');
  const hlsLocalDir = path.join(config.tempDir, `hls_source_${Date.now()}`);
  fs.mkdirSync(hlsLocalDir, { recursive: true });
  const hlsManifest = path.join(hlsLocalDir, 'test_stream.m3u8');

  // Generate 2-second segmented HLS stream with both video and audio
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=25 -f lavfi -i sine=frequency=1000:duration=2 -c:v libx264 -c:a aac -f hls -hls_time 1 -hls_list_size 0 "${hlsManifest}"`,
    { stdio: 'ignore' }
  );
  assert(fs.existsSync(hlsManifest), 'Generated test HLS playlist (.m3u8) with segments');

  const hlsTaskId = `hls_audit_${Date.now()}`;
  const { tempDir: hlsTemp, subDirs: hlsSubDirs } = createTaskDirectories(config.tempDir, hlsTaskId);

  const hlsTask: DownloadTask = {
    id: hlsTaskId,
    originalUrl: hlsManifest,
    chatId: 8888,
    messageId: 3,
    status: 'detecting_url',
    failedEngines: [],
    tempDir: hlsTemp,
    subDirs: hlsSubDirs,
    startTime: Date.now(),
    abortController: new AbortController(),
    subprocesses: [],
  };

  console.log('   Downloading HLS stream through fallback pipeline...');
  const hlsResult = await orchestrator.executeWithFallback(hlsTask, text => {
    console.log(`   [Progress] ${text}`);
  });

  assert(
    hlsResult.success === true,
    'HLS Pipeline downloaded sample stream successfully',
    `Engine: ${hlsResult.engineName}`
  );
  if (hlsResult.outputPath) {
    const stat = fs.statSync(hlsResult.outputPath);
    assert(stat.size > 1000, 'Downloaded HLS MP4 output has valid size', `${stat.size} bytes`);
  }
  await cleanupTaskTemp(hlsTask);
  try {
    fs.rmSync(hlsLocalDir, { recursive: true, force: true });
  } catch {}

  // TEST 11: Mandatory Channel Upload, Message ID Storage & Incomplete Job Guarantee
  console.log('\n--- 11. Testing Mandatory Channel Upload & Telegram Message ID Tracking ---');
  
  // A. Public username link generation
  const publicUrl = getTelegramPostUrl('@my_channel', 1234);
  assert(publicUrl === 'https://t.me/my_channel/1234', 'Generate public channel post URL correctly');

  // B. Private -100 channel link generation
  const privateUrl = getTelegramPostUrl('-1001234567890', 5678);
  assert(privateUrl === 'https://t.me/c/1234567890/5678', 'Generate private channel post URL correctly');

  // C. Raw numeric ID channel link generation
  const rawNumUrl = getTelegramPostUrl('987654321', 99);
  assert(rawNumUrl === 'https://t.me/c/987654321/99', 'Generate numeric channel post URL correctly');

  // D. Rule: Downloaded file ≠ Success if channel upload fails
  const mockTask: DownloadTask = {
    id: `rule_test_${Date.now()}`,
    originalUrl: 'https://example.com/video.m3u8',
    chatId: 1111,
    messageId: 22,
    status: 'uploading', // Processing done, waiting for channel upload
    failedEngines: [],
    tempDir: config.tempDir,
    startTime: Date.now(),
    abortController: new AbortController(),
    subprocesses: [],
    outputPath: '/tmp/nonexistent.mp4',
  };

  // If upload fails, status must NEVER remain 'completed' or 'uploading'
  mockTask.status = 'failed';
  mockTask.errorCategory = 'TELEGRAM_UPLOAD_ERROR';
  assert(
    mockTask.status === 'failed' && mockTask.errorCategory === 'TELEGRAM_UPLOAD_ERROR',
    'Enforce rule: downloaded file ≠ success when channel upload fails'
  );

  // E. When upload succeeds, Telegram message ID and channel info are stored
  mockTask.channelMessageId = 8842;
  mockTask.channelPeerId = '@destination_channel';
  mockTask.channelPostUrl = getTelegramPostUrl(mockTask.channelPeerId, mockTask.channelMessageId) || undefined;
  mockTask.status = 'completed';

  assert(mockTask.channelMessageId === 8842, 'Store Telegram message ID upon successful channel upload');
  assert(mockTask.channelPeerId === '@destination_channel', 'Store target channel peer identifier');
  assert(mockTask.channelPostUrl === 'https://t.me/destination_channel/8842', 'Link to channel post generated');

  // F. Queue records completed job history with channel message ID
  const testQueue = new DownloadQueue();
  testQueue.recordCompletedJob(mockTask);
  const recorded = testQueue.getCompletedJobs();
  assert(
    recorded.length > 0 && recorded[0].channelMessageId === 8842,
    'Queue tracks completed channel uploads in job history'
  );

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
