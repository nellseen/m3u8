import { config, isConfigured } from './config.ts';
import { logger, initLogger } from './logger.ts';
import { initTelegramClient } from './bot/client.ts';
import { BotHandler } from './bot/handler.ts';
import { DownloadQueue } from './queue/download-queue.ts';
import { startServer } from './server.ts';

async function main() {
  initLogger(config.logDir);

  logger.info('====================================================');
  logger.info('  Telegram HLS/M3U8 Downloader Userbot Starting...  ');
  logger.info('====================================================');

  if (!isConfigured()) {
    logger.warn('TELEGRAM_API_ID and TELEGRAM_API_HASH are not set in .env!');
    logger.warn('Please obtain them from https://my.telegram.org and configure .env');
  }

  // Ensure HTTP server is active for port 3000 health checks
  await startServer();

  logger.info('Userbot worker daemon ready.');
}

main().catch(err => {
  logger.error('Fatal error starting userbot:', err);
  process.exit(1);
});
