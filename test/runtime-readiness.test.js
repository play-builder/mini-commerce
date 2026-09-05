import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

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
