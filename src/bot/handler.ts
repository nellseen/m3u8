import { TelegramClient, Api } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import fs from 'fs';
import { config } from '../config.ts';
import { DownloadQueue } from '../queue/download-queue.ts';
import { ProgressTracker } from './progress.ts';
import { extractUrlsFromText } from '../utils/url-extractor.ts';
import { formatBytes, formatDuration } from '../utils/system.ts';
import { logger } from '../logger.ts';
import { getCurrentUser } from './client.ts';

export class BotHandler {
  private client: TelegramClient;
  private queue: DownloadQueue;

  constructor(client: TelegramClient, queue: DownloadQueue) {
    this.client = client;
    this.queue = queue;
  }

  registerEvents(): void {
    this.client.addEventHandler(this.onNewMessage.bind(this), new NewMessage({}));
    logger.info('Registered Telegram Userbot message event handlers.');
  }

  private async onNewMessage(event: NewMessageEvent): Promise<void> {
    const message = event.message;
    if (!message || !message.text) return;

    const rawText = message.text.trim();
    const prefix = config.commandPrefix;

    // Identify chat context
    const chatId = message.peerId;
    const isPrivate = message.isPrivate;
    const isGroup = message.isGroup;
    const isChannel = message.isChannel;

    // Check if message is from Saved Messages / Self
    const me = getCurrentUser();
    const isSelf = message.out || (me && message.senderId?.toString() === me.id?.toString());

    // 1. Command: .ping
    if (rawText === `${prefix}ping`) {
      const now = Date.now();
      const reply = await message.reply({ message: '🏓 Pong!' });
      const latency = Date.now() - now;
      if (reply && reply.id) {
        await this.client.editMessage(chatId, {
          message: reply.id,
          text: `🏓 **Pong!** Userbot active.\n⚡ Latency: \`${latency}ms\``,
        });
      }
      return;
    }

    // 2. Command: .status
    if (rawText === `${prefix}status`) {
      const activeJobs = this.queue.getActiveJobs();
      const pendingCount = this.queue.getPendingQueueLength();

      let text = `📊 **Userbot Downloader Status**\n\n`;
      text += `• Active jobs: **${activeJobs.length}/${config.maxConcurrentJobs}**\n`;
      text += `• Pending in queue: **${pendingCount}**\n\n`;

      if (activeJobs.length > 0) {
        text += `**Currently Downloading:**\n`;
        activeJobs.forEach((job, idx) => {
          const dur = Math.round((Date.now() - job.startTime) / 1000);
          text += `${idx + 1}. \`${job.id}\`\n`;
          text += `   - URL: ${job.originalUrl.slice(0, 45)}...\n`;
          text += `   - Engine: ${job.activeEngine || 'Detecting'}\n`;
          text += `   - Status: ${job.statusMessage || job.status} (${dur}s)\n`;
        });
      } else {
        text += `_No active download jobs._`;
      }

      await message.reply({ message: text });
      return;
    }

    // 3. Command: .help
    if (rawText === `${prefix}help`) {
      let helpText = `🎬 **Telegram HLS/M3U8 Userbot Downloader**\n\n`;
      helpText += `**Commands:**\n`;
      helpText += `• \`${prefix}dl <url>\` : Download video with multi-layer fallback\n`;
      helpText += `• \`${prefix}status\` : Check active download queue\n`;
      helpText += `• \`${prefix}ping\` : Check bot latency\n`;
      helpText += `• \`${prefix}help\` : Show this command list\n\n`;
      helpText += `**Supported Formats:**\n`;
      helpText += `• Direct .m3u8 (HLS playlists / live / VOD)\n`;
      helpText += `• Embedded web video players (Playwright sniffing)\n`;
      helpText += `• Streamlink & yt-dlp supported streams\n`;
      helpText += `• Direct MP4, WebM, MKV streams\n\n`;
      helpText += `_Note: Send or forward any link in Saved Messages or Private Chat to download automatically._`;
      await message.reply({ message: helpText });
      return;
    }

    // 4. Command: .dl <url>
    let targetUrl: string | null = null;
    if (rawText.startsWith(`${prefix}dl `)) {
      const urls = extractUrlsFromText(rawText.slice(prefix.length + 3));
      if (urls.length > 0) {
        targetUrl = urls[0];
      } else {
        await message.reply({ message: '⚠️ Please provide a valid HTTP/HTTPS URL: `.dl https://...`' });
        return;
      }
    }

    // 5. Automatic URL Detection
    if (!targetUrl) {
      const shouldAutoDownload =
        (isSelf && config.autoDownloadSavedMessages) ||
        (isPrivate && config.autoDownloadPrivate) ||
        (isGroup && config.autoDownloadGroups);

      if (shouldAutoDownload) {
        const urls = extractUrlsFromText(rawText);
        if (urls.length > 0) {
          targetUrl = urls[0];
        }
      }
    }

    // If an action URL is detected, trigger the download pipeline
    if (targetUrl) {
      await this.handleDownloadRequest(event, targetUrl);
    }
  }

  private async handleDownloadRequest(event: NewMessageEvent, targetUrl: string): Promise<void> {
    const originalMsg = event.message;
    const chatId = originalMsg.peerId;

    logger.info(`Incoming download request from chat for URL: ${targetUrl}`);

    // Send the single progress message that will be continuously updated
    let progressMsg: any;
    try {
      progressMsg = await originalMsg.reply({
        message: `⏳ **Queued**\nURL: \`${targetUrl.slice(0, 50)}...\``,
      });
    } catch (err: any) {
      logger.error('Failed to send initial progress message:', err);
      return;
    }

    const progressTracker = new ProgressTracker(this.client, chatId, progressMsg.id);

    try {
      const completedTask = await this.queue.enqueue(
        {
          originalUrl: targetUrl,
          chatId,
          messageId: progressMsg.id,
        },
        async (statusText, percent) => {
          let formattedText = `${statusText}\n\n`;
          formattedText += `🔗 **Target:** \`${targetUrl.slice(0, 55)}...\`\n`;
          if (percent !== undefined && percent > 0) {
            const barLength = 10;
            const filled = Math.min(barLength, Math.round((percent / 100) * barLength));
            const empty = barLength - filled;
            formattedText += `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%\n`;
          }
          await progressTracker.update(formattedText);
        }
      );

      // Successfully processed video
      if (completedTask.outputPath && fs.existsSync(completedTask.outputPath)) {
        await progressTracker.update('📤 **Uploading video to Telegram...** (Please wait)');

        const fileSize = completedTask.sizeBytes || fs.statSync(completedTask.outputPath).size;
        const durationSec = Math.round(completedTask.duration || 0);
        const width = completedTask.width || 1280;
        const height = completedTask.height || 720;

        // Build caption
        let caption = `🎬 **Video Downloaded Successfully**\n\n`;
        caption += `📦 **Size:** \`${formatBytes(fileSize)}\`\n`;
        if (durationSec > 0) {
          caption += `⏱️ **Duration:** \`${formatDuration(durationSec)}\`\n`;
        }
        caption += `📐 **Resolution:** \`${width}x${height}\`\n`;
        caption += `⚡ **Engine:** \`${completedTask.activeEngine || 'HLS Fallback'}\`\n`;
        caption += `🔗 **Source:** \`${targetUrl.slice(0, 60)}...\``;

        // Construct video document attribute for streaming support
        const videoAttr = new Api.DocumentAttributeVideo({
          duration: durationSec,
          w: width,
          h: height,
          supportsStreaming: true,
        });

        // Upload video file
        await this.client.sendFile(chatId, {
          file: completedTask.outputPath,
          caption,
          thumb: completedTask.thumbnailPath && fs.existsSync(completedTask.thumbnailPath)
            ? completedTask.thumbnailPath
            : undefined,
          attributes: [videoAttr],
          replyTo: originalMsg.id,
          progressCallback: async (progress: number) => {
            const percent = Math.round(progress * 100);
            if (percent % 25 === 0) {
              await progressTracker.update(`📤 **Uploading to Telegram:** ${percent}%`);
            }
          },
        });

        // Mark single progress message as Done
        await progressTracker.markDone(
          `✅ **Done!** Video uploaded.\nSize: \`${formatBytes(fileSize)}\` | Engine: \`${completedTask.activeEngine}\``
        );

        // Clean up output file after successful upload
        try {
          fs.unlinkSync(completedTask.outputPath);
          if (completedTask.thumbnailPath && fs.existsSync(completedTask.thumbnailPath)) {
            fs.unlinkSync(completedTask.thumbnailPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      logger.error(`Download job failed for ${targetUrl}:`, errorMsg);

      let failText = `❌ **Download Failed**\n\n`;
      failText += `🔗 **URL:** \`${targetUrl.slice(0, 60)}...\`\n`;
      failText += `⚠️ **Error Summary:**\n\`${errorMsg.slice(0, 450)}\`\n\n`;
      failText += `_All fallback download engines were attempted before concluding failure._`;

      await progressTracker.markFailed(failText);
    }
  }
}
