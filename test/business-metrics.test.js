import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBusinessMetrics } from '../src/business-metrics.js';

test('business metrics use a bounded database failure label', async () => {
  const metrics = createBusinessMetrics();
  metrics.orderCreated();
  metrics.orderFailed('database');
  metrics.observePool({ totalCount: 0, idleCount: 0, waitingCount: 0 });
  assert.throws(() => metrics.orderFailed('order-77'), /unsupported failure reason/);
  const output = await metrics.registry.metrics();
  assert.match(output, /mini_commerce_orders_created_total 1/);
  assert.match(output, /mini_commerce_order_failures_total\{reason="database"\} 1/);
  assert.match(output, /mini_commerce_db_pool_connections\{state="total"\} 0/);
  assert.match(output, /mini_commerce_db_pool_connections\{state="idle"\} 0/);
  assert.match(output, /mini_commerce_db_pool_waiting_requests 0/);
  assert.doesNotMatch(output, /^http_requests_total/m);
});
