import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/routes.js';
import { markReady, state } from '../src/state.js';

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('healthz 는 readiness 와 무관하게 200 을 돌려준다', async () => {
  state.ready = false;
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'alive');
});

test('readyz 는 준비되기 전에 503 을 돌려준다', async () => {
  state.ready = false;
  const response = await fetch(`${base}/readyz`);
  assert.equal(response.status, 503);
});

test('readyz 는 준비된 뒤에 200 을 돌려준다', async () => {
  markReady();
  const response = await fetch(`${base}/readyz`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'ready');
});

test('version 은 빌드 정보를 돌려준다', async () => {
  const response = await fetch(`${base}/version`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.ok(Object.hasOwn(body, 'version'));
  assert.ok(Object.hasOwn(body, 'gitSha'));
  assert.ok(Object.hasOwn(body, 'buildDate'));
});

test('config 는 secret 값을 그대로 내보내지 않는다', async () => {
  const response = await fetch(`${base}/config`);
  assert.equal(response.status, 200);

  const body = await response.json();
  const raw = JSON.stringify(body);
  assert.ok(Array.isArray(body.keys));
  assert.ok(!raw.includes('value'));
});

test('metrics 는 요청 수 지표를 담는다', async () => {
  await fetch(`${base}/`);
  const response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 200);

  const body = await response.text();
  assert.ok(body.includes('http_requests_total'));
});

test('없는 경로는 404 를 돌려준다', async () => {
  const response = await fetch(`${base}/no-such-path`);
  assert.equal(response.status, 404);
});

test('Stateless 모드에서는 commerce API가 명시적인 503을 돌려준다', async () => {
  const response = await fetch(`${base}/products`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'database feature is disabled',
  });
});

test('Stateful 모드에서는 상품, 재고, 주문 API를 commerce service에 위임한다', async (t) => {
  const calls = [];
  const commerceService = {
    async listProducts() {
      calls.push('listProducts');
      return [{ id: 1, sku: 'COURSE-LAPTOP', name: 'Course Laptop', priceCents: 129900 }];
    },
    async getInventory(productId) {
      calls.push(['getInventory', productId]);
      return { productId, availableQuantity: 7 };
    },
    async createOrder(input) {
      calls.push(['createOrder', input]);
      return { id: 42, status: 'CONFIRMED', totalCents: 259800, items: input.items };
    },
    async isReady() {
      return true;
    },
  };
  const statefulServer = createApp({ databaseEnabled: true, commerceService }).listen(0);
  t.after(async () => {
    statefulServer.closeAllConnections();
    await new Promise((resolve, reject) => {
      statefulServer.close((error) => (error ? reject(error) : resolve()));
    });
  });
  await new Promise((resolve) => statefulServer.once('listening', resolve));
  const statefulBase = `http://127.0.0.1:${statefulServer.address().port}`;

  const products = await fetch(`${statefulBase}/products`);
  assert.equal(products.status, 200);
  assert.equal((await products.json()).products[0].sku, 'COURSE-LAPTOP');

  const inventory = await fetch(`${statefulBase}/products/1/inventory`);
  assert.equal(inventory.status, 200);
  assert.equal((await inventory.json()).availableQuantity, 7);

  const order = await fetch(`${statefulBase}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'lesson-order-001' },
    body: JSON.stringify({ items: [{ productId: 1, quantity: 2 }] }),
  });
  assert.equal(order.status, 201);
  assert.equal((await order.json()).order.totalCents, 259800);
  assert.deepEqual(calls, [
    'listProducts',
    ['getInventory', '1'],
    ['createOrder', { idempotencyKey: 'lesson-order-001', items: [{ productId: 1, quantity: 2 }] }],
  ]);
});
