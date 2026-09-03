import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { verifyCommerceInvariants } from '../scripts/verify-commerce-invariants.mjs';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;

test('commerce invariant verifier는 음수 재고 corruption을 거부한다', { skip: !databaseUrl }, async () => {
  await runner({
    databaseUrl,
    dir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
  });
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE inventory DROP CONSTRAINT inventory_available_quantity_check');
    await client.query('UPDATE inventory SET available_quantity = -1 WHERE product_id = 1');
    await assert.rejects(verifyCommerceInvariants(client), /negativeInventoryRows/);
    await client.query('ROLLBACK');
    const result = await verifyCommerceInvariants(pool);
    assert.equal(result.negativeInventoryRows, 0);
  } finally {
    if (!client.released) {
      await client.query('ROLLBACK');
      client.release();
    }
    await pool.end();
  }
});
