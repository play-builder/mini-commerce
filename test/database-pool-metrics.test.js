import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createDatabaseObservability } from '../src/database-observability.js';

test('pool observer reports bounded pool snapshot and removes listener', () => {
  const pool = Object.assign(new EventEmitter(), { totalCount: 4, idleCount: 2, waitingCount: 1 });
  let seen;
  const observer = createDatabaseObservability({ pool, metrics: { observePool: (value) => { seen = value; } } });
  assert.deepEqual(observer.snapshot(), { totalCount: 4, idleCount: 2, waitingCount: 1 });
  assert.deepEqual(seen, { totalCount: 4, idleCount: 2, waitingCount: 1 });
  observer.close();
  assert.equal(pool.listenerCount('error'), 0);
});
