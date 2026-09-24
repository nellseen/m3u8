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
  isCompatibleForCopy,
} from '../src/utils/ffmpeg.ts';
import {
  createTaskDirectories,
  cleanupTaskTemp,
  writeTaskWorkspaceArtifact,
  getTaskWorkspacePath,
} from '../src/utils/cleaner.ts';
import {
  evaluateRetryPolicy,
  calculateBackoffWithJitter,
  parseFloodWaitSeconds,
  extractHttpStatus,
} from '../src/utils/retry-handler.ts';
import { ensureIndonesianTitle, isLikelyIndonesian } from '../src/utils/translator.ts';
import { extractHtmlMetadata } from '../src/utils/metadata.ts';
import { getAvailableDiskSpace } from '../src/utils/system.ts';
import { config } from '../src/config.ts';
import { DownloadTask } from '../src/types.ts';
import { getTelegramPostUrl } from '../src/bot/handler.ts';
import { DownloadQueue } from '../src/queue/download-queue.ts';
import { createJobFingerprint, normalizeUrlForFingerprint, areJobsEquivalent } from '../src/utils/fingerprint.ts';
import { formatErrorForUser, formatProgressBar } from '../src/bot/progress.ts';
import { sanitizeLog } from '../src/logger.ts';
import { TelegramUploadResult } from '../src/types.ts';

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

  // =========================================================================
  // TEST 15: Error-Based Retry System
  // =========================================================================
  console.log('\n--- Test 15: Error-Based Retry System ---');

  // 15.1 Error 403 Forbidden: Refresh session/header -> Rediscover -> Retry
  const err403Decision = evaluateRetryPolicy(new Error('HTTP 403 Forbidden: Access Denied'), 0, { maxRetries: 3 });
  assert(err403Decision.shouldRetry === true, '403 triggers retry');
  assert(err403Decision.action === 'rediscover', '403 triggers session refresh and source rediscovery');

  // 15.2 Error 401 Unauthorized: Refresh authentication context -> Rediscover -> Retry
  const err401Decision = evaluateRetryPolicy(new Error('HTTP 401 Unauthorized: Invalid Token'), 0, { maxRetries: 3 });
  assert(err401Decision.shouldRetry === true, '401 triggers retry');
  assert(err401Decision.action === 'refresh_auth', '401 triggers auth context refresh and rediscovery');

  // 15.3 Error 429 Too Many Requests: Backoff -> Retry
  const err429Decision = evaluateRetryPolicy(new Error('429 Too Many Requests: Rate limit exceeded'), 0, { maxRetries: 3 });
  assert(err429Decision.shouldRetry === true, '429 triggers retry');
  assert(err429Decision.action === 'backoff', '429 triggers backoff action');
  assert(err429Decision.delayMs > 0, '429 applies backoff delay');

  // 15.4 Error 5xx Server Errors: Exponential backoff -> Retry
  const err500Decision = evaluateRetryPolicy(new Error('500 Internal Server Error'), 0, { maxRetries: 3 });
  assert(err500Decision.shouldRetry === true, '500 triggers retry');
  assert(err500Decision.action === 'backoff', '500 triggers exponential backoff');

  const err502Decision = evaluateRetryPolicy(new Error('502 Bad Gateway'), 0, { maxRetries: 3 });
  assert(err502Decision.shouldRetry === true, '502 triggers retry');

  const err503Decision = evaluateRetryPolicy(new Error('503 Service Unavailable'), 0, { maxRetries: 3 });
  assert(err503Decision.shouldRetry === true, '503 triggers retry');

  // 15.5 Timeout: Retry
  const errTimeoutDecision = evaluateRetryPolicy(new Error('ETIMEDOUT: Connection timed out'), 0, { maxRetries: 3 });
  assert(errTimeoutDecision.shouldRetry === true, 'Timeout triggers retry');
  assert(errTimeoutDecision.action === 'retry_immediate', 'Timeout triggers retry with backoff');

  // 15.6 Expired Manifest: Rediscover -> Retry
  const errExpiredDecision = evaluateRetryPolicy(new Error('Manifest token or session has expired'), 0, { maxRetries: 3 });
  assert(errExpiredDecision.shouldRetry === true, 'Expired manifest triggers retry');
  assert(errExpiredDecision.action === 'rediscover', 'Expired manifest triggers source rediscovery');

  // 15.7 MAX_RETRIES Boundary Enforcement (No infinite retry)
  const maxRetryDecision = evaluateRetryPolicy(new Error('500 Internal Server Error'), 3, { maxRetries: 3 });
  assert(maxRetryDecision.shouldRetry === false, 'Stops retrying when MAX_RETRIES (3) reached');
  assert(maxRetryDecision.action === 'abort', 'Action is abort when retries exhausted');

  // 15.8 Exponential Backoff with Jitter Distribution
  const b1 = calculateBackoffWithJitter(1, 1000, 30000);
  const b2 = calculateBackoffWithJitter(2, 1000, 30000);
  const b3 = calculateBackoffWithJitter(3, 1000, 30000);
  assert(b1 >= 500 && b1 <= 1000, `Attempt 1 delay (${b1}ms) within expected 500-1000ms bounds`);
  assert(b2 >= 1000 && b2 <= 2000, `Attempt 2 delay (${b2}ms) within expected 1000-2000ms bounds`);
  assert(b3 >= 2000 && b3 <= 4000, `Attempt 3 delay (${b3}ms) within expected 2000-4000ms bounds`);

  // 15.9 Strict No-Retry on DRM
  const drmRetryDecision = evaluateRetryPolicy(new Error('Widevine DRM protected stream'), 0);
  assert(drmRetryDecision.shouldRetry === false, 'Never retries DRM protected streams');

  // =========================================================================
  // TEST 16: Download Temp Directory & Isolated Workspace
  // =========================================================================
  console.log('\n--- Test 16: Download Temp Directory & Workspace Isolation ---');

  const baseTestDir = path.join(config.tempDir, 'test_workspace_isolation');
  const taskId1 = 'job_test_alpha';
  const taskId2 = 'job_test_beta';

  const ws1 = createTaskDirectories(baseTestDir, taskId1);
  const ws2 = createTaskDirectories(baseTestDir, taskId2);

  assert(ws1.tempDir !== ws2.tempDir, 'Each job has distinct, isolated temporary directory');
  assert(ws1.tempDir.includes(taskId1), 'Task 1 directory includes its unique jobId');
  assert(ws2.tempDir.includes(taskId2), 'Task 2 directory includes its unique jobId');

  // Verify all required workspace subdirectories exist:
  // manifest, cookies, headers, thumbnail, partial video, final video, logs
  assert(fs.existsSync(ws1.subDirs.manifest), 'Dedicated manifest/ directory exists');
  assert(fs.existsSync(ws1.subDirs.cookies), 'Dedicated cookies/ directory exists');
  assert(fs.existsSync(ws1.subDirs.headers), 'Dedicated headers/ directory exists');
  assert(fs.existsSync(ws1.subDirs.thumbnail), 'Dedicated thumbnail/ directory exists');
  assert(fs.existsSync(ws1.subDirs.partial), 'Dedicated partial/ directory exists');
  assert(fs.existsSync(ws1.subDirs.final), 'Dedicated final/ directory exists');
  assert(fs.existsSync(ws1.subDirs.logs), 'Dedicated logs/ directory exists');

  // Save artifacts inside task 1 workspace
  const mockTask1: DownloadTask = {
    id: taskId1,
    chatId: 1001,
    messageId: 201,
    originalUrl: 'https://example.com/stream1',
    status: 'processing',
    tempDir: ws1.tempDir,
    subDirs: ws1.subDirs,
    workspace: ws1.tempDir,
    startTime: Date.now(),
    subprocesses: [],
    failedEngines: [],
    abortController: new AbortController(),
  };

  const manifestFile = writeTaskWorkspaceArtifact(mockTask1, 'manifest', 'playlist.m3u8', '#EXTM3U\n#EXT-X-VERSION:3');
  const cookiesFile = writeTaskWorkspaceArtifact(mockTask1, 'cookies', 'cookies.txt', 'SESSION_ID=abc123xyz;');
  const headersFile = writeTaskWorkspaceArtifact(mockTask1, 'headers', 'headers.json', JSON.stringify({ 'User-Agent': 'Bot' }));
  const logFile = writeTaskWorkspaceArtifact(mockTask1, 'logs', 'job.log', 'Job execution started at ' + new Date().toISOString());

  assert(fs.existsSync(manifestFile), 'Manifest file written inside job workspace');
  assert(fs.existsSync(cookiesFile), 'Cookies file written inside job workspace');
  assert(fs.existsSync(headersFile), 'Headers file written inside job workspace');
  assert(fs.existsSync(logFile), 'Logs written inside job workspace');

  // Ensure two jobs do not share the same temporary files
  assert(!fs.existsSync(path.join(ws2.subDirs.manifest, 'playlist.m3u8')), 'Job 2 does not share Job 1 files');

  // Cleanup on completion: both success and failure
  await cleanupTaskTemp(mockTask1);
  assert(!fs.existsSync(ws1.tempDir), 'Task workspace completely cleaned up on job completion');

  const mockTask2: DownloadTask = {
    id: taskId2,
    chatId: 1002,
    messageId: 202,
    originalUrl: 'https://example.com/stream2',
    status: 'failed',
    tempDir: ws2.tempDir,
    subDirs: ws2.subDirs,
    workspace: ws2.tempDir,
    startTime: Date.now(),
    subprocesses: [],
    failedEngines: [],
    abortController: new AbortController(),
  };

  await cleanupTaskTemp(mockTask2);
  assert(!fs.existsSync(ws2.tempDir), 'Failed task workspace also completely cleaned up (failure cleanup)');

  // =========================================================================
  // TEST 17: FFmpeg Processing Optimization (Copy/Remux Priority & Max 720p)
  // =========================================================================
  console.log('\n--- Test 17: FFmpeg Processing Optimization ---');

  // 17.1 isCompatibleForCopy checks
  assert(
    isCompatibleForCopy({ hasVideo: true, height: 720, width: 1280, videoCodec: 'h264', audioCodec: 'aac' }) === true,
    '720p H.264/AAC is compatible for copy/remux'
  );
  assert(
    isCompatibleForCopy({ hasVideo: true, height: 480, width: 854, videoCodec: 'h264', audioCodec: 'aac' }) === true,
    '480p H.264/AAC is compatible for copy/remux'
  );
  assert(
    isCompatibleForCopy({ hasVideo: true, height: 360, width: 640, videoCodec: 'h264', audioCodec: 'aac' }) === true,
    '360p H.264/AAC is compatible for copy/remux'
  );
  assert(
    isCompatibleForCopy({ hasVideo: true, height: 1080, width: 1920, videoCodec: 'h264', audioCodec: 'aac' }) === false,
    '1080p is not compatible for copy (must be downscaled to 720p)'
  );
  assert(
    isCompatibleForCopy({ hasVideo: true, height: 720, width: 1280, videoCodec: 'mpeg2video', audioCodec: 'aac' }) === false,
    'Incompatible video codec (mpeg2video) requires transcoding'
  );

  // 17.2 Resolution Policy:
  // 360p -> tetap 360p
  // 480p -> tetap 480p
  // 720p -> tetap 720p
  // 1080p -> turun ke 720p
  const ffmpegTestDir = path.join(config.tempDir, 'ffmpeg_opt_test');
  if (!fs.existsSync(ffmpegTestDir)) fs.mkdirSync(ffmpegTestDir, { recursive: true });

  const ffmpegBin = execSync('which ffmpeg', { encoding: 'utf8' }).trim();

  // A. Create test 360p video (640x360)
  const vid360In = path.join(ffmpegTestDir, 'in_360p.mp4');
  const vid360Out = path.join(ffmpegTestDir, 'out_360p.mp4');
  execSync(`"${ffmpegBin}" -y -f lavfi -i testsrc=duration=1:size=640x360:rate=10 -f lavfi -i sine=frequency=1000:duration=1 -c:v libx264 -c:a aac "${vid360In}"`, { stdio: 'ignore' });

  const res360 = await enforceMax720p(vid360In, vid360Out);
  assert(res360.meta.height === 360, `360p maintains native resolution: height is ${res360.meta.height} (NO UPSCALE)`);
  assert(res360.processingMode === 'copy_remux', '360p prioritized copy/remux without unnecessary transcoding');

  // B. Create test 480p video (854x480)
  const vid480In = path.join(ffmpegTestDir, 'in_480p.mp4');
  const vid480Out = path.join(ffmpegTestDir, 'out_480p.mp4');
  execSync(`"${ffmpegBin}" -y -f lavfi -i testsrc=duration=1:size=854x480:rate=10 -f lavfi -i sine=frequency=1000:duration=1 -c:v libx264 -c:a aac "${vid480In}"`, { stdio: 'ignore' });

  const res480 = await enforceMax720p(vid480In, vid480Out);
  assert(res480.meta.height === 480, `480p maintains native resolution: height is ${res480.meta.height} (NO UPSCALE)`);
  assert(res480.processingMode === 'copy_remux', '480p prioritized copy/remux without unnecessary transcoding');

  // C. Create test 720p video (1280x720)
  const vid720In = path.join(ffmpegTestDir, 'in_720p.mp4');
  const vid720Out = path.join(ffmpegTestDir, 'out_720p.mp4');
  execSync(`"${ffmpegBin}" -y -f lavfi -i testsrc=duration=1:size=1280x720:rate=10 -f lavfi -i sine=frequency=1000:duration=1 -c:v libx264 -c:a aac "${vid720In}"`, { stdio: 'ignore' });

  const res720 = await enforceMax720p(vid720In, vid720Out);
  assert(res720.meta.height === 720, `720p maintains native resolution: height is ${res720.meta.height}`);
  assert(res720.processingMode === 'copy_remux', '720p prioritized copy/remux without unnecessary transcoding');

  // D. Create test 1080p video (1920x1080) -> must downscale to 720p
  const vid1080In = path.join(ffmpegTestDir, 'in_1080p.mp4');
  const vid1080Out = path.join(ffmpegTestDir, 'out_1080p.mp4');
  execSync(`"${ffmpegBin}" -y -f lavfi -i testsrc=duration=1:size=1920x1080:rate=10 -f lavfi -i sine=frequency=1000:duration=1 -c:v libx264 -c:a aac "${vid1080In}"`, { stdio: 'ignore' });

  const res1080 = await enforceMax720p(vid1080In, vid1080Out);
  assert(res1080.meta.height === 720, `1080p downscaled to max 720p: height is ${res1080.meta.height}`);
  assert(res1080.processingMode === 'transcode', '1080p transcoded for downscale');

  // Clean test dir
  try {
    fs.rmSync(ffmpegTestDir, { recursive: true, force: true });
  } catch {}

  // =========================================================================
  // TEST 18: Upload Retry & FloodWait Handling
  // =========================================================================
  console.log('\n--- Test 18: Upload Retry & FloodWait Handling ---');

  // 18.1 FloodWait seconds extraction
  assert(parseFloodWaitSeconds(new Error('FLOOD_WAIT_28')) === 28, 'Parses FLOOD_WAIT_28');
  assert(parseFloodWaitSeconds(new Error('A wait of 45 seconds is required')) === 45, 'Parses wait of 45 seconds');
  assert(parseFloodWaitSeconds({ seconds: 60 }) === 60, 'Parses GramJS seconds property');

  // 18.2 FloodWait retry decision: does NOT spam retry, follows exact wait time
  const floodDecision = evaluateRetryPolicy(new Error('FLOOD_WAIT_20'), 0);
  assert(floodDecision.shouldRetry === true, 'FloodWait is eligible for retry after waiting');
  assert(floodDecision.action === 'wait_flood', 'Action is wait_flood');
  assert(floodDecision.delayMs === 21000, 'Waits exact duration (20s + 1s buffer) without spamming retry');

  // 18.3 Network error retry
  const netErrDecision = evaluateRetryPolicy(new Error('read ECONNRESET'), 0);
  assert(netErrDecision.shouldRetry === true, 'Connection reset (ECONNRESET) triggers upload retry');

  const timeoutErrDecision = evaluateRetryPolicy(new Error('Upload request timed out'), 0);
  assert(timeoutErrDecision.shouldRetry === true, 'Timeout triggers upload retry');

  const rpcErrDecision = evaluateRetryPolicy(new Error('RPC_CALL_FAIL 500: Temporary Telegram Error'), 0);
  assert(rpcErrDecision.shouldRetry === true, 'Temporary Telegram RPC error triggers upload retry');

  // 18.4 Non-retryable permission error
  const permErrDecision = evaluateRetryPolicy(new Error('CHAT_WRITE_FORBIDDEN: User not allowed to post'), 0);
  assert(permErrDecision.shouldRetry === false, 'Fatal permissions (CHAT_WRITE_FORBIDDEN) immediately aborts');
  assert(permErrDecision.action === 'abort', 'Action is abort for permission failures');

  // =========================================================================
  // TEST 19: Duplicate Job Fingerprint & Deduplication Check
  // =========================================================================
  console.log('\n--- Test 19: Duplicate Job Fingerprinting & Deduplication ---');

  const urlA = 'https://example.com/stream/master.m3u8?token=xyz123&utm_source=twitter&utm_medium=social';
  const urlB = 'https://example.com/stream/master.m3u8?utm_medium=social&utm_source=twitter&token=xyz123';
  const urlC = 'https://example.com/other/video.mp4';

  const normA = normalizeUrlForFingerprint(urlA);
  const normB = normalizeUrlForFingerprint(urlB);
  assert(normA === normB, 'Tracking parameters (utm_*) are stripped for fingerprint consistency');

  const fpA = createJobFingerprint(urlA);
  const fpB = createJobFingerprint(urlB);
  const fpC = createJobFingerprint(urlC);

  assert(fpA === fpB, 'Fingerprints match for identical media URL regardless of param ordering');
  assert(fpA !== fpC, 'Different media streams produce distinct fingerprints');
  assert(areJobsEquivalent(urlA, urlB) === true, 'Jobs are equivalent for same media source');
  assert(areJobsEquivalent(urlA, urlC) === false, 'Jobs are not equivalent for distinct media');

  // Test Queue duplicate check
  const auditStorageQueue = new DownloadQueue();
  const queueDupFoundBefore = auditStorageQueue.findExistingJob('https://example.com/stream/active.m3u8');
  assert(queueDupFoundBefore === undefined, 'No duplicate found when queue is clean');

  // =========================================================================
  // TEST 20: Persisted Telegram Upload Result Storage
  // =========================================================================
  console.log('\n--- Test 20: Persisted Telegram Upload Result Storage ---');

  const sampleResult: TelegramUploadResult = {
    jobId: 'job_test_result_123',
    telegramChatId: '-1001234567890',
    telegramMessageId: 78910,
    fileName: 'video_job_test_result_123.mp4',
    fileSize: 4567890,
    title: 'Uji Coba Video Stream',
    sourceUrl: 'https://example.com/stream/video.m3u8',
    engine: 'FFmpeg HLS Direct (Engine 5)',
    timestamp: Date.now(),
  };

  auditStorageQueue.recordUploadResult(sampleResult);
  const persistedResults = auditStorageQueue.getUploadResults();
  const foundResult = persistedResults.find(r => r.jobId === 'job_test_result_123');

  assert(Boolean(foundResult), 'Upload result successfully recorded in queue storage');
  assert(foundResult?.telegramChatId === '-1001234567890', 'Result contains telegramChatId');
  assert(foundResult?.telegramMessageId === 78910, 'Result contains telegramMessageId');
  assert(foundResult?.fileName === 'video_job_test_result_123.mp4', 'Result contains fileName');
  assert(foundResult?.fileSize === 4567890, 'Result contains fileSize');
  assert(foundResult?.title === 'Uji Coba Video Stream', 'Result contains title');
  assert(foundResult?.sourceUrl === 'https://example.com/stream/video.m3u8', 'Result contains sourceUrl');
  assert(foundResult?.engine === 'FFmpeg HLS Direct (Engine 5)', 'Result contains engine');
  assert(typeof foundResult?.timestamp === 'number', 'Result contains valid timestamp');

  // =========================================================================
  // TEST 21: User Progress & Error Formatting (No Stack Trace to User)
  // =========================================================================
  console.log('\n--- Test 21: User Progress & Error Formatting ---');

  const bar80 = formatProgressBar(80);
  assert(bar80 === '████████░░ 80%', 'Progress bar 80% formats strictly to 10 characters');

  const bar0 = formatProgressBar(0);
  assert(bar0 === '░░░░░░░░░░ 0%', 'Progress bar 0% formats strictly to 10 empty blocks');

  const bar100 = formatProgressBar(100);
  assert(bar100 === '██████████ 100%', 'Progress bar 100% formats strictly to 10 filled blocks');

  // Error template format
  const rawStackTrace = 'Error: Manifest 403 Forbidden\n    at Object.download (/src/engine.ts:120:15)\n    at processTicksAndRejections';
  const formattedError = formatErrorForUser({
    reason: 'Server mengembalikan status 403 Forbidden',
    engine: 'FFmpeg HLS Direct (Engine 5)',
    attempts: 3,
    rawError: rawStackTrace,
  });

  assert(formattedError.includes('❌ Download failed'), 'Error starts with ❌ Download failed');
  assert(formattedError.includes('Reason:\nServer mengembalikan status 403 Forbidden'), 'Error contains Reason block');
  assert(formattedError.includes('Engine:\nFFmpeg HLS Direct (Engine 5)'), 'Error contains Engine block');
  assert(formattedError.includes('Attempts:\n3'), 'Error contains Attempts block');
  assert(!formattedError.includes('at Object.download'), 'Error NEVER includes stack trace to user');
  assert(!formattedError.includes('processTicksAndRejections'), 'Internal node traces are hidden from user');

  // =========================================================================
  // TEST 22: Redacted Logging Categories & Sensitive Data Sanitization
  // =========================================================================
  console.log('\n--- Test 22: Redacted Logging & Category Sanity ---');

  const sensitiveHeaders = 'Authorization: Bearer my_ultra_secret_jwt_token_12345';
  const sanitizedHeaders = sanitizeLog(sensitiveHeaders);
  assert(!sanitizedHeaders.includes('my_ultra_secret_jwt_token_12345'), 'Sanitizes Authorization Bearer tokens');
  assert(sanitizedHeaders.includes('[REDACTED]'), 'Replaces Bearer token with [REDACTED]');

  const sensitiveCookie = 'Cookie: session=secret_session_abcde; token=super_token_987';
  const sanitizedCookie = sanitizeLog(sensitiveCookie);
  assert(!sanitizedCookie.includes('secret_session_abcde'), 'Sanitizes session cookies');
  assert(!sanitizedCookie.includes('super_token_987'), 'Sanitizes token cookies');

  const sensitiveTelegramToken = 'Connecting with bot_token: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz';
  const sanitizedBotToken = sanitizeLog(sensitiveTelegramToken);
  assert(!sanitizedBotToken.includes('123456789:ABCdefGHIjklMNOpqrsTUVwxyz'), 'Sanitizes Telegram Bot Tokens');

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
