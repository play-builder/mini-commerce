import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRuntime } from '../src/runtime.js';

test('runtime assembles one business registry for commerce and management listeners', async (t) => {
  const exits = [];
  const runtime = createRuntime({
    runtimeConfig: {
      environment: 'test', version: 'test', gitSha: 'test', buildDate: 'test', podName: 'test',
      publicPort: 0, managementPort: 0, databaseEnabled: false, readinessDependencyPolicy: 'startup-only',
      readinessFailureThreshold: 1, readinessRecoveryThreshold: 1, shutdownDeadlineMs: 1000,
    },
    dependencies: { exit: (code) => exits.push(code) },
  });
  const { managementServer } = await runtime.start();
  t.after(() => runtime.shutdown());
  runtime.metrics.orderCreated();
  const response = await fetch(`http://127.0.0.1:${managementServer.address().port}/metrics`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /mini_commerce_orders_created_total 1/);
  await runtime.shutdown();
  assert.deepEqual(exits, [0]);
});
