import { TelegramClient } from 'telegram';
import { logger } from '../logger.ts';

export type ProgressStage =
  | 'detecting_url'
  | 'extracting_metadata'
  | 'finding_media'
  | 'downloading'
  | 'processing'
  | 'limiting_resolution'
  | 'generating_thumbnail'
  | 'uploading'
  | 'completed'
  | 'failed';

const STAGE_LABELS: Record<ProgressStage, string> = {
  detecting_url: '🔎 Detecting URL',
  extracting_metadata: '🌐 Extracting metadata',
  finding_media: '🧭 Finding media',
  downloading: '⬇️ Downloading',
  processing: '⚙️ Processing',
  limiting_resolution: '📐 Limiting to 720p',
  generating_thumbnail: '🖼️ Generating thumbnail',
  uploading: '📤 Uploading',
  completed: '✅ Completed',
  failed: '❌ Download failed',
};

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

  async setStage(stage: ProgressStage, detail?: string, force = false): Promise<void> {
    const label = STAGE_LABELS[stage] || stage;
    const text = detail ? `${label}\n${detail}` : label;
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
      // Schedule trailing update to prevent hitting Telegram flood limits
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

  async markFailed(errorText: string): Promise<void> {
    this.isFinished = true;
    if (this.pendingUpdateTimeout) {
      clearTimeout(this.pendingUpdateTimeout);
      this.pendingUpdateTimeout = null;
    }
    const fullText = `❌ Download failed\n\n${errorText}`;
    await this.doEdit(fullText);
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
