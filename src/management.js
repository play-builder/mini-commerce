import express from 'express';

export function createManagement({ readiness, metrics, build }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ status: 'alive' }));
  app.get('/readyz', (_req, res) => {
    const state = readiness.snapshot();
    res.status(state.ready ? 200 : 503).json(state.ready ? { status: 'ready' } : { status: 'not ready', reason: state.reason });
  });
  app.get('/metrics', async (_req, res, next) => {
    try { res.type(metrics.contentType).send(await metrics.metrics()); } catch (error) { next(error); }
  });
  app.get('/version', (_req, res) => res.json(build));
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use((_error, _req, res, next) => {
    if (res.headersSent) return next(_error);
    res.status(500).json({ error: 'internal server error' });
  });
  return app;
}
