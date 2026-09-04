import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBusinessMetrics } from '../src/business-metrics.js';

test('business metrics use a bounded database failure label', async () => {
  const metrics = createBusinessMetrics();
  metrics.orderCreated();
  metrics.orderFailed('database');
  assert.throws(() => metrics.orderFailed('order-77'), /unsupported failure reason/);
  const output = await metrics.registry.metrics();
  assert.match(output, /mini_commerce_orders_created_total 1/);
  assert.match(output, /mini_commerce_order_failures_total\{reason="database"\} 1/);
  assert.doesNotMatch(output, /^http_requests_total/m);
});
