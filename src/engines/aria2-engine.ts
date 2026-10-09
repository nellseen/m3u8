import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { getAria2Path, isAria2Available, getFfmpegPath } from '../utils/system.ts';
import { logger } from '../logger.ts';
import {
  parseHlsManifest,
  parseMediaPlaylist,
  detectHlsEncryption,
  MediaPlaylistParseResult,
  HlsSegmentItem,
} from '../utils/m3u8-parser.ts';
import {
  buildPropagatedHeaders,
  buildAria2Headers,
  buildFfmpegHeaderString,
} from '../utils/header-propagator.ts';
import { isExpiredFailure, refreshStreamManifest } from '../utils/signed-url.ts';
import { validateMediaFile, probeMedia } from '../utils/ffmpeg.ts';
import { SegmentLedger, SegmentRecord } from '../utils/segment-ledger.ts';

export class Aria2Engine extends BaseEngine {
  readonly name = 'Aria2 Parallel Downloader';
  readonly priority = 4;

  async isAvailable(): Promise<boolean> {
    return isAria2Available();
  }

  /**
   * Evaluates whether the given media playlist is suitable for aria2 parallel segment downloading:
   * - Must have multiple independent segments (>= 2)
   * - HTTP/HTTPS URLs
   * - Server allows concurrent connections / parallel fetch
   * - Not a continuous live stream (isLive === false)
   * - Not DRM protected
   * - No condition requiring direct continuous FFmpeg stream intake
   */
  isSuitableForAria2(
    media: MediaPlaylistParseResult,
    isDrm: boolean
  ): { suitable: boolean; reason: string } {
    if (isDrm) {
      return { suitable: false, reason: 'DRM protection detected; cannot use aria2 segment download.' };
    }

    if (media.isLive) {
      return { suitable: false, reason: 'Live stream detected (no endlist); requires continuous FFmpeg stream intake.' };
    }

    if (!media.segments || media.segments.length < 2) {
      return { suitable: false, reason: 'Single segment or empty playlist; standard downloader preferred.' };
    }

    // Verify segments are HTTP or HTTPS
    const hasNonHttp = media.segments.some(
      s => !s.uri.startsWith('http://') && !s.uri.startsWith('https://')
    );
    if (hasNonHttp) {
      return { suitable: false, reason: 'Segments contain non-HTTP local or custom schemes.' };
    }

    return { suitable: true, reason: 'Multi-segment VOD HLS stream suitable for parallel concurrent aria2 download.' };
  }

  async download(
    task: DownloadTask,
    onProgressUpdate?: (text: string, percent?: number) => void
  ): Promise<EngineResult> {
    const aria2Bin = getAria2Path();
    const ffmpegBin = getFfmpegPath();

    const targetUrl = task.streamUrl || task.originalUrl;
    logger.info(`[Aria2] Initializing segment discovery for task ${task.id}: ${targetUrl.slice(0, 100)}...`);
    onProgressUpdate?.('🔍 Parsing M3U8 for aria2 parallel pipeline...');

    // 1. Fetch manifest
    const manifestHeaders = buildPropagatedHeaders(task.streamHeaders, task.cookies, targetUrl);
    let manifestText = '';
    let finalManifestUrl = targetUrl;

    try {
      if (fs.existsSync(targetUrl)) {
        manifestText = fs.readFileSync(targetUrl, 'utf8');
        finalManifestUrl = targetUrl;
      } else {
        const res = await fetch(targetUrl, {
          headers: manifestHeaders,
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          return {
            success: false,
            engineName: this.name,
            error: `Failed to fetch manifest: HTTP ${res.status}`,
            errorType: res.status === 401 || res.status === 403 ? 'EXPIRED_URL' : 'NETWORK_ERROR',
          };
        }
        manifestText = await res.text();
        finalManifestUrl = res.url || targetUrl;
      }
    } catch (fetchErr: any) {
      return {
        success: false,
        engineName: this.name,
        error: `Manifest fetch error: ${fetchErr.message}`,
        errorType: 'NETWORK_ERROR',
      };
    }

    if (!manifestText.includes('#EXTM3U')) {
      return {
        success: false,
        engineName: this.name,
        error: 'Target URL is not a valid M3U8 manifest (missing #EXTM3U header)',
        errorType: 'NO_M3U8_FOUND',
      };
    }

    // 2. Encryption and DRM Check
    const encAnalysis = detectHlsEncryption(manifestText);
    if (encAnalysis.isDrm) {
      task.status = 'failed';
      task.errorCategory = 'DRM_PROTECTED';
      return {
        success: false,
        engineName: this.name,
        error: encAnalysis.reason || 'DRM protection detected.',
        errorType: 'DRM_PROTECTED',
      };
    }

    // 3. Parse Master vs Media
    const parsed = parseHlsManifest(manifestText, finalManifestUrl);
    let mediaPlaylistText = manifestText;
    let actualVariantUrl = finalManifestUrl;

    if (parsed.type === 'MASTER') {
      const selectedVariant = parsed.selectedVariant || parsed.variants[0];
      if (!selectedVariant) {
        return {
          success: false,
          engineName: this.name,
          error: 'Master playlist contains no stream variants',
          errorType: 'NO_MEDIA_FOUND',
        };
      }

      actualVariantUrl = selectedVariant.uri;
      task.streamUrl = actualVariantUrl;
      logger.info(`[Aria2] Selected variant: ${selectedVariant.resolution || 'optimal'} (${actualVariantUrl.slice(0, 100)}...)`);

      try {
        if (fs.existsSync(actualVariantUrl)) {
          mediaPlaylistText = fs.readFileSync(actualVariantUrl, 'utf8');
        } else {
          const vHeaders = buildPropagatedHeaders(task.streamHeaders, task.cookies, actualVariantUrl);
          const vRes = await fetch(actualVariantUrl, {
            headers: vHeaders,
            signal: AbortSignal.timeout(15000),
          });
          if (!vRes.ok) {
            return {
              success: false,
              engineName: this.name,
              error: `Variant playlist fetch failed: HTTP ${vRes.status}`,
              errorType: vRes.status === 401 || vRes.status === 403 ? 'EXPIRED_URL' : 'NETWORK_ERROR',
            };
          }
          mediaPlaylistText = await vRes.text();
        }
      } catch (vErr: any) {
        return {
          success: false,
          engineName: this.name,
          error: `Failed to fetch variant playlist: ${vErr.message}`,
          errorType: 'NETWORK_ERROR',
        };
      }
    }

    // 4. Parse Media Segments strictly using actualVariantUrl as base URL
    const mediaParsed = parseMediaPlaylist(mediaPlaylistText, actualVariantUrl);
    logger.info(`[Aria2] Parsed Media Playlist: ${mediaParsed.segments.length} segments, totalDuration: ${mediaParsed.totalDuration}s, isLive: ${mediaParsed.isLive}`);

    // 5. Suitability Check
    const suitability = this.isSuitableForAria2(mediaParsed, encAnalysis.isDrm);
    if (!suitability.suitable) {
      logger.info(`[Aria2] Stream not suitable for aria2: ${suitability.reason}. Yielding to subsequent engines.`);
      return {
        success: false,
        engineName: this.name,
        error: suitability.reason,
        errorType: 'EXTRACTOR_UNSUPPORTED',
      };
    }

    // 6. Setup directories & Segment Ledger
    const segDir = path.join(task.tempDir, 'aria2_segments');
    fs.mkdirSync(segDir, { recursive: true });

    const ledger = new SegmentLedger(task.id, segDir, mediaParsed.isLive);
    if (mediaParsed.initSegment) {
      ledger.registerInitSegment(mediaParsed.initSegment, 'video');
      logger.info(`[Aria2] Registered fMP4 initialization segment: ${mediaParsed.initSegment.uri}`);
    }
    mediaParsed.segments.forEach((seg, idx) => {
      ledger.registerSegment(seg, idx, 'video');
    });

    const allLedgerSegments = ledger.getAllSegments();
    const totalSegments = allLedgerSegments.length;
    onProgressUpdate?.(`⚡ Aria2: Preparing ${totalSegments} segments for parallel download...`, 5);

    // 7. Helper to generate aria2 input file for pending segments
    const generateInputFile = (
      records: SegmentRecord[],
      outPath: string
    ) => {
      const lines: string[] = [];
      for (const rec of records) {
        if (!rec.localPath) continue;
        const filename = path.basename(rec.localPath);
        lines.push(rec.uri);
        lines.push(`  dir=${segDir}`);
        lines.push(`  out=${filename}`);

        // Propagate headers per-URL
        const segHeaders = buildPropagatedHeaders(task.streamHeaders, task.cookies, rec.uri);
        if (rec.byteRange) {
          const rangeVal = `bytes=${rec.byteRange.offset}-${rec.byteRange.offset + rec.byteRange.length - 1}`;
          segHeaders['Range'] = rangeVal;
        }
        for (const [hk, hv] of Object.entries(segHeaders)) {
          lines.push(`  header=${hk}: ${hv}`);
        }
      }
      fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    };

    const inputFile = path.join(task.tempDir, 'aria2_input.txt');
    generateInputFile(allLedgerSegments, inputFile);

    // 8. Execute aria2 parallel download
    logger.info(`[Aria2] Spawning aria2c with ${totalSegments} jobs (dir: ${segDir})`);
    onProgressUpdate?.(`⚡ Downloading ${totalSegments} segments via aria2 parallel engine...`, 10);

    const runAria2Batch = async (
      jobInputFile: string,
      currentBatchSize: number
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      return new Promise(resolve => {
        const aria2Args = [
          '--input-file',
          jobInputFile,
          '--max-concurrent-downloads=8',
          '--split=4',
          '--max-connection-per-server=8',
          '--min-split-size=1M',
          '--timeout=15',
          '--connect-timeout=10',
          '--max-tries=3',
          '--retry-wait=2',
          '--auto-file-renaming=false',
          '--allow-overwrite=true',
          '--summary-interval=1',
          '--console-log-level=warn',
          '--check-certificate=false',
        ];

        const proc = spawn(aria2Bin, aria2Args);
        if (proc.pid) {
          task.subprocesses.push(proc.pid);
        }

        let stdoutData = '';
        let stderrData = '';

        const progressTimer = setInterval(() => {
          if (task.abortController.signal.aborted) {
            proc.kill('SIGKILL');
            clearInterval(progressTimer);
            return;
          }

          try {
            const files = fs.readdirSync(segDir).filter(f => !f.endsWith('.aria2'));
            const count = files.length;
            const pct = Math.min(85, Math.floor(10 + (count / totalSegments) * 75));
            onProgressUpdate?.(`⚡ Aria2 downloading: ${count}/${totalSegments} segments (${pct}%)`, pct);
          } catch {}
        }, 1500);

        proc.stdout.on('data', d => {
          stdoutData += d.toString();
        });

        proc.stderr.on('data', d => {
          stderrData += d.toString();
        });

        proc.on('close', code => {
          clearInterval(progressTimer);
          resolve({ code: code || 0, stdout: stdoutData, stderr: stderrData });
        });

        proc.on('error', err => {
          clearInterval(progressTimer);
          resolve({ code: 1, stdout: stdoutData, stderr: err.message });
        });
      });
    };

    let ariaResult = await runAria2Batch(inputFile, totalSegments);

    // 9. Check downloaded segments in Ledger & perform Bitstream Validation
    const validateLedgerSegments = () => {
      for (const rec of ledger.getAllSegments()) {
        if (rec.localPath && fs.existsSync(rec.localPath) && fs.statSync(rec.localPath).size > 0) {
          ledger.markDownloaded(rec.id);
          ledger.validateSegment(rec.id);
        } else {
          ledger.markFailed(rec.id, 'File missing or empty after download');
        }
      }
    };

    validateLedgerSegments();

    let incomplete = ledger.getIncompleteSegments();

    if (incomplete.length > 0) {
      logger.warn(`[Aria2] Initial pass completed with ${incomplete.length}/${totalSegments} unvalidated segments.`);

      // Check if error is related to expired token / signed URL (HTTP 401 / 403 / expired signature)
      const combinedOutput = `${ariaResult.stdout} ${ariaResult.stderr}`;
      const isExpired = isExpiredFailure(combinedOutput) || incomplete.some(m => isExpiredFailure(null, m.uri));

      if (isExpired) {
        logger.info('[Aria2] Expired signed URL / token detected during segment download. Refreshing manifest for fresh candidates...');
        onProgressUpdate?.('🔄 Segment token expired. Refreshing manifest to generate fresh candidates...');

        const freshManifest = await refreshStreamManifest(task, actualVariantUrl);
        if (freshManifest && freshManifest.freshSegments.length > 0) {
          logger.info(`[Aria2] Fresh manifest refreshed successfully! Re-mapping ${incomplete.length} pending segments to fresh candidates.`);

          // Map remaining segments to fresh candidate URLs in ledger
          const freshBatch: SegmentRecord[] = [];
          for (const inc of incomplete) {
            if (!inc.isInitSegment) {
              const freshMatch = freshManifest.freshSegments[inc.sequenceNumber];
              if (freshMatch) {
                inc.uri = freshMatch.uri;
                inc.status = 'pending';
                freshBatch.push(inc);
              }
            }
          }

          if (freshBatch.length > 0) {
            const freshInputFile = path.join(task.tempDir, 'aria2_fresh_input.txt');
            generateInputFile(freshBatch, freshInputFile);
            onProgressUpdate?.(`⚡ Resuming aria2 download for ${freshBatch.length} refreshed segments...`);

            await runAria2Batch(freshInputFile, freshBatch.length);
            validateLedgerSegments();
          }
        }
      }
    }

    // 10. Ledger Completeness Reconciliation
    const reconciliation = ledger.reconcileCompleteness();
    if (!reconciliation.complete) {
      const errorMsg = `Aria2 failed to validate ${reconciliation.missingCount}/${totalSegments} segments: ${reconciliation.reason}`;
      logger.warn(`[Aria2] ${errorMsg}`);
      return {
        success: false,
        engineName: this.name,
        error: errorMsg,
        errorType: 'SEGMENT_ERROR',
      };
    }

    onProgressUpdate?.('🧩 All segments verified via bitstream inspection. Merging via FFmpeg...', 88);

    // 11. Generate Concat File using Ledger to guarantee correct ordering (init segment first!)
    const concatFile = path.join(task.tempDir, 'segments_concat.txt');
    const concatOk = ledger.generateConcatManifest(concatFile, 'video');
    if (!concatOk) {
      return {
        success: false,
        engineName: this.name,
        error: 'Failed to generate FFmpeg concat manifest from validated segments ledger',
        errorType: 'SEGMENT_ERROR',
      };
    }

    // 12. Concat & Remux via PURE Stream Copy (No downscale, no transcoding)
    const outputPath = path.join(task.tempDir, `aria2_output_${Date.now()}.mp4`);
    logger.info(`[Aria2] Remuxing concatenated segments via pure stream copy (-c copy, no transcoding)...`);
    const ffmpegArgs = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatFile,
      '-c',
      'copy',
      '-bsf:a',
      'aac_adtstoasc',
      '-movflags',
      '+faststart',
      outputPath,
    ];

    logger.info(`[Aria2] Merging segments: ${ffmpegBin} ${ffmpegArgs.join(' ')}`);
    const mergeResult = await new Promise<boolean>(resolve => {
      const ffProc = spawn(ffmpegBin, ffmpegArgs);
      if (ffProc.pid) {
        task.subprocesses.push(ffProc.pid);
      }

      ffProc.on('close', code => {
        resolve(code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0);
      });
      ffProc.on('error', () => {
        resolve(false);
      });
    });

    if (!mergeResult) {
      return {
        success: false,
        engineName: this.name,
        error: 'Failed to concatenate and remux downloaded segments into MP4 container.',
        errorType: 'FFMPEG_ERROR',
      };
    }

    // 13. Media Integrity Check
    const mediaCheck = await validateMediaFile(outputPath);
    if (!mediaCheck.valid) {
      return {
        success: false,
        engineName: this.name,
        error: mediaCheck.error || 'Merged MP4 file failed validation check.',
        errorType: 'INVALID_MEDIA',
      };
    }

    task.outputPath = outputPath;
    task.duration = mediaCheck.meta.duration;
    task.width = mediaCheck.meta.width;
    task.height = mediaCheck.meta.height;
    task.sizeBytes = fs.statSync(outputPath).size;

    onProgressUpdate?.('✅ Download & merge complete via aria2!', 100);
    logger.job(`[Aria2] Successfully completed download for task ${task.id}: ${outputPath} (${task.width}x${task.height}, ${mediaCheck.meta.duration}s)`);

    return {
      success: true,
      outputPath,
      engineName: this.name,
    };
  }
}
