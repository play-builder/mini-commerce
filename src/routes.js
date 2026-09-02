import express from 'express';
import { config } from './config.js';
import { state } from './state.js';
import { metricsMiddleware, registry } from './metrics.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rootHandler(req, res) {
  if (config.latencyMs > 0) {
    await sleep(config.latencyMs);
  }

  if (config.failureRate > 0 && Math.random() < config.failureRate) {
    res.status(500).json({
      error: 'injected failure',
      version: config.version,
      pod: config.podName,
    });
    return;
  }

  res.json({
    message: 'playbuilder sample app',
    version: config.version,
    gitSha: config.gitSha,
    pod: config.podName,
    node: config.nodeName,
  });
}

function healthzHandler(req, res) {
  res.json({ status: 'alive' });
}

async function readyzHandler(req, res, databaseEnabled, commerceService) {
  if (!state.ready) {
    res.status(503).json({ status: 'not ready', reason: state.reason });
    return;
  }
  if (databaseEnabled) {
    try {
      await commerceService.isReady();
    } catch {
      res.status(503).json({ status: 'not ready', reason: 'database unavailable' });
      return;
    }
  }
  res.json({ status: 'ready' });
}

function versionHandler(req, res) {
  res.json({
    version: config.version,
    gitSha: config.gitSha,
    buildDate: config.buildDate,
    nodeVersion: process.version,
    pod: config.podName,
  });
}

function configHandler(req, res) {
  const keys = config.secretKeys.map((name) => {
    const value = process.env[name];
    const present = typeof value === 'string' && value.length > 0;
    return { name, present, length: present ? value.length : 0 };
  });

  res.json({
    failureRate: config.failureRate,
    latencyMs: config.latencyMs,
    readyDelayMs: config.readyDelayMs,
    shutdownDelayMs: config.shutdownDelayMs,
    keys,
  });
}

async function metricsHandler(req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

function databaseDisabledHandler(req, res) {
  res.status(503).json({ error: 'database feature is disabled' });
}

export function createApp(options = {}) {
  const databaseEnabled = options.databaseEnabled ?? config.databaseEnabled;
  const commerceService = options.commerceService;
  if (databaseEnabled && !commerceService) {
    throw new TypeError('commerceService is required when database is enabled');
  }
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(metricsMiddleware);

  app.get('/', rootHandler);
  app.get('/healthz', healthzHandler);
  app.get('/readyz', (req, res) => readyzHandler(req, res, databaseEnabled, commerceService));
  app.get('/version', versionHandler);
  app.get('/config', configHandler);
  app.get('/metrics', metricsHandler);

  if (!databaseEnabled) {
    app.get('/products', databaseDisabledHandler);
    app.get('/products/:id/inventory', databaseDisabledHandler);
    app.post('/orders', databaseDisabledHandler);
    app.get('/db/status', databaseDisabledHandler);
  } else {
    app.get('/products', async (_req, res) => {
      res.json({ products: await commerceService.listProducts() });
    });
    app.get('/products/:id/inventory', async (req, res) => {
      res.json(await commerceService.getInventory(req.params.id));
    });
    app.post('/orders', async (req, res) => {
      const order = await commerceService.createOrder({
        idempotencyKey: req.get('Idempotency-Key') ?? '',
        items: req.body?.items,
      });
      res.status(201).json({ order });
    });
    app.get('/db/status', async (_req, res) => {
      await commerceService.isReady();
      res.json({ status: 'connected' });
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) {
      res.status(400).json({ error: 'request body must be valid JSON' });
      return;
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'internal server error' : error.message });
  });

  return app;
}
