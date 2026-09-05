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

test('order rejection log carries only a bounded failure reason', async () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)) });
  const service = createCommerceService({
    async withTransaction() { throw new Error('not reached'); },
  }, { logger });

  await assert.rejects(service.createOrder({ idempotencyKey: '', items: [] }));

  assert.deepEqual({ event: lines[0].event, reason: lines[0].reason }, {
    event: 'commerce.order.rejected',
    reason: 'validation',
  });
  assert.deepEqual(Object.keys(lines[0]).sort(), [
    'environment', 'event', 'level', 'reason', 'service', 'timestamp', 'version',
  ]);
});
