import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { verifyRestore } from '../scripts/verify-restore.mjs';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;
const migrationsDirectory = new URL('../migrations', import.meta.url).pathname;

function migrate(database) {
  return runner({
    databaseUrl: database,
    dir: migrationsDirectory,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
  });
}

test('독립 recovery DB의 schema, rows, checksum과 invariant를 source와 비교한다', {
  skip: !databaseUrl,
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const suffix = `${process.pid}_${Date.now()}`;
  const sourceName = `commerce_restore_source_${suffix}`;
  const recoveryName = `commerce_restore_recovery_${suffix}`;
  await adminPool.query(`CREATE DATABASE "${sourceName}"`);
  await adminPool.query(`CREATE DATABASE "${recoveryName}"`);
  const sourceUrl = new URL(databaseUrl);
  sourceUrl.pathname = `/${sourceName}`;
  const recoveryUrl = new URL(databaseUrl);
  recoveryUrl.pathname = `/${recoveryName}`;
  await migrate(sourceUrl.toString());
  await migrate(recoveryUrl.toString());
  const sourcePool = new Pool({ connectionString: sourceUrl.toString() });
  const recoveryPool = new Pool({ connectionString: recoveryUrl.toString() });
  try {
    const productTimestamps = await sourcePool.query('SELECT id, created_at FROM products ORDER BY id');
    for (const row of productTimestamps.rows) {
      await recoveryPool.query('UPDATE products SET created_at = $2 WHERE id = $1', [row.id, row.created_at]);
    }
    const inventoryTimestamps = await sourcePool.query(
      'SELECT product_id, updated_at FROM inventory ORDER BY product_id',
    );
    for (const row of inventoryTimestamps.rows) {
      await recoveryPool.query(
        'UPDATE inventory SET updated_at = $2 WHERE product_id = $1',
        [row.product_id, row.updated_at],
      );
    }
    const verified = await verifyRestore({ sourcePool, recoveryPool });
    assert.equal(verified.schemaVersion, '003_contract_product_name');
    assert.equal(verified.foreignKeyViolations, 0);
    assert.equal(verified.duplicateIdempotencyKeys, 0);
    assert.equal(verified.negativeInventoryRows, 0);

    await recoveryPool.query('UPDATE inventory SET available_quantity = available_quantity - 1 WHERE product_id = 1');
    await assert.rejects(
      verifyRestore({ sourcePool, recoveryPool }),
      /RESTORE_DATA_MISMATCH/,
    );
  } finally {
    await sourcePool.end();
    await recoveryPool.end();
    await adminPool.query(`DROP DATABASE "${sourceName}" WITH (FORCE)`);
    await adminPool.query(`DROP DATABASE "${recoveryName}" WITH (FORCE)`);
    await adminPool.end();
  }
});
