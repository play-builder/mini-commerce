import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCommerceService } from '../src/commerce-service.js';
import { createLogger } from '../src/logger.js';
import { runWithRequestContext } from '../src/request-context.js';

test('order creation emits only bounded business spans and allowlisted Pino events', async () => {
  const spans = [];
  const tracer = {
    startActiveSpan(name, options, callback) {
      spans.push({ name, attributes: options.attributes });
      return callback({ setStatus() {}, end() {} });
    },
  };
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)) });
  const repository = {
    async withTransaction(callback) {
      return callback({
        async advisoryLock() {}, async findOrderByIdempotencyKey() { return null; },
        async lockInventory() { return [{ productId: 1, sku: 'SKU', name: 'Name', priceCents: 100, availableQuantity: 2 }]; },
        async insertOrder() { return { id: 7, status: 'CONFIRMED', totalCents: 100 }; },
        async insertOrderItem() {}, async decrementInventory() {},
      });
    },
  };
  const service = createCommerceService(repository, { logger, tracer });
  await runWithRequestContext({ requestId: 'request-1', traceId: 'trace-1' }, () => service.createOrder({
    idempotencyKey: 'private-key', items: [{ productId: 1, quantity: 1 }],
  }));
  assert.deepEqual(spans.map((span) => span.name), [
    'commerce.order.create', 'commerce.db.transaction', 'commerce.inventory.reserve',
  ]);
  assert.deepEqual(spans.map((span) => span.attributes), [
    { 'commerce.item_count': 1 }, {}, { 'commerce.item_count': 1 },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'commerce.order.created');
  assert.equal(JSON.stringify({ spans, lines }).includes('private-key'), false);
});
