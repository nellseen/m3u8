import { TelegramClient } from 'telegram';
import { logger } from '../logger.ts';

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
      // Schedule trailing update
      if (!this.pendingUpdateTimeout) {
        const delay = Math.max(200, 1500 - timeSinceLastEdit);
        this.pendingUpdateTimeout = setTimeout(async () => {
          this.pendingUpdateTimeout = null;
          await this.doEdit(text);
        }, delay);
      }
    }
  }

  async markDone(summaryText: string): Promise<void> {
    this.isFinished = true;
    if (this.pendingUpdateTimeout) {
      clearTimeout(this.pendingUpdateTimeout);
      this.pendingUpdateTimeout = null;
    }
    await this.doEdit(summaryText);
  }

  async markFailed(errorText: string): Promise<void> {
    this.isFinished = true;
    if (this.pendingUpdateTimeout) {
      clearTimeout(this.pendingUpdateTimeout);
      this.pendingUpdateTimeout = null;
    }
    await this.doEdit(errorText);
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
      // Ignore "message is not modified" or minor floodwait
      if (!errMsg.includes('MESSAGE_NOT_MODIFIED')) {
        logger.debug(`Failed to edit progress message ${this.messageId}:`, errMsg);
      }
    }
  }
}
