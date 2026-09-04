import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifecycle } from '../src/lifecycle.js';

test('shutdown drains in deterministic order once', async () => {
  const calls = [];
  const close = (name) => (done) => { calls.push(name); done(); };
  const lifecycle = createLifecycle({
    readiness: { markNotReady: () => calls.push('readiness') },
    publicServer: { close: close('public') },
    managementServer: { close: close('management') },
    pool: { end: async () => calls.push('pool') },
    telemetry: { shutdown: async () => calls.push('telemetry') },
    exit: () => calls.push('exit'),
  });
  await lifecycle.shutdown();
  await lifecycle.shutdown();
  assert.deepEqual(calls, ['readiness', 'public', 'pool', 'telemetry', 'management', 'exit']);
});
