import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyRestore } from '../../scripts/verify-restore.mjs';

function pool(database, { fail = false, rollbackFails = false } = {}) {
  const calls = [];
  let released;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('current_database()')) return { rows: [{ database, host: '127.0.0.1', port: 5432 }] };
      if (sql.startsWith('SELECT name')) {
        if (fail) throw new Error('snapshot failed');
        return { rows: [{ name: '003_contract_product_name' }] };
      }
      if (sql.startsWith('SELECT *')) return { rows: [{ id: 1 }], rowCount: 1 };
      if (rollbackFails && sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [{ count: 0 }] };
    },
    release(discard) { released = discard; },
  };
  return { calls, released: () => released, connect: async () => client };
}

test('restore verification refuses two pools connected to the same real database identity', async () => {
  await assert.rejects(verifyRestore({ sourcePool: pool('source'), recoveryPool: pool('source') }), /RESTORE_DATABASES_MUST_DIFFER/);
});

test('restore snapshots use one read-only repeatable-read transaction and preserve the evidence result schema', async () => {
  const sourcePool = pool('source');
  const recoveryPool = pool('recovery');
  const result = await verifyRestore({ sourcePool, recoveryPool });
  assert.equal(result.rowCount, 4);
  assert.deepEqual(Object.keys(result).sort(), ['checksum', 'duplicateIdempotencyKeys', 'foreignKeyViolations', 'negativeInventoryRows', 'rowCount', 'schemaVersion']);
  for (const current of [sourcePool, recoveryPool]) {
    assert.equal(current.calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(current.calls.at(-1), 'COMMIT');
    assert.equal(current.released(), false);
  }
});

test('failed restore capture waits for both clients to release and evicts an unconfirmed rollback', async () => {
  const sourcePool = pool('source', { fail: true, rollbackFails: true });
  const recoveryPool = pool('recovery');
  await assert.rejects(verifyRestore({ sourcePool, recoveryPool }), /snapshot failed/);
  assert.equal(sourcePool.calls.at(-1), 'ROLLBACK');
  assert.equal(sourcePool.released(), true);
  assert.equal(recoveryPool.released(), false);
});
