import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReadiness } from '../src/readiness.js';

test('startup-only readiness stays ready after a later database failure', async () => {
  const readiness = createReadiness({ dependencyPolicy: 'startup-only', checkDependency: async () => true });
  await readiness.initialize();
  readiness.recordDependencyFailure();
  assert.deepEqual(readiness.snapshot(), {
    ready: true, phase: 'ready', dependencyPolicy: 'startup-only', reason: undefined,
  });
});

test('continuous readiness is an explicit non-production policy', async () => {
  const readiness = createReadiness({ dependencyPolicy: 'continuous', checkDependency: async () => true });
  await readiness.initialize();
  readiness.recordDependencyFailure();
  assert.equal(readiness.snapshot().ready, false);
  assert.equal(readiness.snapshot().reason, 'dependency unavailable');
});

test('a rejected initial dependency check is represented as sanitized not-ready state', async () => {
  const readiness = createReadiness({ checkDependency: async () => { throw new Error('password=private'); } });
  await readiness.initialize();
  assert.deepEqual(readiness.snapshot(), {
    ready: false, phase: 'not-ready', dependencyPolicy: 'startup-only', reason: 'dependency unavailable',
  });
});
