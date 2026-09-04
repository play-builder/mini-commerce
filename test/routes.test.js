import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApplication } from '../src/application.js';
import { createManagement } from '../src/management.js';
import { createReadiness } from '../src/readiness.js';

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('management listener owns liveness, readiness, metrics, and version only', async (t) => {
  const readiness = createReadiness();
  const base = await listen(createManagement({
    readiness, metrics: { contentType: 'text/plain', metrics: async () => 'mini_commerce_orders_created_total 0\n' }, build: { version: 'test' },
  }), t);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  await readiness.initialize();
  assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { status: 'ready' });
  assert.equal((await fetch(`${base}/products`)).status, 404);
});

test('business listener owns the four commerce operations and hides idempotency keys', async (t) => {
  const calls = [];
  const service = {
    async listProducts() { return [{ id: 1, sku: 'LAPTOP' }]; },
    async getInventory(id) { return { productId: Number(id), availableQuantity: 7 }; },
    async createOrder(input) { calls.push(input); return { id: 42, status: 'CONFIRMED', totalCents: 100, items: input.items }; },
    async getOrder() { return { id: 42, status: 'CONFIRMED', totalCents: 100, items: [] }; },
  };
  const base = await listen(createApplication({ commerceService: service }), t);
  assert.equal((await fetch(`${base}/products`)).status, 200);
  assert.equal((await fetch(`${base}/products/1/inventory`)).status, 200);
  const created = await fetch(`${base}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'private-key' },
    body: JSON.stringify({ items: [{ productId: 1, quantity: 1 }] }),
  });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(await created.json()).includes('private-key'), false);
  assert.deepEqual(calls, [{ idempotencyKey: 'private-key', items: [{ productId: 1, quantity: 1 }] }]);
  assert.equal((await fetch(`${base}/orders/42`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 404);
});
