import fs from 'fs';
import path from 'path';
import { HlsByteRange, HlsSegmentItem, HlsInitSegment } from './m3u8-parser.ts';
import { HlsKeyTag } from '../types.ts';
import { validateSegmentBytes } from './segment-validator.ts';
import { logger } from '../logger.ts';

export type SegmentTrackType = 'video' | 'audio' | 'init' | 'subtitle';

export type SegmentStatus =
  | 'pending'
  | 'downloading'
  | 'downloaded'
  | 'validated'
  | 'failed'
  | 'cancelled';

export interface SegmentRecord {
  id: string;
  sequenceNumber: number;
  track: SegmentTrackType;
  uri: string;
  byteRange?: HlsByteRange;
  isInitSegment: boolean;
  status: SegmentStatus;
  attempts: number;
  maxAttempts: number;
  sizeBytes: number;
  localPath?: string;
  lastError?: string;
  duration?: number;
  discontinuity?: boolean;
  key?: HlsKeyTag;
  validatedAt?: number;
  registeredAt: number;
}

export interface LedgerSummary {
  total: number;
  pending: number;
  downloading: number;
  downloaded: number;
  validated: number;
  failed: number;
  cancelled: number;
  totalBytes: number;
  allValidated: boolean;
}

/**
 * SegmentLedger - Centralized Tracking System for HLS Media Segments
 * Enforces segment completeness, prevents premature finalization,
 * supports fMP4 initialization segments, byte-range tracking, and bitstream verification.
 */
export class SegmentLedger {
  readonly taskId: string;
  readonly baseDir: string;
  private segments: Map<string, SegmentRecord> = new Map();
  private isLive: boolean;

  constructor(taskId: string, baseDir: string, isLive = false) {
    this.taskId = taskId;
    this.baseDir = baseDir;
    this.isLive = isLive;
    if (!fs.existsSync(baseDir)) {
      try {
        fs.mkdirSync(baseDir, { recursive: true });
      } catch {}
    }
  }

  /**
   * Generates a deterministic segment ID
   */
  private makeSegmentId(track: SegmentTrackType, sequence: number, isInit = false): string {
    if (isInit) {
      return `${track}_init`;
    }
    return `${track}_seq_${sequence.toString().padStart(6, '0')}`;
  }

  /**
   * Registers an initialization segment (EXT-X-MAP)
   */
  registerInitSegment(
    init: HlsInitSegment,
    track: SegmentTrackType = 'video'
  ): SegmentRecord {
    const id = this.makeSegmentId(track, 0, true);
    const existing = this.segments.get(id);
    if (existing) {
      return existing;
    }

    const filename = `${track}_init_${Date.now()}.mp4`;
    const localPath = path.join(this.baseDir, filename);

    const record: SegmentRecord = {
      id,
      sequenceNumber: 0,
      track: 'init',
      uri: init.uri,
      byteRange: init.byteRange,
      isInitSegment: true,
      status: 'pending',
      attempts: 0,
      maxAttempts: 4,
      sizeBytes: 0,
      localPath,
      registeredAt: Date.now(),
    };

    this.segments.set(id, record);
    return record;
  }

  /**
   * Registers a standard media segment (EXTINF)
   */
  registerSegment(
    segment: HlsSegmentItem,
    index: number,
    track: SegmentTrackType = 'video'
  ): SegmentRecord {
    const seq = segment.sequenceNumber !== undefined ? segment.sequenceNumber : index;
    const id = this.makeSegmentId(track, seq);

    const existing = this.segments.get(id);
    if (existing) {
      return existing;
    }

    const ext = segment.uri.toLowerCase().includes('.m4s') ? 'm4s' : 'ts';
    const filename = `${track}_seg_${seq.toString().padStart(6, '0')}.${ext}`;
    const localPath = path.join(this.baseDir, filename);

    const record: SegmentRecord = {
      id,
      sequenceNumber: seq,
      track,
      uri: segment.uri,
      byteRange: segment.byteRange,
      isInitSegment: false,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      sizeBytes: 0,
      localPath,
      duration: segment.duration,
      discontinuity: segment.discontinuity,
      key: segment.key,
      registeredAt: Date.now(),
    };

    this.segments.set(id, record);
    return record;
  }

  /**
   * Batch registers segments from an HLS media playlist
   */
  populateFromMediaPlaylist(
    segments: HlsSegmentItem[],
    initSegment?: HlsInitSegment,
    track: SegmentTrackType = 'video'
  ): void {
    if (initSegment) {
      this.registerInitSegment(initSegment, track);
    }
    segments.forEach((seg, idx) => {
      this.registerSegment(seg, idx, track);
    });
  }

  getSegment(id: string): SegmentRecord | undefined {
    return this.segments.get(id);
  }

  getAllSegments(): SegmentRecord[] {
    return Array.from(this.segments.values());
  }

  getSegmentsByTrack(track: SegmentTrackType): SegmentRecord[] {
    return Array.from(this.segments.values())
      .filter(s => s.track === track || (track === 'video' && s.isInitSegment))
      .sort((a, b) => {
        if (a.isInitSegment) return -1;
        if (b.isInitSegment) return 1;
        return a.sequenceNumber - b.sequenceNumber;
      });
  }

  markDownloading(id: string): void {
    const s = this.segments.get(id);
    if (s) {
      s.status = 'downloading';
      s.attempts += 1;
    }
  }

  /**
   * Marks a segment as downloaded and verifies file existence and non-zero size
   */
  markDownloaded(id: string, localPath?: string, sizeBytes?: number): boolean {
    const s = this.segments.get(id);
    if (!s) return false;

    if (localPath) s.localPath = localPath;
    if (sizeBytes !== undefined) {
      s.sizeBytes = sizeBytes;
    } else if (s.localPath && fs.existsSync(s.localPath)) {
      s.sizeBytes = fs.statSync(s.localPath).size;
    }

    if (s.sizeBytes <= 0) {
      s.status = 'failed';
      s.lastError = 'Zero-byte downloaded payload';
      return false;
    }

    s.status = 'downloaded';
    return true;
  }

  /**
   * Validates downloaded payload bytes against media bitstream requirements.
   * Rejects HTML/JSON CDN error pages disguised as HTTP 200.
   */
  validateSegment(id: string, customBuffer?: Uint8Array, isEncrypted = false): boolean {
    const s = this.segments.get(id);
    if (!s) return false;

    try {
      let buffer: Uint8Array;
      if (customBuffer) {
        buffer = customBuffer;
      } else if (s.localPath && fs.existsSync(s.localPath)) {
        buffer = fs.readFileSync(s.localPath);
      } else {
        s.status = 'failed';
        s.lastError = 'Local file not found for bitstream validation';
        return false;
      }

      s.sizeBytes = buffer.length;
      const result = validateSegmentBytes(buffer, isEncrypted || Boolean(s.key && s.key.method !== 'NONE'));

      if (!result.valid) {
        s.status = 'failed';
        s.lastError = result.reason || 'Invalid media payload';
        logger.warn(`[SegmentLedger] Validation failed for segment ${id}: ${s.lastError}`);
        return false;
      }

      s.status = 'validated';
      s.validatedAt = Date.now();
      s.lastError = undefined;
      return true;
    } catch (err: any) {
      s.status = 'failed';
      s.lastError = `Validation exception: ${err.message}`;
      return false;
    }
  }

  markFailed(id: string, error: string): void {
    const s = this.segments.get(id);
    if (s) {
      s.status = 'failed';
      s.lastError = error;
    }
  }

  markCancelled(): void {
    for (const s of this.segments.values()) {
      if (s.status === 'pending' || s.status === 'downloading') {
        s.status = 'cancelled';
      }
    }
  }

  /**
   * Checks if all registered segments are validated
   */
  isComplete(): boolean {
    if (this.segments.size === 0) return false;
    for (const s of this.segments.values()) {
      if (s.status !== 'validated') {
        return false;
      }
    }
    return true;
  }

  /**
   * Returns segments that need download or retry
   */
  getIncompleteSegments(): SegmentRecord[] {
    return Array.from(this.segments.values()).filter(
      s => s.status !== 'validated' && s.attempts < s.maxAttempts
    );
  }

  /**
   * Summary overview
   */
  getSummary(): LedgerSummary {
    let pending = 0;
    let downloading = 0;
    let downloaded = 0;
    let validated = 0;
    let failed = 0;
    let cancelled = 0;
    let totalBytes = 0;

    for (const s of this.segments.values()) {
      totalBytes += s.sizeBytes;
      switch (s.status) {
        case 'pending': pending++; break;
        case 'downloading': downloading++; break;
        case 'downloaded': downloaded++; break;
        case 'validated': validated++; break;
        case 'failed': failed++; break;
        case 'cancelled': cancelled++; break;
      }
    }

    const total = this.segments.size;
    const allValidated = total > 0 && validated === total;

    return {
      total,
      pending,
      downloading,
      downloaded,
      validated,
      failed,
      cancelled,
      totalBytes,
      allValidated,
    };
  }

  /**
   * Reconciles VOD completeness:
   * Returns true if all mandatory segments are validated without omissions.
   */
  reconcileCompleteness(): { complete: boolean; missingCount: number; reason?: string } {
    if (this.segments.size === 0) {
      return { complete: false, missingCount: 0, reason: 'No segments registered in ledger' };
    }

    const unvalidated = Array.from(this.segments.values()).filter(s => s.status !== 'validated');
    if (unvalidated.length > 0) {
      const summaryMsg = unvalidated.slice(0, 5).map(s => `${s.id} (${s.status}: ${s.lastError || 'unvalidated'})`).join(', ');
      return {
        complete: false,
        missingCount: unvalidated.length,
        reason: `${unvalidated.length}/${this.segments.size} segments incomplete: ${summaryMsg}`,
      };
    }

    return { complete: true, missingCount: 0 };
  }

  /**
   * Generates FFmpeg concat manifest file with safe absolute file paths,
   * guaranteeing that init segment (if present) is listed first!
   */
  generateConcatManifest(outConcatPath: string, track: SegmentTrackType = 'video'): boolean {
    const list = this.getSegmentsByTrack(track);
    if (list.length === 0) return false;

    // Check that every file exists
    for (const s of list) {
      if (!s.localPath || !fs.existsSync(s.localPath)) {
        logger.error(`[SegmentLedger] Missing segment file for concat: ${s.id} -> ${s.localPath}`);
        return false;
      }
    }

    const lines = list.map(s => `file '${s.localPath?.replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(outConcatPath, lines.join('\n'), 'utf8');
    return true;
  }
}
