import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config, isConfigured, saveSessionString } from '../config.ts';
import { logger } from '../logger.ts';

let clientInstance: TelegramClient | null = null;
let currentMe: any = null;

export async function initTelegramClient(): Promise<TelegramClient | null> {
  if (clientInstance) {
    return clientInstance;
  }

  if (!isConfigured()) {
    logger.warn('TELEGRAM_API_ID or TELEGRAM_API_HASH is not set in .env! Userbot cannot connect to Telegram.');
    return null;
  }

  const stringSession = new StringSession(config.session || '');
  clientInstance = new TelegramClient(stringSession, config.apiId, config.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });

  try {
    logger.info('Connecting to Telegram network...');
    await clientInstance.connect();

    const isAuthorized = await clientInstance.isUserAuthorized();
    if (!isAuthorized) {
      logger.warn('================================================================');
      logger.warn(' Telegram Userbot is NOT authenticated yet!');
      logger.warn(' Please run "pnpm run login" in your terminal to log in to Telegram.');
      logger.warn('================================================================');
      return null;
    }

    currentMe = await clientInstance.getMe();
    const displayName = [currentMe.firstName, currentMe.lastName].filter(Boolean).join(' ');
    const username = currentMe.username ? `@${currentMe.username}` : `ID:${currentMe.id}`;

    logger.info(`✅ Successfully authenticated as Telegram User: ${displayName} (${username})`);

    // Save session string if updated
    const sessionStr = clientInstance.session.save() as unknown as string;
    if (sessionStr && sessionStr !== config.session) {
      saveSessionString(sessionStr);
      logger.info('Updated session string stored safely.');
    }

    return clientInstance;
  } catch (err: any) {
    logger.error('Failed to connect Telegram Userbot:', err.message || err);
    return null;
  }
}

export function getClient(): TelegramClient | null {
  return clientInstance;
}

export function getCurrentUser(): any {
  return currentMe;
}
