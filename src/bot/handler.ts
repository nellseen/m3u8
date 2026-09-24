import { TelegramClient, Api } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import fs from 'fs';
import { config, saveTargetChannel } from '../config.ts';
import { DownloadQueue } from '../queue/download-queue.ts';
import { ProgressTracker } from './progress.ts';
import { extractUrlsFromText } from '../utils/url-extractor.ts';
import { formatBytes, formatDuration } from '../utils/system.ts';
import { logger } from '../logger.ts';
import { getCurrentUser } from './client.ts';
import { DownloadTask } from '../types.ts';

/**
 * Builds public or private channel post link
 */
export function getTelegramPostUrl(channelIdentifier: string, messageId: number): string | null {
  const clean = channelIdentifier.trim();
  if (clean.startsWith('@')) {
    return `https://t.me/${clean.slice(1)}/${messageId}`;
  }
  if (clean.startsWith('-100')) {
    return `https://t.me/c/${clean.slice(4)}/${messageId}`;
  }
  if (!clean.startsWith('-') && /^\d+$/.test(clean)) {
    return `https://t.me/c/${clean}/${messageId}`;
  }
  return null;
}

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

    const chatId = message.peerId;
    const isPrivate = message.isPrivate;
    const isGroup = message.isGroup;

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
          text: `🏓 **Pong!** Userbot aktif.\n⚡ Latency: \`${latency}ms\``,
        });
      }
      return;
    }

    // 2. Command: .channel [optional new channel id]
    if (rawText.startsWith(`${prefix}channel`)) {
      const parts = rawText.split(/\s+/);
      const newChannel = parts[1]?.trim();

      if (newChannel) {
        if (!isSelf) {
          await message.reply({ message: '⛔ Hanya pemilik userbot yang dapat mengubah TARGET_CHANNEL_ID.' });
          return;
        }
        saveTargetChannel(newChannel);
        await message.reply({
          message: `✅ **TARGET_CHANNEL_ID Berhasil Diperbarui!**\n\n📢 Channel Tujuan: \`${newChannel}\`\nPengaturan telah disimpan otomatis ke file \`.env\`.`,
        });
        return;
      }

      const current = config.targetChannelId;
      await message.reply({
        message: `📢 **Pengaturan Channel Pengiriman Video**\n\n` +
          `• Target Channel Saat Ini: ${current ? `\`${current}\`` : '⚠️ **BELUM DIATUR**'}\n\n` +
          `Untuk mengubah channel tujuan, gunakan:\n` +
          `\`${prefix}channel @namachannel\` atau \`${prefix}channel -100xxxxxxxxxx\``,
      });
      return;
    }

    // 3. Command: .status
    if (rawText === `${prefix}status`) {
      const activeJobs = this.queue.getActiveJobs();
      const pendingCount = this.queue.getPendingQueueLength();
      const completedJobs = this.queue.getCompletedJobs();
      const targetChannel = config.targetChannelId;

      let text = `📊 **Userbot Downloader Status**\n\n`;
      text += `• Active jobs: **${activeJobs.length}/${config.maxConcurrentJobs}**\n`;
      text += `• Pending in queue: **${pendingCount}**\n`;
      text += `• Target Channel Wajib: ${targetChannel ? `\`${targetChannel}\`` : '⚠️ **BELUM DIATUR (.env)**'}\n\n`;

      if (activeJobs.length > 0) {
        text += `**Sedang Diproses:**\n`;
        activeJobs.forEach((job, idx) => {
          const dur = Math.round((Date.now() - job.startTime) / 1000);
          text += `${idx + 1}. \`${job.id}\`\n`;
          text += `   - URL: ${job.originalUrl.slice(0, 45)}...\n`;
          text += `   - Status: ${job.statusMessage || job.status} (${dur}s)\n`;
        });
        text += '\n';
      }

      if (completedJobs.length > 0) {
        text += `**Riwayat Publikasi ke Channel:**\n`;
        completedJobs.slice(0, 5).forEach((job, idx) => {
          text += `${idx + 1}. \`${job.id}\`\n`;
          text += `   - Channel: \`${job.channelPeerId || targetChannel}\`\n`;
          text += `   - Telegram Message ID: \`#${job.channelMessageId || 'N/A'}\`\n`;
          if (job.channelPostUrl) {
            text += `   - Link: ${job.channelPostUrl}\n`;
          }
          if (job.metadata?.translatedTitle) {
            text += `   - Judul: ${job.metadata.translatedTitle}\n`;
          }
        });
      } else {
        text += `_Belum ada video yang diupload pada sesi ini._`;
      }

      await message.reply({ message: text });
      return;
    }

    // 4. Command: .help
    if (rawText === `${prefix}help`) {
      let helpText = `🎬 **Telegram HLS/M3U8 Userbot Downloader**\n\n`;
      helpText += `**Aturan Pengiriman:**\n`;
      helpText += `Setiap video yang berhasil didownload WAJIB dikirim ke **TARGET_CHANNEL_ID**.\n`;
      helpText += `Status sukses hanya diberikan ke pengguna setelah upload ke channel terverifikasi (Downloaded file ≠ Success jika upload channel gagal).\n\n`;
      helpText += `**Daftar Perintah:**\n`;
      helpText += `• \`${prefix}dl <url>\` : Download video & kirim wajib ke channel target\n`;
      helpText += `• \`${prefix}channel <id>\` : Cek atau ubah TARGET_CHANNEL_ID (@channel atau -100...)\n`;
      helpText += `• \`${prefix}status\` : Cek status antrian & riwayat Message ID channel\n`;
      helpText += `• \`${prefix}ping\` : Cek latensi userbot\n`;
      helpText += `• \`${prefix}help\` : Menampilkan petunjuk ini\n\n`;
      helpText += `**Fitur Unggulan:**\n`;
      helpText += `• 6-Layer Fallback Downloader (Direct, Playwright Sniffer, Streamlink, yt-dlp, FFmpeg HLS, Retry)\n`;
      helpText += `• Normalisasi resolusi maksimal 720p tanpa upscaling\n`;
      helpText += `• Ekstraksi metadata & terjemahan judul ke Bahasa Indonesia\n`;
      helpText += `• Pembuatan thumbnail presisi frame 25 detik\n`;
      helpText += `• Penyimpanan Telegram Message ID pasca upload channel\n\n`;
      helpText += `_Kirim link langsung di Saved Messages atau Private Chat untuk unduhan otomatis._`;
      await message.reply({ message: helpText });
      return;
    }

    // 5. Command: .dl <url>
    let targetUrl: string | null = null;
    if (rawText.startsWith(`${prefix}dl `)) {
      const urls = extractUrlsFromText(rawText.slice(prefix.length + 3));
      if (urls.length > 0) {
        targetUrl = urls[0];
      } else {
        await message.reply({ message: '⚠️ Masukkan URL HTTP/HTTPS yang valid: `.dl https://...`' });
        return;
      }
    }

    // 6. Automatic URL Detection
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

    if (targetUrl) {
      await this.handleDownloadRequest(event, targetUrl);
    }
  }

  /**
   * Resolves target channel identifier into a valid GramJS entity
   */
  private async resolveChannelPeer(channelIdentifier: string): Promise<any> {
    const trimmed = channelIdentifier.trim();

    // 1. Try directly with original string or username
    try {
      const entity = await this.client.getEntity(trimmed);
      if (entity) return entity;
    } catch {}

    // 2. Numeric / BigInt ID handling
    if (/^-?\d+$/.test(trimmed)) {
      try {
        const bigIntVal = BigInt(trimmed);
        const entity = await this.client.getEntity(bigIntVal as any);
        if (entity) return entity;
      } catch {}

      // Try stripping -100 prefix or adding -100 prefix
      if (trimmed.startsWith('-100')) {
        try {
          const stripped = trimmed.slice(4);
          const entity = await this.client.getEntity(BigInt(stripped) as any);
          if (entity) return entity;
        } catch {}
      } else if (!trimmed.startsWith('-')) {
        try {
          const withPrefix = `-100${trimmed}`;
          const entity = await this.client.getEntity(BigInt(withPrefix) as any);
          if (entity) return entity;
        } catch {}
      }
    }

    // 3. Fallback username prefix
    if (!trimmed.startsWith('@') && !/^-?\d+$/.test(trimmed)) {
      try {
        const entity = await this.client.getEntity(`@${trimmed}`);
        if (entity) return entity;
      } catch {}
    }

    // Fallback: return raw string
    return trimmed;
  }

  /**
   * Mandatory upload to TARGET_CHANNEL_ID with retry policy
   */
  private async uploadToChannelWithRetry(
    targetPeer: any,
    targetChannelStr: string,
    task: DownloadTask,
    caption: string,
    videoAttr: Api.DocumentAttributeVideo,
    progressTracker: ProgressTracker
  ): Promise<Api.Message> {
    const MAX_RETRIES = 3;
    let lastError: any = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        logger.info(`[Upload] Uploading task ${task.id} to TARGET_CHANNEL_ID: ${targetChannelStr} (Percobaan ${attempt}/${MAX_RETRIES})...`);
        await progressTracker.update(`📤 Mengunggah video ke TARGET_CHANNEL_ID (\`${targetChannelStr}\`)... (Percobaan ${attempt}/${MAX_RETRIES})`);

        let validThumb: string | undefined = undefined;
        if (task.thumbnailPath && fs.existsSync(task.thumbnailPath)) {
          try {
            const thumbStat = fs.statSync(task.thumbnailPath);
            // Telegram requires thumbnail size < 200KB and non-zero
            if (thumbStat.size > 100 && thumbStat.size < 200 * 1024) {
              validThumb = task.thumbnailPath;
            } else {
              logger.warn(`Thumbnail skipped: size ${thumbStat.size} bytes outside Telegram safe boundary`);
            }
          } catch {
            validThumb = undefined;
          }
        }

        let sentMessage: any;
        try {
          sentMessage = await this.client.sendFile(targetPeer, {
            file: task.outputPath!,
            caption,
            thumb: validThumb,
            attributes: [videoAttr],
            supportsStreaming: true,
            progressCallback: async (progress: number) => {
              const percent = Math.round(progress * 100);
              if (percent % 25 === 0) {
                await progressTracker.update(`📤 Upload ke Channel (${targetChannelStr}): ${percent}%`);
              }
            },
          });
        } catch (sendErr: any) {
          // If error specifically mentions thumb/image or PHOTO_INVALID, retry without thumbnail immediately
          const sendErrMsg = sendErr?.message || String(sendErr);
          if (validThumb && (sendErrMsg.includes('thumb') || sendErrMsg.includes('PHOTO_') || sendErrMsg.includes('IMAGE_'))) {
            logger.warn(`Thumbnail rejected by Telegram (${sendErrMsg}). Retrying upload immediately without thumbnail...`);
            sentMessage = await this.client.sendFile(targetPeer, {
              file: task.outputPath!,
              caption,
              thumb: undefined,
              attributes: [videoAttr],
              supportsStreaming: true,
              progressCallback: async (progress: number) => {
                const percent = Math.round(progress * 100);
                if (percent % 25 === 0) {
                  await progressTracker.update(`📤 Upload ke Channel (${targetChannelStr}): ${percent}%`);
                }
              },
            });
          } else {
            throw sendErr;
          }
        }

        if (!sentMessage || !sentMessage.id) {
          throw new Error('Telegram tidak mengembalikan message ID yang valid.');
        }

        return sentMessage as Api.Message;
      } catch (err: any) {
        lastError = err;
        const errMsg = err?.message || String(err);
        logger.warn(`[Upload] Attempt ${attempt}/${MAX_RETRIES} to channel ${targetChannelStr} failed: ${errMsg}`);

        // Check for fatal permission errors
        if (
          errMsg.includes('CHAT_ADMIN_REQUIRED') ||
          errMsg.includes('CHAT_WRITE_FORBIDDEN') ||
          errMsg.includes('CHANNEL_PRIVATE') ||
          errMsg.includes('USER_BANNED_IN_CHANNEL')
        ) {
          throw new Error(`Akses ditolak pada channel ${targetChannelStr}: ${errMsg}. Pastikan akun userbot sudah bergabung dan menjadi admin/memiliki izin kirim media.`);
        }

        // Check for Telegram FLOOD_WAIT
        const floodMatch = errMsg.match(/FLOOD_WAIT_(\d+)/i);
        if (floodMatch) {
          const waitSec = parseInt(floodMatch[1], 10);
          if (waitSec <= 30 && attempt < MAX_RETRIES) {
            logger.warn(`Flood wait ${waitSec}s encountered. Waiting before retry...`);
            await progressTracker.update(`⏳ Flood wait Telegram ${waitSec}s... Menunggu giliran upload.`);
            await new Promise(r => setTimeout(r, (waitSec + 1) * 1000));
            continue;
          } else {
            throw new Error(`Telegram FloodWait (${waitSec}s) melebihi batas toleransi retry.`);
          }
        }

        // Exponential backoff between retries
        if (attempt < MAX_RETRIES) {
          const backoffMs = attempt * 2000;
          await progressTracker.update(`⚠️ Percobaan ${attempt} gagal, mencoba ulang dalam ${backoffMs / 1000}s...`);
          await new Promise(r => setTimeout(r, backoffMs));
        }
      }
    }

    throw new Error(`Upload ke TARGET_CHANNEL_ID (${targetChannelStr}) gagal setelah ${MAX_RETRIES} kali percobaan: ${lastError?.message || lastError}`);
  }

  private cleanupTaskFiles(task: DownloadTask): void {
    try {
      if (task.outputPath && fs.existsSync(task.outputPath)) {
        fs.unlinkSync(task.outputPath);
      }
      if (task.thumbnailPath && fs.existsSync(task.thumbnailPath)) {
        fs.unlinkSync(task.thumbnailPath);
      }
    } catch {
      // Ignore cleanup error
    }
  }

  private async handleDownloadRequest(event: NewMessageEvent, targetUrl: string): Promise<void> {
    const originalMsg = event.message;
    const chatId = originalMsg.peerId;
    const me = getCurrentUser();
    const isSelf = originalMsg.out || (me && originalMsg.senderId?.toString() === me.id?.toString());
    const isPrivate = originalMsg.isPrivate;

    logger.info(`Incoming download request from chat for URL: ${targetUrl}`);

    // Send single progress message that will be continuously edited
    let progressMsg: any;
    try {
      progressMsg = await originalMsg.reply({
        message: `🔎 Mendeteksi URL & Analisis Sumber\n${targetUrl.slice(0, 50)}...`,
      });
    } catch (err: any) {
      logger.error('Failed to send initial progress message:', err);
      return;
    }

    const progressTracker = new ProgressTracker(this.client, chatId, progressMsg.id);

    try {
      // Execute Queue: Detect URL -> Analyze Source -> Detect HLS/M3U8 -> Resolve Media -> Download -> Validate -> FFmpeg Processing -> Extract Metadata -> Thumbnail
      const completedTask = await this.queue.enqueue(
        {
          originalUrl: targetUrl,
          chatId,
          messageId: progressMsg.id,
        },
        async (statusText, percent) => {
          let formattedText = `${statusText}\n`;
          if (percent !== undefined && percent > 0) {
            const barLength = 10;
            const filled = Math.min(barLength, Math.round((percent / 100) * barLength));
            const empty = barLength - filled;
            formattedText += `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%\n`;
          }
          await progressTracker.update(formattedText);
        }
      );

      // Verify that local processing produced a valid output file
      if (!completedTask.outputPath || !fs.existsSync(completedTask.outputPath)) {
        throw new Error('File hasil download tidak ditemukan di sistem penyimpanan.');
      }

      // ─────────────────────────────────────────────────────────────
      // MANDATORY RULE: TARGET_CHANNEL_ID CHECK & UPLOAD
      // Every downloaded video MUST be uploaded to TARGET_CHANNEL_ID.
      // Downloaded file ≠ Success if upload to channel fails!
      // ─────────────────────────────────────────────────────────────
      const targetChannelStr = (config.targetChannelId || '').trim();
      if (!targetChannelStr) {
        const configError = 'TARGET_CHANNEL_ID belum dikonfigurasi di file .env. Video WAJIB diupload ke TARGET_CHANNEL_ID. Sesuai aturan: Downloaded file ≠ Success!';
        logger.taskError(completedTask.id, 'BotHandler', 'CHANNEL_UPLOAD', 'TELEGRAM_UPLOAD_ERROR', configError);
        completedTask.status = 'failed';
        completedTask.errorCategory = 'TELEGRAM_UPLOAD_ERROR';
        completedTask.endTime = Date.now();
        await progressTracker.markFailed(`❌ **Pengiriman Ditolak**: ${configError}\n\nGunakan perintah \`${config.commandPrefix}channel @namachannel\` untuk mengatur channel tujuan.`);
        this.cleanupTaskFiles(completedTask);
        return;
      }

      await progressTracker.update(`🔄 Menyiapkan pengiriman ke TARGET_CHANNEL_ID (${targetChannelStr})...`);

      // Resolve channel entity
      const targetPeer = await this.resolveChannelPeer(targetChannelStr);

      const fileSize = completedTask.sizeBytes || fs.statSync(completedTask.outputPath).size;
      const durationSec = Math.round(completedTask.duration || 0);
      const width = completedTask.width || 1280;
      const height = completedTask.height || 720;
      const meta = completedTask.metadata || {};

      // Domain extraction for caption
      let domain = meta.domain;
      if (!domain) {
        try {
          domain = new URL(targetUrl).hostname.replace(/^www\./, '');
        } catch {
          domain = 'web';
        }
      }

      // Indonesian Title prioritized
      const mainTitle = meta.translatedTitle || meta.originalTitle || 'Video';
      const origTitle = meta.originalTitle && meta.originalTitle !== mainTitle ? meta.originalTitle : undefined;

      // Construct caption
      let caption = `🎬 ${mainTitle}\n\n`;
      if (origTitle) {
        caption += `🌐 Original: ${origTitle}\n`;
      }
      if (domain) {
        caption += `🔗 Source: ${domain}\n`;
      }
      if (durationSec > 0) {
        caption += `⏱ Duration: ${formatDuration(durationSec)}\n`;
      }
      caption += `📐 Resolution: ${width}x${height}\n`;
      if (meta.codec) {
        caption += `🎞 Video: ${meta.codec}\n`;
      }
      if (meta.audioCodec) {
        caption += `🎵 Audio: ${meta.audioCodec}\n`;
      }
      caption += `📦 Size: ${formatBytes(fileSize)}`;

      // Streaming attribute
      const videoAttr = new Api.DocumentAttributeVideo({
        duration: durationSec,
        w: width,
        h: height,
        supportsStreaming: true,
      });

      // UPLOAD TO TARGET_CHANNEL_ID WITH RETRY
      let sentChannelMsg: Api.Message;
      try {
        sentChannelMsg = await this.uploadToChannelWithRetry(
          targetPeer,
          targetChannelStr,
          completedTask,
          caption,
          videoAttr,
          progressTracker
        );
      } catch (uploadError: any) {
        // CRITICAL: downloaded file ≠ success!
        completedTask.status = 'failed';
        completedTask.errorCategory = 'TELEGRAM_UPLOAD_ERROR';
        completedTask.endTime = Date.now();
        logger.taskError(completedTask.id, 'BotHandler', 'CHANNEL_UPLOAD', 'TELEGRAM_UPLOAD_ERROR', uploadError.message);

        await progressTracker.markFailed(
          `❌ **Upload ke Channel Gagal**: File video berhasil diunduh namun gagal dikirim ke TARGET_CHANNEL_ID (\`${targetChannelStr}\`).\n\n` +
          `Sesuai aturan sistem: *Downloaded file ≠ Success*.\n\n` +
          `Detail: ${uploadError.message}`
        );

        this.cleanupTaskFiles(completedTask);
        return;
      }

      // ─────────────────────────────────────────────────────────────
      // SIMPAN TELEGRAM MESSAGE ID
      // ─────────────────────────────────────────────────────────────
      const channelMessageId = sentChannelMsg.id;
      completedTask.channelMessageId = channelMessageId;
      completedTask.channelPeerId = targetChannelStr;
      const postUrl = getTelegramPostUrl(targetChannelStr, channelMessageId);
      completedTask.channelPostUrl = postUrl || undefined;

      // Mark task as completed now that channel upload succeeded
      completedTask.status = 'completed';
      completedTask.endTime = Date.now();
      this.queue.recordCompletedJob(completedTask);

      logger.info(`[Channel Upload SUCCESS] Task ${completedTask.id} -> Target: ${targetChannelStr} -> Telegram Message ID: #${channelMessageId}`);

      // ─────────────────────────────────────────────────────────────
      // KIRIM STATUS BERHASIL KE USER
      // ─────────────────────────────────────────────────────────────
      let userStatusText = `✅ **Video Berhasil Dipublikasikan ke Channel!**\n\n`;
      userStatusText += `📢 **Target Channel**: \`${targetChannelStr}\`\n`;
      userStatusText += `🆔 **Telegram Message ID**: \`#${channelMessageId}\`\n`;
      if (postUrl) {
        userStatusText += `🔗 **Tautan Post**: [Buka di Telegram](${postUrl})\n`;
      }
      userStatusText += `\n🎬 **Judul**: ${mainTitle}\n`;
      if (origTitle) {
        userStatusText += `🌐 **Original**: ${origTitle}\n`;
      }
      if (domain) {
        userStatusText += `🔗 **Sumber**: ${domain}\n`;
      }
      if (durationSec > 0) {
        userStatusText += `⏱ **Durasi**: ${formatDuration(durationSec)}\n`;
      }
      userStatusText += `📐 **Resolusi**: ${width}x${height}\n`;
      if (meta.codec) {
        userStatusText += `🎞 **Video**: ${meta.codec}\n`;
      }
      if (meta.audioCodec) {
        userStatusText += `🎵 **Audio**: ${meta.audioCodec}\n`;
      }
      userStatusText += `📦 **Ukuran**: ${formatBytes(fileSize)}`;

      await progressTracker.markDone(userStatusText);

      // If user invoked from Saved Messages / Private, optionally forward video post for convenient playback
      if (isSelf || isPrivate) {
        try {
          await this.client.forwardMessages(chatId, {
            messages: [channelMessageId],
            fromPeer: targetPeer,
          });
        } catch (fwdErr) {
          logger.debug(`Forwarding post to requester chat skipped: ${fwdErr}`);
        }
      }

      // Clean up permanent video & thumbnail from disk
      this.cleanupTaskFiles(completedTask);

    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      logger.error(`Download job failed for ${targetUrl}:`, errorMsg);

      let userFacingError = errorMsg;
      if (errorMsg.includes('DRM Protection') || errorMsg.includes('DRM')) {
        userFacingError = `🔒 **Konten Dilindungi DRM (Digital Rights Management)**\n\n${errorMsg}\n\n_Sesuai kebijakan: DRM memerlukan lisensi proprietary yang tidak tersedia dan tidak dapat dibypass._`;
      } else if (errorMsg.includes('SAMPLE-AES')) {
        userFacingError = `🔒 **Enkripsi SAMPLE-AES Terdeteksi**\n\n${errorMsg}\n\n_Format enkripsi sample-level ini memerlukan dekripsi CDM berlisensi yang tidak didukung._`;
      } else if (errorMsg.includes('Expired') || errorMsg.includes('expired') || errorMsg.includes('Forbidden/Unauthorized')) {
        userFacingError = `⏱️ **Tautan / Token Segment Kadaluarsa**\n\n${errorMsg}\n\n_Silakan kirimkan tautan baru dari browser Anda._`;
      }

      await progressTracker.markFailed(userFacingError.slice(0, 400));
    }
  }
}
