import fs from 'fs';
import path from 'path';
import express, { Request, Response } from 'express';
import { config, isConfigured } from './config.ts';
import { logger, initLogger } from './logger.ts';
import { initTelegramClient, getCurrentUser } from './bot/client.ts';
import { BotHandler } from './bot/handler.ts';
import { DownloadQueue } from './queue/download-queue.ts';
import { FallbackOrchestrator } from './engines/orchestrator.ts';
import { isTermuxOrPRoot } from './utils/system.ts';
import { analyzeUrl } from './utils/url-extractor.ts';

const app = express();
const queue = new DownloadQueue();
const orchestrator = new FallbackOrchestrator();

initLogger(config.logDir);

app.use(express.json());

// Serve static assets from public and src/assets
app.use('/assets', express.static(path.join(process.cwd(), 'public/assets')));
app.use('/assets', express.static(path.join(process.cwd(), 'src/assets')));
app.use(express.static(path.join(process.cwd(), 'public')));

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

// GET /api/engines - List fallback engines and live availability
app.get('/api/engines', async (_req: Request, res: Response) => {
  const engines = orchestrator.getEngines();
  const engineAvailability = await Promise.all(
    engines.map(async e => ({ name: e.name, available: await e.isAvailable() }))
  );
  res.json({
    total: engines.length,
    engines: engineAvailability,
  });
});

// POST /api/analyze-url - Fast non-invasive URL routing inspection
app.post('/api/analyze-url', (req: Request, res: Response) => {
  const url = req.body?.url;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Valid "url" string required in request body' });
    return;
  }
  const result = analyzeUrl(url);
  res.json(result);
});

// GET / - Serve the promotional dashboard
app.get('/', (_req: Request, res: Response) => {
  const indexPath = path.join(process.cwd(), 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(indexPath);
    return;
  }
  res.status(404).send('index.html not found');
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
