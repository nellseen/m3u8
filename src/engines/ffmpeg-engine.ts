import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { BaseEngine } from './base.ts';
import { DownloadTask, EngineResult } from '../types.ts';
import { getFfmpegPath } from '../utils/system.ts';
import { validateMediaFile, probeMedia } from '../utils/ffmpeg.ts';
import { isM3u8Url } from '../utils/url-extractor.ts';
import { parseMasterPlaylist, HlsVariant, detectHlsEncryption } from '../utils/m3u8-parser.ts';
import { validateHlsSegments } from '../utils/segment-validator.ts';
import { isUrlExpired } from '../utils/signed-url.ts';
import { normalizeCookies } from '../utils/cookie-manager.ts';
import { logger } from '../logger.ts';

/**
 * Builds HTTP headers string for FFmpeg -headers argument
 * Strictly propagates only genuine source session headers & normalized cookies
 */
export function buildFfmpegHeaders(headers?: Record<string, string>, cookies?: string): string {
  const normCookies = normalizeCookies(cookies);
  if (!headers && !normCookies) return '';

  let headerStr = '';
  const seenKeys = new Set<string>();

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (!value) continue;
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'content-length' || lowerKey === 'host') continue; // Managed by network stack

      if (!seenKeys.has(lowerKey)) {
        seenKeys.add(lowerKey);
        headerStr += `${key}: ${value}\r\n`;
      }
    }
  }

  // Ensure cookies are included if task has cookies but headers['cookie'] is absent
  if (normCookies && !seenKeys.has('cookie')) {
    headerStr += `Cookie: ${normCookies}\r\n`;
  }

  return headerStr;
}

export class FfmpegEngine extends BaseEngine {
  readonly name = 'FFmpeg HLS Direct (Engine 5)';
  readonly priority = 5;

  async isAvailable(): Promise<boolean> {
    try {
      const bin = getFfmpegPath();
      return Boolean(bin);
    } catch {
      return false;
    }
  }

  /**
   * Fetches manifest content using genuine session headers if target is an HTTP/HTTPS or local M3U8
   */
  private async fetchManifestContent(
    url: string,
    headers?: Record<string, string>,
    cookies?: string
  ): Promise<string | null> {
    try {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const reqHeaders: Record<string, string> = {
          'User-Agent':
            headers?.['user-agent'] ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept:
            headers?.['accept'] ||
            'application/vnd.apple.mpegurl,application/x-mpegURL,application/mpegurl,*/*;q=0.8',
        };
        if (headers?.['referer']) reqHeaders['Referer'] = headers['referer'];
        if (headers?.['origin']) reqHeaders['Origin'] = headers['origin'];
        if (headers?.['authorization']) reqHeaders['Authorization'] = headers['authorization'];
        const normCookies = normalizeCookies(cookies || headers?.['cookie']);
        if (normCookies) reqHeaders['Cookie'] = normCookies;

        const res = await fetch(url, { headers: reqHeaders, signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          return await res.text();
        }
      } else if (fs.existsSync(url)) {
        return fs.readFileSync(url, 'utf8');
      }
    } catch (err: any) {
      logger.debug(`Failed to fetch manifest content directly: ${err.message}`);
    }
    return null;
  }

  async download(
    task: DownloadTask,
    onProgress?: (statusText: string, percent?: number) => void
  ): Promise<EngineResult> {
    const rawTargetUrl = task.streamUrl || task.originalUrl;
    const ffmpegBin = getFfmpegPath();
    const downloadDir = task.subDirs?.download || task.tempDir;
    const headerStr = buildFfmpegHeaders(task.streamHeaders, task.cookies);

    // 1. Inspect if target is an HLS Master Playlist with multiple variants or separated audio
    let effectiveVideoUrl = rawTargetUrl;
    let separateAudioTrackUrl: string | undefined;

    if (isM3u8Url(rawTargetUrl) || rawTargetUrl.endsWith('.m3u8') || rawTargetUrl.includes('.m3u8')) {
      onProgress?.('🔎 Deteksi enkripsi & validasi segment HLS...', 30);

      // Check if signed URL is already expired prior to network call
      if (isUrlExpired(rawTargetUrl)) {
        logger.warn(`[FFmpeg] Stream URL signature is already expired: ${rawTargetUrl}`);
        return {
          success: false,
          engineName: this.name,
          error: 'Signed stream URL timestamp has expired. Re-discovery required.',
          errorType: 'EXPIRED_URL',
          details: { isExpiredUrl: true },
        };
      }

      // Perform strict segment and encryption validation
      const segmentValidation = await validateHlsSegments(
        rawTargetUrl,
        undefined,
        task.streamHeaders,
        task.cookies
      );

      if (!segmentValidation.valid) {
        logger.warn(`[FFmpeg] Segment validation failed: ${segmentValidation.error}`);
        return {
          success: false,
          engineName: this.name,
          error: segmentValidation.error || 'Segment validation failed',
          errorType: segmentValidation.errorType || 'SEGMENT_ERROR',
          details: {
            isDrm: segmentValidation.isDrm,
            isExpiredUrl: segmentValidation.isExpiredUrl,
            encryption: segmentValidation.encryption,
          },
        };
      }

      if (segmentValidation.encryption) {
        task.encryption = segmentValidation.encryption;
        if (segmentValidation.encryption.isAes128) {
          logger.info(`[FFmpeg] AES-128 standard encryption verified with accessible key. Using FFmpeg crypto protocol.`);
        }
      }

      onProgress?.('🔎 Inspecting M3U8 Master Playlist variants & audio tracks...', 33);
      const manifestText = await this.fetchManifestContent(rawTargetUrl, task.streamHeaders, task.cookies);

      if (manifestText && manifestText.includes('#EXT-X-STREAM-INF')) {
        const parsed = parseMasterPlaylist(manifestText, rawTargetUrl);
        if (parsed.isMaster && parsed.selectedVariant) {
          const sel = parsed.selectedVariant;
          effectiveVideoUrl = sel.uri;
          separateAudioTrackUrl = sel.audioTrackUri;

          logger.info(
            `[FFmpeg] Master Playlist parsed: selected variant ${sel.resolution || 'unknown'} (${sel.bandwidth || 0} bps), height=${sel.height || 'auto'}. Target <= 720p enforced.`
          );
          if (separateAudioTrackUrl) {
            logger.info(`[FFmpeg] Master Playlist contains separated audio group track: ${separateAudioTrackUrl}`);
          }
        }
      }
    }

    const finalMp4 = path.join(downloadDir, `ffmpeg_output_${Date.now()}.mp4`);
    onProgress?.('⬇️ FFmpeg: Downloading HLS stream (video + audio)...', 35);

    // 2. Attempt download with separate audio track if present, otherwise direct URL
    let result = await this.executeFfmpegDownload(
      effectiveVideoUrl,
      finalMp4,
      ffmpegBin,
      headerStr,
      task,
      separateAudioTrackUrl,
      onProgress
    );

    // 3. Audio & Video Integrity Validation:
    // If output is valid but missing audio, attempt fallback options before declaring failure/success
    if (result.success && result.outputPath && fs.existsSync(result.outputPath)) {
      const probe = await probeMedia(result.outputPath);
      logger.info(`[FFmpeg] Output probe: hasVideo=${probe.hasVideo}, hasAudio=${probe.hasAudio}`);

      if (probe.hasVideo && !probe.hasAudio) {
        logger.warn('[FFmpeg] Video stream has NO AUDIO track. Attempting recovery with full master playlist URL...');
        onProgress?.('⚠️ Audio missing from variant stream. Retrying with full Master manifest & auto audio muxing...', 45);

        // If we previously used variant URI, try the raw master playlist with FFmpeg's internal HLS demuxer
        if (effectiveVideoUrl !== rawTargetUrl) {
          const recoveredMp4 = path.join(downloadDir, `ffmpeg_recovered_${Date.now()}.mp4`);
          const retryResult = await this.executeFfmpegDownload(
            rawTargetUrl,
            recoveredMp4,
            ffmpegBin,
            headerStr,
            task,
            undefined,
            onProgress
          );

          if (retryResult.success && retryResult.outputPath && fs.existsSync(retryResult.outputPath)) {
            const retryProbe = await probeMedia(retryResult.outputPath);
            if (retryProbe.hasAudio) {
              logger.info('[FFmpeg] Audio successfully recovered via Master manifest download');
              return retryResult;
            }
          }
        }

        // Return error if audio is genuinely missing so next engine (yt-dlp, etc.) can attempt extraction
        return {
          success: false,
          engineName: this.name,
          error: 'Stream downloaded successfully but container has no audio track (hasAudio=false)',
          errorType: 'INVALID_MEDIA',
        };
      }

      return result;
    }

    return result;
  }

  private executeFfmpegDownload(
    videoUrl: string,
    outputFile: string,
    ffmpegBin: string,
    headerStr: string,
    task: DownloadTask,
    audioUrl?: string,
    onProgress?: (statusText: string, percent?: number) => void
  ): Promise<EngineResult> {
    return new Promise(resolve => {
      let stderr = '';
      const args: string[] = ['-y'];

      args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data');
      if (headerStr) {
        args.push('-headers', headerStr);
      }
      args.push('-i', videoUrl);

      // If separated audio track is provided, add as second input
      if (audioUrl) {
        if (headerStr) {
          args.push('-headers', headerStr);
        }
        args.push('-i', audioUrl);
        args.push(
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-movflags', '+faststart',
          outputFile
        );
      } else {
        args.push(
          '-c', 'copy',
          '-bsf:a', 'aac_adtstoasc',
          '-movflags', '+faststart',
          outputFile
        );
      }

      const proc = spawn(ffmpegBin, args);
      if (proc.pid) {
        task.subprocesses.push(proc.pid);
      }

      proc.stderr.on('data', data => {
        const text = data.toString();
        stderr += text;

        const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
        const speedMatch = text.match(/speed=\s*(\d+\.?\d*x)/);
        if (timeMatch && onProgress) {
          const time = timeMatch[1];
          const speed = speedMatch ? speedMatch[1] : '';
          onProgress(`⬇️ FFmpeg downloading HLS: ${time}${speed ? ` (${speed})` : ''}`, 60);
        }
      });

      const abortHandler = () => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      };
      task.abortController.signal.addEventListener('abort', abortHandler, { once: true });

      proc.on('close', async code => {
        task.abortController.signal.removeEventListener('abort', abortHandler);

        if (code === 0 && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
          const validation = await validateMediaFile(outputFile);
          if (validation.valid) {
            resolve({
              success: true,
              outputPath: outputFile,
              engineName: this.name,
            });
            return;
          }
        }

        // Transcoding fallback if stream copy failed
        logger.warn('FFmpeg copy failed, retrying with re-encode fallback...');
        const transcodeArgs: string[] = ['-y', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data'];
        if (headerStr) {
          transcodeArgs.push('-headers', headerStr);
        }
        transcodeArgs.push('-i', videoUrl);

        if (audioUrl) {
          if (headerStr) {
            transcodeArgs.push('-headers', headerStr);
          }
          transcodeArgs.push('-i', audioUrl);
          transcodeArgs.push(
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            outputFile
          );
        } else {
          transcodeArgs.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            outputFile
          );
        }

        const transcodeProc = spawn(ffmpegBin, transcodeArgs);
        if (transcodeProc.pid) {
          task.subprocesses.push(transcodeProc.pid);
        }

        transcodeProc.on('close', async c => {
          if (c === 0 && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
            const validation = await validateMediaFile(outputFile);
            if (validation.valid) {
              resolve({
                success: true,
                outputPath: outputFile,
                engineName: this.name,
              });
              return;
            }
          }

          const errMsg = stderr || `FFmpeg failed with exit code ${code}`;
          logger.warn(`FFmpeg engine failed: ${errMsg.slice(-250)}`);

          let errorType: any = 'FFMPEG_ERROR';
          const lower = errMsg.toLowerCase();
          if (
            lower.includes('403 forbidden') ||
            lower.includes('401 unauthorized') ||
            lower.includes('server returned 403') ||
            lower.includes('server returned 401')
          ) {
            errorType = 'EXPIRED_URL';
          } else if (lower.includes('404 not found') || lower.includes('server returned 404')) {
            errorType = 'NO_MEDIA_FOUND';
          } else if (lower.includes('drm') || lower.includes('widevine') || lower.includes('fairplay')) {
            errorType = 'DRM_PROTECTED';
          } else if (lower.includes('sample-aes')) {
            errorType = 'UNSUPPORTED_ENCRYPTION';
          } else if (lower.includes('connection reset') || lower.includes('econnreset') || lower.includes('server returned 5')) {
            errorType = 'NETWORK_ERROR';
          }

          resolve({
            success: false,
            engineName: this.name,
            error: errMsg.slice(0, 300),
            errorType,
            details: {
              isExpiredUrl: errorType === 'EXPIRED_URL',
            },
          });
        });

        transcodeProc.on('error', err => {
          resolve({
            success: false,
            engineName: this.name,
            error: `FFmpeg transcode error: ${err.message}`,
            errorType: 'PROCESS_ERROR',
          });
        });
      });

      proc.on('error', err => {
        task.abortController.signal.removeEventListener('abort', abortHandler);
        resolve({
          success: false,
          engineName: this.name,
          error: `FFmpeg execution error: ${err.message}`,
          errorType: 'PROCESS_ERROR',
        });
      });
    });
  }
}
