import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { createCommerceService } from '../src/commerce-service.js';
import { createPostgresCommerceRepository } from '../src/database.js';
import { createApp } from '../src/routes.js';
import { markReady } from '../src/state.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;

test('DB readiness 실패는 driver 오류를 숨기고 고정된 503 응답을 반환한다', async (t) => {
  markReady();
  const commerceService = {
    async isReady() {
      throw new Error('connection refused');
    },
  };
  const server = createApp({ databaseEnabled: true, commerceService }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: 'not ready',
    reason: 'database unavailable',
  });
});

test('실제 PostgreSQL SELECT 1 성공은 200, pool 종료 후에는 고정된 503을 반환한다', {
  skip: !databaseUrl,
}, async (t) => {
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
  const commerceService = createCommerceService(createPostgresCommerceRepository(pool));
  markReady();
  const server = createApp({ databaseEnabled: true, commerceService }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/readyz`;

  const ready = await fetch(url);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready' });

  await pool.end();
  const unavailable = await fetch(url);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    status: 'not ready',
    reason: 'database unavailable',
  });
});
