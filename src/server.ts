import express, { Request, Response } from 'express';
import { config, isConfigured } from './config.ts';
import { logger, initLogger } from './logger.ts';
import { initTelegramClient, getCurrentUser } from './bot/client.ts';
import { BotHandler } from './bot/handler.ts';
import { DownloadQueue } from './queue/download-queue.ts';
import { FallbackOrchestrator } from './engines/orchestrator.ts';
import { isTermuxOrPRoot } from './utils/system.ts';

const app = express();
const queue = new DownloadQueue();
const orchestrator = new FallbackOrchestrator();

initLogger(config.logDir);

app.use(express.json());

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// GET /status
app.get('/status', (_req: Request, res: Response) => {
  const me = getCurrentUser();
  const activeJobs = queue.getActiveJobs();
  const pendingCount = queue.getPendingQueueLength();

  res.json({
    telegramUserbot: {
      configured: isConfigured(),
      authenticated: Boolean(me),
      user: me ? { id: me.id, username: me.username, firstName: me.firstName } : null,
    },
    concurrency: {
      maxConcurrent: config.maxConcurrentJobs,
      activeJobsCount: activeJobs.length,
      pendingQueueCount: pendingCount,
    },
    activeJobs: activeJobs.map(j => ({
      id: j.id,
      url: j.originalUrl,
      status: j.status,
      activeEngine: j.activeEngine,
      elapsedSeconds: Math.floor((Date.now() - j.startTime) / 1000),
    })),
  });
});

// GET /
app.get('/', async (_req: Request, res: Response) => {
  const me = getCurrentUser();
  const envInfo = isTermuxOrPRoot();
  const engines = orchestrator.getEngines();
  const engineAvailability = await Promise.all(
    engines.map(async e => ({ name: e.name, available: await e.isAvailable() }))
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Telegram Video HLS Fallback Userbot</title>
      <meta name="description" content="Telegram Userbot video downloader with multi-layer HLS/M3U8 fallback orchestrator and FFmpeg processing.">
      <meta property="og:title" content="Telegram Video HLS Fallback Userbot">
      <meta property="og:description" content="Telegram Userbot video downloader with multi-layer HLS/M3U8 fallback orchestrator and FFmpeg processing.">
      <style>
        body { font-family: monospace, system-ui; background: #0f172a; color: #f8fafc; padding: 2rem; max-width: 800px; margin: 0 auto; line-height: 1.5; }
        .card { background: #1e293b; padding: 1.25rem; border-radius: 8px; margin-bottom: 1.5rem; border: 1px solid #334155; }
        h1 { color: #38bdf8; font-size: 1.5rem; margin-top: 0; }
        h2 { color: #94a3b8; font-size: 1.1rem; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; }
        .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 4px; font-weight: bold; font-size: 0.85rem; }
        .badge-pass { background: #065f46; color: #34d399; }
        .badge-warn { background: #854d0e; color: #facc15; }
        .badge-fail { background: #991b1b; color: #f87171; }
        ul { padding-left: 1.25rem; }
        li { margin-bottom: 0.35rem; }
        code { background: #334155; padding: 0.2rem 0.4rem; border-radius: 4px; }
      </style>
    </head>
    <body>
      <h1>⚡ Telegram HLS/M3U8 Fallback Userbot</h1>
      <div class="card">
        <h2>🤖 Userbot Status</h2>
        <p>Configured: <span class="badge ${isConfigured() ? 'badge-pass' : 'badge-warn'}">${isConfigured() ? 'YES' : 'MISSING CREDENTIALS'}</span></p>
        <p>Authenticated: <span class="badge ${me ? 'badge-pass' : 'badge-warn'}">${me ? `YES (${me.firstName || ''} @${me.username || me.id})` : 'NOT LOGGED IN (run: pnpm run login)'}</span></p>
        <p>Target Environment: <code>${envInfo.isTermux ? 'Termux' : 'Linux'}${envInfo.isPRoot ? ' + PRoot' : ''}</code></p>
      </div>

      <div class="card">
        <h2>🛠️ Fallback Downloader Engines</h2>
        <ul>
          ${engineAvailability
            .map(
              e =>
                `<li>${e.name}: <span class="badge ${e.available ? 'badge-pass' : 'badge-fail'}">${e.available ? 'READY' : 'UNAVAILABLE'}</span></li>`
            )
            .join('')}
        </ul>
      </div>

      <div class="card">
        <h2>📖 Telegram Usage Guide</h2>
        <p>Send links to your Saved Messages or any chat:</p>
        <ul>
          <li><code>.dl &lt;url&gt;</code> - Download video via fallback pipeline</li>
          <li><code>.status</code> - Check current jobs & queue</li>
          <li><code>.ping</code> - Test userbot connection</li>
          <li><code>.help</code> - Show commands</li>
        </ul>
      </div>
    </body>
    </html>
  `);
});

let serverInstance: any = null;

export async function startServer(): Promise<void> {
  if (serverInstance) {
    return;
  }
  const port = config.port || 3000;
  serverInstance = app.listen(port, '0.0.0.0', () => {
    logger.info(`🚀 Backend server listening on http://0.0.0.0:${port}`);
  });

  // Initialize Telegram Userbot in background
  try {
    const client = await initTelegramClient();
    if (client) {
      const handler = new BotHandler(client, queue);
      handler.registerEvents();
      logger.info('Userbot event loop is active and listening for incoming messages.');
    }
  } catch (err) {
    logger.error('Error starting Userbot client loop:', err);
  }
}

export function stopServer(): void {
  if (serverInstance) {
    serverInstance.close();
  }
}

if (process.env.NODE_ENV !== 'test' && !process.env.AIS_DISABLE_AUTOSTART) {
  startServer();
}

export default app;
