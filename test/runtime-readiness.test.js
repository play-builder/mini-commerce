import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { createLogger } from '../src/logger.js';
import { createRuntime } from '../src/runtime.js';

function runtimeConfig(overrides = {}) {
  return {
    environment: 'test', version: 'test', gitSha: 'test', buildDate: 'test', podName: 'test',
    publicPort: 0, managementPort: 0, databaseEnabled: true, readinessDependencyPolicy: 'startup-only',
    readinessFailureThreshold: 1, readinessRecoveryThreshold: 1, shutdownDeadlineMs: 1000,
    database: {}, ...overrides,
  };
}

function poolWithQuery(query) {
  return Object.assign(new EventEmitter(), { totalCount: 0, idleCount: 0, waitingCount: 0, query, end: async () => {} });
}

test('failed initial dependency check starts both listeners in sanitized not-ready state', async (t) => {
  const runtime = createRuntime({
    runtimeConfig: runtimeConfig(),
    dependencies: { createDatabasePool: () => poolWithQuery(async () => { throw new Error('password=private'); }), exit() {} },
  });
  const { publicServer, managementServer } = await runtime.start();
  t.after(() => runtime.shutdown());
  const response = await fetch(`http://127.0.0.1:${managementServer.address().port}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'not ready', reason: 'dependency unavailable' });
  assert.ok(publicServer.listening);
});

test('runtime default lifecycle receives process.exit without invoking it during construction', async (t) => {
  let lifecycleArguments;
  const runtime = createRuntime({
    runtimeConfig: runtimeConfig({ databaseEnabled: false }),
    dependencies: {
      createLifecycle: (argumentsValue) => { lifecycleArguments = argumentsValue; return { shutdown: async () => {} }; },
    },
  });
  const { publicServer, managementServer } = await runtime.start();
  t.after(() => { publicServer.close(); managementServer.close(); });
  assert.equal(lifecycleArguments.exit, process.exit);
});

test('continuous runtime readiness follows repository query failure and recovery thresholds', async (t) => {
  let available = true;
  const pool = poolWithQuery(async () => {
    if (!available) throw new Error('connection refused password=private');
    return { rows: [], rowCount: 0 };
  });
  const runtime = createRuntime({
    runtimeConfig: runtimeConfig({ readinessDependencyPolicy: 'continuous', readinessFailureThreshold: 2, readinessRecoveryThreshold: 2 }),
    dependencies: { createDatabasePool: () => pool, exit() {} },
  });
  await runtime.start();
  t.after(() => runtime.shutdown());
  assert.equal(runtime.readiness.snapshot().ready, true);
  available = false;
  await assert.rejects(runtime.commerceService.isReady());
  assert.equal(runtime.readiness.snapshot().ready, true);
  await assert.rejects(runtime.commerceService.isReady());
  assert.equal(runtime.readiness.snapshot().ready, false);
  available = true;
  await runtime.commerceService.isReady();
  assert.equal(runtime.readiness.snapshot().ready, false);
  await runtime.commerceService.isReady();
  assert.equal(runtime.readiness.snapshot().ready, true);
});

test('startup-only runtime keeps ready state after a repository query failure', async (t) => {
  let available = true;
  const pool = poolWithQuery(async () => {
    if (!available) throw new Error('connection refused password=private');
    return { rows: [], rowCount: 0 };
  });
  const runtime = createRuntime({
    runtimeConfig: runtimeConfig(),
    dependencies: { createDatabasePool: () => pool, exit() {} },
  });
  await runtime.start();
  t.after(() => runtime.shutdown());
  available = false;
  await assert.rejects(runtime.commerceService.isReady());
  assert.equal(runtime.readiness.snapshot().ready, true);
});

test('continuous readiness counts one successful transaction as one recovery', async (t) => {
  let readinessAvailable = true;
  const pool = poolWithQuery(async () => {
    if (!readinessAvailable) throw new Error('connection refused');
    return { rows: [], rowCount: 1 };
  });
  const client = {
    async query(text) {
      if (/FROM orders\s+WHERE idempotency_key/.test(text)) return { rows: [], rowCount: 0 };
      if (/FOR UPDATE OF i/.test(text)) {
        return {
          rows: [{ id: 1, sku: 'SKU-1', name: 'Widget', price_cents: 1000, available_quantity: 10 }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO orders/.test(text)) {
        return {
          rows: [{ id: 41, status: 'CONFIRMED', total_cents: 1000, created_at: '2026-09-05T00:00:00Z' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  pool.connect = async () => {
    pool.emit('connect', client);
    return client;
  };
  const runtime = createRuntime({
    runtimeConfig: runtimeConfig({
      readinessDependencyPolicy: 'continuous',
      readinessFailureThreshold: 1,
      readinessRecoveryThreshold: 2,
    }),
    dependencies: { createDatabasePool: () => pool, exit() {} },
  });
  await runtime.start();
  t.after(() => runtime.shutdown());

  readinessAvailable = false;
  await assert.rejects(runtime.commerceService.isReady());
  assert.equal(runtime.readiness.snapshot().ready, false);

  await runtime.commerceService.createOrder({
    idempotencyKey: 'order-41',
    items: [{ productId: 1, quantity: 1 }],
  });
  assert.equal(runtime.readiness.snapshot().ready, false);

  readinessAvailable = true;
  await runtime.commerceService.isReady();
  assert.equal(runtime.readiness.snapshot().ready, true);
});

test('startup-only runtime emits sanitized metric and log for a business query failure', async (t) => {
  const rawError = 'password=private SELECT card_number FROM customers';
  let queryCount = 0;
  const pool = poolWithQuery(async () => {
    queryCount += 1;
    if (queryCount > 1) throw new Error(rawError);
    return { rows: [{ '?column?': 1 }], rowCount: 1 };
  });
  const lines = [];
  const runtime = createRuntime({
    runtimeConfig: runtimeConfig(),
    dependencies: {
      createDatabasePool: () => pool,
      createLogger: (options) => createLogger({ ...options, write: (line) => lines.push(JSON.parse(line)) }),
      exit() {},
    },
  });
  const { publicServer, managementServer } = await runtime.start();
  t.after(() => runtime.shutdown());

  const response = await fetch(`http://127.0.0.1:${publicServer.address().port}/products`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'database unavailable' });
  assert.equal(runtime.readiness.snapshot().ready, true);

  const metrics = await (await fetch(`http://127.0.0.1:${managementServer.address().port}/metrics`)).text();
  assert.match(metrics, /mini_commerce_db_operation_failures_total\{operation="list_products"\} 1/);
  const failure = lines.find((record) => record.event === 'database.operation.failed');
  assert.deepEqual({
    event: failure?.event,
    operation: failure?.operation,
    reason: failure?.reason,
  }, {
    event: 'database.operation.failed',
    operation: 'list_products',
    reason: 'query_failed',
  });
  assert.equal(JSON.stringify(lines).includes(rawError), false);
});
