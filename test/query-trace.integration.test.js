import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { createPostgresCommerceRepository } from '../src/database.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;
const migrationsDirectory = new URL('../migrations', import.meta.url).pathname;

test('실제 PostgreSQL query가 postgresql.query span을 완료한다', {
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
  const completed = [];
  const tracer = {
    startActiveSpan(name, callback) {
      const span = {
        recordException() {},
        end() { completed.push(name); },
      };
      return callback(span);
    },
  };
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await createPostgresCommerceRepository(pool, { tracer }).listProducts();
    assert.ok(completed.includes('postgresql.query'));
  } finally {
    await pool.end();
  }
});
