import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApplication } from '../src/application.js';
import { DatabaseUnavailableError } from '../src/commerce-service.js';
import { createManagement } from '../src/management.js';

function routes(app) {
  return app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} ${layer.route.path}`))
    .sort();
}

test('public and management route ownership is disjoint', () => {
  const commerceService = {
    listProducts: async () => [],
    getInventory: async () => ({}),
    createOrder: async () => ({}),
    getOrder: async () => ({}),
  };
  const readiness = { snapshot: () => ({ ready: true }) };
  const metrics = { contentType: 'text/plain', metrics: async () => '' };

  assert.deepEqual(routes(createApplication({ commerceService })), [
    'GET /orders/:id',
    'GET /products',
    'GET /products/:id/inventory',
    'POST /orders',
  ]);
  assert.deepEqual(routes(createManagement({ readiness, metrics, build: {} })), [
    'GET /healthz', 'GET /metrics', 'GET /readyz', 'GET /version',
  ]);
});

test('database failure is an actual HTTP 503 without raw driver text', async (t) => {
  const app = createApplication({
    commerceService: { async listProducts() { throw new DatabaseUnavailableError(); } },
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/products`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'database unavailable' });
});
