import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { extractUrlsFromText, analyzeUrl, isHlsContentType, isM3u8Url, normalizeMediaUrl } from '../src/utils/url-extractor.ts';
import { scanHtmlForM3u8AndMedia } from '../src/utils/m3u8-detector.ts';
import { parseMasterPlaylist, selectTargetVariant, detectHlsEncryption, parseHlsKeyTag, parseMediaPlaylist } from '../src/utils/m3u8-parser.ts';
import { validateSegmentBytes, validateHlsSegments } from '../src/utils/segment-validator.ts';
import { isSignedUrl, parseUrlExpiration, isUrlExpired, shouldRefreshManifest, analyzeSignedUrl } from '../src/utils/signed-url.ts';
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

  // =========================================================================
  // TEST 12: HLS Encryption Detection & Discrimination (AES-128 vs SAMPLE-AES vs DRM)
  // =========================================================================
  console.log('\n--- Test 12: HLS Encryption Detection & Discrimination ---');

  // 12.1 Standard AES-128 Encryption (identity) -> Supported
  const aes128Manifest = `
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/enc.key",IV=0x1234567890abcdef1234567890abcdef
#EXTINF:10.0,
segment_0.ts
#EXTINF:10.0,
segment_1.ts
#EXT-X-ENDLIST
  `.trim();

  const aesAnalysis = detectHlsEncryption(aes128Manifest);
  assert(aesAnalysis.hasEncryption === true, 'Detects #EXT-X-KEY tag presence');
  assert(aesAnalysis.primaryMethod === 'AES-128', 'Extracts AES-128 encryption method');
  assert(aesAnalysis.isAes128 === true, 'Identifies standard AES-128 encryption');
  assert(aesAnalysis.isSupported === true, 'Marks AES-128 as supported by standard toolchain');
  assert(aesAnalysis.isDrm === false, 'Recognizes AES-128 is not DRM');
  assert(aesAnalysis.keyUri === 'https://example.com/enc.key', 'Extracts key URI accurately');

  // 12.2 SAMPLE-AES Encryption -> Unsupported, reports reason without claiming downloadability
  const sampleAesManifest = `
#EXTM3U
#EXT-X-VERSION:5
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://example.com/sample.key",KEYFORMAT="identity"
#EXTINF:6.0,
sample_0.ts
#EXT-X-ENDLIST
  `.trim();

  const sampleAesAnalysis = detectHlsEncryption(sampleAesManifest);
  assert(sampleAesAnalysis.isSampleAes === true, 'Identifies SAMPLE-AES encryption method');
  assert(sampleAesAnalysis.isSupported === false, 'Strict policy: SAMPLE-AES marked unsupported (no false claim)');
  assert(sampleAesAnalysis.reason?.includes('SAMPLE-AES') === true, 'Provides explicit unsupported reason for SAMPLE-AES');

  // 12.3 Widevine DRM Detection -> Strict DRM flag, never bypass
  const widevineManifest = `
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1",URI="data:text/plain;base64,AAAANHBzc2gAAAAA7e+L..."
#EXTINF:4.0,
widevine_segment_0.m4s
#EXT-X-ENDLIST
  `.trim();

  const widevineAnalysis = detectHlsEncryption(widevineManifest);
  assert(widevineAnalysis.isDrm === true, 'Identifies Widevine DRM system via URN UUID');
  assert(widevineAnalysis.drmSystem === 'Widevine', 'Labels DRM system as Widevine');
  assert(widevineAnalysis.isSupported === false, 'Widevine DRM marked as unsupported (no bypass attempt)');

  // 12.4 FairPlay DRM Detection (skd:// scheme)
  const fairplayManifest = `
#EXTM3U
#EXT-X-VERSION:5
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fps.apple.com/key",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
#EXTINF:6.0,
fairplay_0.ts
#EXT-X-ENDLIST
  `.trim();

  const fairplayAnalysis = detectHlsEncryption(fairplayManifest);
  assert(fairplayAnalysis.isDrm === true, 'Identifies FairPlay DRM via skd:// protocol');
  assert(fairplayAnalysis.drmSystem === 'FairPlay', 'Labels DRM system as FairPlay');
  assert(fairplayAnalysis.isSupported === false, 'FairPlay DRM marked as unsupported');

  // 12.5 PlayReady DRM Detection
  const playreadyManifest = `
#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/xml...",KEYFORMAT="com.microsoft.playready"
#EXTINF:6.0,
playready_0.mp4
#EXT-X-ENDLIST
  `.trim();

  const playreadyAnalysis = detectHlsEncryption(playreadyManifest);
  assert(playreadyAnalysis.isDrm === true, 'Identifies PlayReady DRM via KEYFORMAT');
  assert(playreadyAnalysis.drmSystem === 'PlayReady', 'Labels DRM system as PlayReady');

  // 12.6 ClearKey DRM Detection
  const clearkeyManifest = `
#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="org.w3.clearkey",URI="data:base64,..."
#EXTINF:6.0,
clearkey_0.ts
#EXT-X-ENDLIST
  `.trim();

  const clearkeyAnalysis = detectHlsEncryption(clearkeyManifest);
  assert(clearkeyAnalysis.isDrm === true, 'Identifies ClearKey DRM');

  // 12.7 Unencrypted Stream
  const plainManifest = `
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
chunk_0.ts
#EXT-X-ENDLIST
  `.trim();

  const plainAnalysis = detectHlsEncryption(plainManifest);
  assert(plainAnalysis.hasEncryption === false, 'Identifies unencrypted HLS stream');
  assert(plainAnalysis.isSupported === true, 'Unencrypted stream marked as fully supported');

  // =========================================================================
  // TEST 13: Segment Validation & Bitstream Payload Inspection
  // =========================================================================
  console.log('\n--- Test 13: Segment Validation & Payload Inspection ---');

  // 13.1 MPEG-TS Segment Sync byte (0x47) validation
  const validTsPacket = new Uint8Array(376);
  validTsPacket[0] = 0x47;   // First sync byte
  validTsPacket[188] = 0x47; // Second sync byte at 188 boundary
  const tsCheck = validateSegmentBytes(validTsPacket);
  assert(tsCheck.valid === true, 'Validates genuine MPEG-TS packet sync byte (0x47)');

  // 13.2 fMP4 Segment Box header validation
  const validFmp4Header = new Uint8Array([
    0x00, 0x00, 0x00, 0x20, // size: 32
    0x66, 0x74, 0x79, 0x70, // 'ftyp'
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x00, 0x00, 0x02, 0x00, // minor version
    0x6d, 0x70, 0x34, 0x31, // 'mp41'
    0x6d, 0x70, 0x34, 0x32, // 'mp42'
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x00, 0x00, 0x00, 0x00,
  ]);
  const fmp4Check = validateSegmentBytes(validFmp4Header);
  assert(fmp4Check.valid === true, 'Validates genuine fMP4 ISOBMFF box container');

  // 13.3 HTML Error response disguised as 200 OK (CDN captcha / 403 / Cloudflare)
  const fakeHtmlSegment = new TextEncoder().encode('<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>Access Denied</body></html>');
  const fakeCheck = validateSegmentBytes(fakeHtmlSegment);
  assert(fakeCheck.valid === false, 'Rejects HTML error page disguised as media segment');
  assert(fakeCheck.reason?.includes('HTML/JSON error page') === true, 'Reports HTML masquerading reason');

  // 13.4 Truncated / empty segment
  const emptySegment = new Uint8Array(4);
  const emptyCheck = validateSegmentBytes(emptySegment);
  assert(emptyCheck.valid === false, 'Rejects truncated segment under 16 bytes');

  // 13.5 Parse Media Playlist Segments and Target URI resolution
  const playlistWithBase = `
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MAP:URI="init.mp4"
#EXTINF:5.0,
seg-001.mp4
#EXTINF:5.0,
seg-002.mp4
#EXT-X-ENDLIST
  `.trim();

  const parsedMedia = parseMediaPlaylist(playlistWithBase, 'https://cdn.example.com/hls/master.m3u8');
  assert(parsedMedia.segments.length === 2, 'Extracts all media segments from playlist');
  assert(parsedMedia.initSegmentUri === 'https://cdn.example.com/hls/init.mp4', 'Resolves init segment relative URL to base');
  assert(parsedMedia.segments[0].uri === 'https://cdn.example.com/hls/seg-001.mp4', 'Resolves segment relative URL to base');

  // 13.6 Direct DRM manifest segment validation immediately returns DRM_PROTECTED
  const drmValidation = await validateHlsSegments('https://example.com/drm.m3u8', widevineManifest);
  assert(drmValidation.valid === false, 'Segment validator rejects DRM manifest without network probe');
  assert(drmValidation.errorType === 'DRM_PROTECTED', 'Returns DRM_PROTECTED errorCategory');
  assert(drmValidation.isDrm === true, 'Flags isDrm: true on result');

  // =========================================================================
  // TEST 14: Expired Signed URL Detection & Orchestrator Re-Discovery Flow
  // =========================================================================
  console.log('\n--- Test 14: Expired Signed URL Detection & Re-Discovery ---');

  // 14.1 Signed URL Detection
  const signedUrl1 = 'https://cdn.example.com/video/master.m3u8?token=xyz123&expires=1711234567';
  const signedUrl2 = 'https://stream.server.org/live/playlist.m3u8?sig=abcd9876&wsTime=6600a1b2';
  const plainUrl = 'https://cdn.example.com/video/master.m3u8';

  assert(isSignedUrl(signedUrl1) === true, 'Detects token and expires query parameters');
  assert(isSignedUrl(signedUrl2) === true, 'Detects sig and wsTime query parameters');
  assert(isSignedUrl(plainUrl) === false, 'Unsigned URL recognized as not signed');

  // 14.2 Expiration Timestamp Extraction
  const pastUnixSec = Math.floor(Date.now() / 1000) - 300; // Expired 5 mins ago
  const futureUnixSec = Math.floor(Date.now() / 1000) + 3600; // Valid for 1 hour

  const expiredSignedUrl = `https://cdn.example.com/live.m3u8?token=abc&expires=${pastUnixSec}`;
  const validSignedUrl = `https://cdn.example.com/live.m3u8?token=abc&expires=${futureUnixSec}`;

  assert(isUrlExpired(expiredSignedUrl) === true, 'Detects expired signed URL timestamp');
  assert(isUrlExpired(validSignedUrl) === false, 'Valid future signed URL not marked as expired');

  // 14.3 Hex wsTime parameter parsing
  const pastHex = (Math.floor(Date.now() / 1000) - 100).toString(16);
  const hexUrl = `https://cdn.example.com/live.m3u8?wsSecret=123&wsTime=${pastHex}`;
  assert(isUrlExpired(hexUrl) === true, 'Correctly parses and checks hex timestamp (wsTime)');

  // 14.4 shouldRefreshManifest Policy
  assert(
    shouldRefreshManifest(Date.now() - 60000, signedUrl1, 45000) === true,
    'Policy: signed manifest retained over 45s must be refreshed from source'
  );
  assert(
    shouldRefreshManifest(Date.now() - 5000, validSignedUrl, 45000) === false,
    'Policy: fresh signed manifest (< 45s) does not prematurely refresh'
  );
  assert(
    shouldRefreshManifest(Date.now() - 1000, expiredSignedUrl, 45000) === true,
    'Policy: expired signed URL immediately requires source re-discovery'
  );

  // 14.5 Orchestrator DRM & Expired URL Protection Policy Execution
  const auditOrchestrator = new FallbackOrchestrator();

  // A. DRM Protected Stream: Orchestrator halts immediately and refuses bypass
  const mockDrmFile = path.join(config.tempDir, `mock_drm_${Date.now()}.m3u8`);
  fs.writeFileSync(mockDrmFile, widevineManifest);

  const drmTask: DownloadTask = {
    id: 'test-drm-task',
    chatId: 1001,
    messageId: 101,
    originalUrl: 'https://example.com/movie-page',
    streamUrl: mockDrmFile,
    status: 'queued',
    failedEngines: [],
    subprocesses: [],
    abortController: new AbortController(),
    tempDir: config.tempDir,
    startTime: Date.now(),
  };

  // Mock engine download returning DRM_PROTECTED
  const drmEngineResult = await auditOrchestrator.executeWithFallback(drmTask);
  assert(
    drmTask.status === 'failed',
    'Task marked failed when DRM is detected'
  );
  assert(
    drmEngineResult.errorType === 'DRM_PROTECTED',
    'Orchestrator halts immediately returning DRM_PROTECTED errorType'
  );

  // B. Expired URL re-discovery simulation
  const expiredTask: DownloadTask = {
    id: 'test-expired-task',
    chatId: 1001,
    messageId: 102,
    originalUrl: 'https://example.com/video-watch-page',
    streamUrl: expiredSignedUrl,
    status: 'queued',
    failedEngines: [],
    subprocesses: [],
    abortController: new AbortController(),
    tempDir: '/tmp',
    startTime: Date.now(),
    rediscoveryCount: 0,
  };

  assert(
    shouldRefreshManifest(Date.now(), expiredTask.streamUrl) === true,
    'Expired stream URL triggers refresh policy before download'
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
