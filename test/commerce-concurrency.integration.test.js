import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { createCommerceService } from '../src/commerce-service.js';
import { createPostgresCommerceRepository } from '../src/database.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

test('동일 idempotency key의 동시 주문은 한 번만 재고를 차감한다', {
  skip: !databaseUrl,
}, async () => {
  await runner({
    databaseUrl,
    dir: migrationsDirectory,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
  });

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('TRUNCATE order_items, orders RESTART IDENTITY');
    await pool.query('UPDATE inventory SET available_quantity = 20');

    const firstService = createCommerceService(createPostgresCommerceRepository(pool));
    const secondService = createCommerceService(createPostgresCommerceRepository(pool));
    const input = {
      idempotencyKey: 'same-key-concurrently',
      items: [{ productId: 1, quantity: 1 }],
    };

    const [first, second] = await Promise.all([
      firstService.createOrder(input),
      secondService.createOrder(input),
    ]);

    assert.equal(first.id, second.id);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM orders')).rows[0].count, 1);
    assert.equal((await pool.query(
      'SELECT available_quantity FROM inventory WHERE product_id = 1',
    )).rows[0].available_quantity, 19);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count
      FROM order_items oi
      LEFT JOIN orders o ON o.id = oi.order_id
      WHERE o.id IS NULL
    `)).rows[0].count, 0);
  } finally {
    await pool.end();
  }
});
