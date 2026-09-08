import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { createCommerceService, InsufficientStockError, IdempotencyConflictError } from '../../src/commerce-service.js';
import { createDatabasePool, createPostgresCommerceRepository } from '../../src/database.js';
import { createRuntime } from '../../src/runtime.js';
import { createApplication } from '../../src/application.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;

test('PostgreSQL migration과 실제 주문 transaction이 함께 동작한다', {
  skip: !databaseUrl,
}, async () => {
  const migrationsDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../migrations',
  );
  const migrationOptions = {
    databaseUrl,
    dir: migrationsDirectory,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
  };
  const migrationBytes = new Map(['001_initial_commerce.js', '002_expand_product_display_name.js', '003_contract_product_name.js']
    .map((filename) => [filename, fs.readFileSync(path.join(migrationsDirectory, filename))]));

  await runner(migrationOptions);
  await runner(migrationOptions);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('TRUNCATE order_items, orders RESTART IDENTITY');
    await pool.query('UPDATE inventory SET available_quantity = 20');
    const service = createCommerceService(createPostgresCommerceRepository(pool));

    const products = await service.listProducts();
    assert.equal(products.length, 4);
    assert.equal(products[0].sku, 'PB-LAPTOP');

    const first = await service.createOrder({
      idempotencyKey: 'postgres-integration-order',
      items: [{ productId: 1, quantity: 2 }],
    });
    assert.equal(first.totalCents, 259800);
    assert.equal((await service.getInventory(1)).availableQuantity, 18);

    const replay = await service.createOrder({
      idempotencyKey: 'postgres-integration-order',
      items: [{ productId: 1, quantity: 2 }],
    });
    assert.equal(replay.id, first.id);
    assert.equal((await service.getInventory(1)).availableQuantity, 18);

    await assert.rejects(service.createOrder({
      idempotencyKey: 'postgres-integration-order',
      items: [{ productId: 1, quantity: 3 }],
    }), IdempotencyConflictError);
    assert.equal((await service.getInventory(1)).availableQuantity, 18);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM orders')).rows[0].count, 1);

    const app = createApplication({ commerceService: service });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const read = await fetch(`http://127.0.0.1:${server.address().port}/orders/${first.id}`);
      assert.equal(read.status, 200);
      const body = await read.json();
      assert.equal(body.order.id, first.id);
      assert.equal(body.order.totalCents, first.totalCents);
      assert.equal(JSON.stringify(body).includes('postgres-integration-order'), false);

      const missing = await fetch(`http://127.0.0.1:${server.address().port}/orders/999999`);
      assert.equal(missing.status, 404);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }

    await assert.rejects(
      service.createOrder({
        idempotencyKey: 'postgres-insufficient-stock',
        items: [{ productId: 1, quantity: 99 }],
      }),
      InsufficientStockError,
    );
    assert.equal((await service.getInventory(1)).availableQuantity, 18);
    for (const [filename, bytes] of migrationBytes) {
      assert.deepEqual(fs.readFileSync(path.join(migrationsDirectory, filename)), bytes, `${filename} bytes changed`);
    }
  } finally {
    await pool.end();
  }
});


test('real PostgreSQL cancels a slow statement and runtime refuses an absent commerce schema', {
  skip: !databaseUrl,
}, async () => {
  const url = new URL(databaseUrl);
  const limitedPool = createDatabasePool({
    host: url.hostname, port: Number(url.port || 5432), name: url.pathname.slice(1),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false,
    connectionTimeoutMs: 2000, queryTimeoutMs: 2000, statementTimeoutMs: 25,
  });
  try {
    await assert.rejects(limitedPool.query('SELECT pg_sleep(1)'), (error) => error.code === '57014');
    assert.equal((await limitedPool.query('SELECT 1 AS available')).rows[0].available, 1);
  } finally { await limitedPool.end(); }

  // An empty search_path still permits SELECT 1 but cannot satisfy the real app schema.
  const schemaPool = new Pool({ connectionString: databaseUrl, options: '-c search_path=pg_temp' });
  const runtime = createRuntime({
    runtimeConfig: { environment: 'test', databaseEnabled: true, database: {}, publicPort: 0, managementPort: 0 },
    dependencies: { createDatabasePool: () => schemaPool, exit() {} },
  });
  await assert.rejects(runtime.start(), /application startup failed/);
  assert.equal(runtime.readiness.snapshot().ready, false);
});
