import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApplication } from '../src/application.js';
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
