import express from 'express';
import { context, trace } from '@opentelemetry/api';
import { requestId, runWithRequestContext } from './request-context.js';

export function createApplication({ commerceService } = {}) {
  if (!commerceService) throw new TypeError('commerceService is required');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    const spanContext = trace.getSpan(context.active())?.spanContext();
    const currentRequestId = requestId(req.get('x-request-id'));
    res.set('x-request-id', currentRequestId);
    runWithRequestContext({ requestId: currentRequestId, traceId: spanContext?.traceId }, next);
  });
  app.get('/products', async (_req, res, next) => {
    try { res.json({ products: await commerceService.listProducts() }); } catch (error) { next(error); }
  });
  app.get('/products/:id/inventory', async (req, res, next) => {
    try { res.json(await commerceService.getInventory(req.params.id)); } catch (error) { next(error); }
  });
  app.post('/orders', async (req, res, next) => {
    try {
      const order = await commerceService.createOrder({
        idempotencyKey: req.get('Idempotency-Key') ?? '',
        items: req.body?.items,
      });
      res.status(201).json({ order });
    } catch (error) { next(error); }
  });
  app.get('/orders/:id', async (req, res, next) => {
    try { res.json({ order: await commerceService.getOrder(req.params.id) }); } catch (error) { next(error); }
  });
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use((error, _req, res, _next) => {
    const status = error.statusCode ?? 500;
    const message = error.name === 'DatabaseUnavailableError'
      ? 'database unavailable'
      : status >= 500 ? 'internal server error' : error.message;
    res.status(status).json({ error: message });
  });
  return app;
}
