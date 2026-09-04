import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createDatabaseObservability } from '../src/database-observability.js';

test('pool observer reports bounded pool snapshot and removes listener', () => {
  const pool = Object.assign(new EventEmitter(), { totalCount: 4, idleCount: 2, waitingCount: 1 });
  let seen;
  let errors = 0;
  let failures = 0;
  let recoveries = 0;
  const observer = createDatabaseObservability({ pool, metrics: {
    observePool: (value) => { seen = value; }, recordPoolError: () => { errors += 1; },
  }, readiness: {
    recordDependencyFailure: () => { failures += 1; }, recordDependencyRecovery: () => { recoveries += 1; },
  } });
  assert.deepEqual(observer.snapshot(), { totalCount: 4, idleCount: 2, waitingCount: 1 });
  assert.deepEqual(seen, { totalCount: 4, idleCount: 2, waitingCount: 1 });
  pool.emit('error', new Error('unavailable'));
  pool.emit('connect');
  assert.equal(errors, 1);
  assert.equal(failures, 1);
  assert.equal(recoveries, 1);
  observer.close();
  assert.equal(pool.listenerCount('error'), 0);
  assert.equal(pool.listenerCount('connect'), 0);
});
