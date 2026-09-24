import { TelegramClient } from 'telegram';
import { logger } from '../logger.ts';

export type ProgressStage =
  | 'detecting_source'
  | 'finding_media'
  | 'm3u8_detected'
  | 'resolving_stream'
  | 'downloading'
  | 'processing'
  | 'preparing_thumbnail'
  | 'uploading_to_channel'
  | 'completed'
  | 'failed';

export const USER_PROGRESS_LABELS: Record<ProgressStage, string> = {
  detecting_source: '🔎 Detecting source...',
  finding_media: '🌐 Finding media...',
  m3u8_detected: '🎬 M3U8 detected',
  resolving_stream: '📡 Resolving stream...',
  downloading: '⬇️ Downloading',
  processing: '⚙️ Processing...',
  preparing_thumbnail: '🖼️ Preparing thumbnail...',
  uploading_to_channel: '📤 Uploading to channel...',
  completed: '✅ Completed',
  failed: '❌ Download failed',
};

/**
 * Builds standard 10-character progress bar: e.g. ████████░░ 80%
 */
export function formatProgressBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const barLength = 10;
  const filled = Math.min(barLength, Math.round((clamped / 100) * barLength));
  const empty = barLength - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${clamped}%`;
}

/**
 * Sanitizes an error message so it does not contain raw stack traces, file paths, or internal code lines
 */
export function sanitizeUserReason(reason: string): string {
  if (!reason) return 'Unknown error occurred';

  let clean = reason;

  // Remove stack traces (e.g. "at Object.<anonymous> (/path/file.ts:12:34)")
  clean = clean.split(/\n\s*at\s+/)[0];

  // Remove raw file paths like /usr/..., /tmp/..., /home/...
  clean = clean.replace(/(\/[a-zA-Z0-9_\-\.]+)+/g, match => {
    // Keep brief filename if relevant, but strip full absolute directory paths
    const parts = match.split('/');
    return parts[parts.length - 1] || '[path]';
  });

  // Strip leading Error: prefixes
  clean = clean.replace(/^([A-Za-z_]+Error:\s*)+/i, '');

  return clean.trim() || 'Download process encountered an error';
}

/**
 * Formats user-facing failure message strictly per user specification:
 * ❌ Download failed
 *
 * Reason:
 * {actual reason}
 *
 * Engine:
 * {engine}
 *
 * Attempts:
 * {x}
 */
export function formatUserErrorMessage(params: {
  reason: string;
  engine?: string;
  attempts?: number;
  rawError?: any;
  taskId?: string;
}): string {
  if (params.rawError) {
    logger.error(`[ERROR] Task ${params.taskId || 'unknown'} failure: ${params.rawError?.message || params.rawError}`);
    if (params.rawError?.stack) {
      logger.debug(`[ERROR] Internal stack trace: ${params.rawError.stack}`);
    }
  }

  const cleanReason = sanitizeUserReason(params.reason);
  const engineStr = params.engine || 'Direct / Fallback';
  const attemptsCount = params.attempts && params.attempts > 0 ? params.attempts : 1;

  return [
    '❌ Download failed',
    '',
    'Reason:',
    cleanReason,
    '',
    'Engine:',
    engineStr,
    '',
    'Attempts:',
    String(attemptsCount),
  ].join('\n');
}

export const formatErrorForUser = formatUserErrorMessage;

export class ProgressTracker {
  private client: TelegramClient;
  private chatId: any;
  private messageId: number;
  private lastEditTime = 0;
  private lastText = '';
  private pendingUpdateTimeout: NodeJS.Timeout | null = null;
  private isFinished = false;

  constructor(client: TelegramClient, chatId: any, messageId: number) {
    this.client = client;
    this.chatId = chatId;
    this.messageId = messageId;
  }

  /**
   * Sets progress stage per specification:
   * 🔎 Detecting source...
   * 🌐 Finding media...
   * 🎬 M3U8 detected
   * 📡 Resolving stream...
   * ⬇️ Downloading\n████████░░ 80%
   * ⚙️ Processing...
   * 🖼️ Preparing thumbnail...
   * 📤 Uploading to channel...
   * ✅ Completed
   */
  async setStage(stage: ProgressStage, percent?: number, force = false): Promise<void> {
    const label = USER_PROGRESS_LABELS[stage] || stage;
    let text = label;
    if (stage === 'downloading' && percent !== undefined && percent > 0) {
      text = `${label}\n${formatProgressBar(percent)}`;
    }
    await this.update(text, force);
  }

  async update(text: string, force = false): Promise<void> {
    if (this.isFinished && !force) return;
    if (text === this.lastText) return;

    const now = Date.now();
    const timeSinceLastEdit = now - this.lastEditTime;

    if (force || timeSinceLastEdit >= 1500) {
      if (this.pendingUpdateTimeout) {
        clearTimeout(this.pendingUpdateTimeout);
        this.pendingUpdateTimeout = null;
      }
      await this.doEdit(text);
    } else {
      // Schedule trailing update to prevent hitting Telegram flood limits without spamming
      if (!this.pendingUpdateTimeout) {
        const delay = Math.max(200, 1500 - timeSinceLastEdit);
        this.pendingUpdateTimeout = setTimeout(async () => {
          this.pendingUpdateTimeout = null;
          await this.doEdit(text);
        }, delay);
      }
    }
  }

  async markDone(summaryText?: string): Promise<void> {
    this.isFinished = true;
    if (this.pendingUpdateTimeout) {
      clearTimeout(this.pendingUpdateTimeout);
      this.pendingUpdateTimeout = null;
    }
    await this.doEdit(summaryText || '✅ Completed');
  }

  /**
   * Marks task failed with strict template without exposing full stack trace
   */
  async markFailedWithDetails(params: {
    reason: string;
    engine?: string;
    attempts?: number;
    rawError?: any;
    taskId?: string;
  }): Promise<void> {
    this.isFinished = true;
    if (this.pendingUpdateTimeout) {
      clearTimeout(this.pendingUpdateTimeout);
      this.pendingUpdateTimeout = null;
    }

    // Log complete stack trace internally
    if (params.rawError) {
      const internalStack = params.rawError?.stack || String(params.rawError);
      logger.error(`[ProgressTracker] Task ${params.taskId || 'unknown'} internal stack trace:`, internalStack);
    }

    const formattedUserMsg = formatUserErrorMessage({
      reason: params.reason,
      engine: params.engine,
      attempts: params.attempts,
    });

    await this.doEdit(formattedUserMsg);
  }

  async markFailed(errorText: string): Promise<void> {
    await this.markFailedWithDetails({ reason: errorText });
  }

  async delete(): Promise<void> {
    try {
      if (this.pendingUpdateTimeout) {
        clearTimeout(this.pendingUpdateTimeout);
        this.pendingUpdateTimeout = null;
      }
      await this.client.deleteMessages(this.chatId, [this.messageId], { revoke: true });
    } catch {
      // Ignore delete errors
    }
  }

  private async doEdit(text: string): Promise<void> {
    try {
      this.lastText = text;
      this.lastEditTime = Date.now();
      await this.client.editMessage(this.chatId, {
        message: this.messageId,
        text,
        linkPreview: false,
      });
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      // Ignore standard "message is not modified"
      if (!errMsg.includes('MESSAGE_NOT_MODIFIED')) {
        logger.debug(`Failed to edit progress message ${this.messageId}:`, errMsg);
      }
    }
  }
}

