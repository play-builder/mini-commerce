import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { verifyCommerceInvariants } from '../scripts/verify-commerce-invariants.mjs';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;

test('commerce invariant verifier는 구조 위반과 명시적인 최소 workload 위반을 구분한다', { skip: !databaseUrl }, async () => {
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
    await client.query('TRUNCATE order_items, orders RESTART IDENTITY');
    assert.equal((await verifyCommerceInvariants(client)).orderCount, 0);
    await assert.rejects(
      verifyCommerceInvariants(client, { minimumOrderCount: 1 }),
      /minimumOrderCount=1, actual=0/,
    );
    const order = await client.query(`
      INSERT INTO orders (idempotency_key, status, total_cents)
      VALUES ('invariant-control-order', 'CREATED', 129900)
      RETURNING id
    `);
    await client.query(`
      INSERT INTO order_items
        (order_id, product_id, sku, product_name, unit_price_cents, quantity)
      VALUES ($1, 1, 'COURSE-LAPTOP', 'Course Laptop', 129900, 1)
    `, [order.rows[0].id]);
    assert.equal((await verifyCommerceInvariants(client, { minimumOrderCount: 1 })).orderCount, 1);
    await client.query('ALTER TABLE inventory DROP CONSTRAINT inventory_available_quantity_check');
    await client.query('UPDATE inventory SET available_quantity = -1 WHERE product_id = 1');
    await assert.rejects(verifyCommerceInvariants(client), /negativeInventoryRows/);
    await client.query('ROLLBACK');
  } finally {
    if (!client.released) {
      await client.query('ROLLBACK');
      client.release();
    }
    await pool.end();
  }
});
