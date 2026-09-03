import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registry } from '../src/metrics.js';
import { createApp } from '../src/routes.js';
import { markReady } from '../src/state.js';
import { withDatabaseSpan } from '../src/telemetry.js';

test('request log는 correlation ID만 기록하고 request secret과 metric cardinality를 제한한다', async (t) => {
  const capturedLogs = [];
  const originalLog = console.log;
  console.log = (line) => capturedLogs.push(line);
  t.after(() => { console.log = originalLog; });

  markReady();
  const commerceService = {
    async isReady() { return true; },
    async createOrder() { return { id: 1, status: 'CONFIRMED', totalCents: 100 }; },
  };
  const server = createApp({ databaseEnabled: true, commerceService }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  await new Promise((resolve) => server.once('listening', resolve));

  await fetch(`http://127.0.0.1:${server.address().port}/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'secret-replay-key',
      'x-request-id': 'req-001',
      traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    },
    body: JSON.stringify({ cardNumber: '4111111111111111', items: [{ productId: 1, quantity: 1 }] }),
  });

  const serialized = capturedLogs.join('\n');
  assert.match(serialized, /"requestId":"req-001"/);
  assert.match(serialized, /"traceId":"[0-9a-f]{32}"/);
  assert.doesNotMatch(serialized, /secret-replay-key/);
  assert.doesNotMatch(serialized, /cardNumber/);
  assert.doesNotMatch(serialized, /DB_PASSWORD/);
  assert.doesNotMatch(await registry.metrics(), /traceId/);
});

test('database wrapper는 query span을 끝내고 execute 결과를 반환한다', async () => {
  const spanNames = [];
  let ended = 0;
  const tracer = {
    startActiveSpan(name, callback) {
      spanNames.push(name);
      return callback({
        recordException() {},
        end() { ended += 1; },
      });
    },
  };
  const value = await withDatabaseSpan({ tracer, execute: async () => 'query-result' });
  assert.deepEqual(spanNames, ['postgresql.query']);
  assert.equal(ended, 1);
  assert.equal(value, 'query-result');
});
