import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;
const migrationsDirectory = path.resolve(new URL('../migrations', import.meta.url).pathname);

function migrate(database, directory) {
  return runner({
    databaseUrl: database,
    dir: directory,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
  });
}

test('Contract 003은 display_name null row가 있으면 DDL 전에 중단한다', {
  skip: !databaseUrl,
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const name = `commerce_contract_${process.pid}_${Date.now()}`;
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${name}`;
  const expandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-expand-'));
  for (const filename of ['001_initial_commerce.js', '002_expand_product_display_name.js']) {
    fs.copyFileSync(path.join(migrationsDirectory, filename), path.join(expandDirectory, filename));
  }
  await adminPool.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: targetUrl.toString() });
  try {
    await migrate(targetUrl.toString(), expandDirectory);
    await pool.query("INSERT INTO products (sku, name, display_name, price_cents) VALUES ('NULL-NAME', 'Legacy', NULL, 100)");
    await assert.rejects(
      migrate(targetUrl.toString(), migrationsDirectory),
      /CONTRACT_003_NULL_DISPLAY_NAME/,
    );
    const columns = await pool.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'products' AND column_name IN ('name', 'display_name')
      ORDER BY column_name
    `);
    assert.deepEqual(columns.rows, [
      { column_name: 'display_name', is_nullable: 'YES' },
      { column_name: 'name', is_nullable: 'NO' },
    ]);
  } finally {
    await pool.end();
    await adminPool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await adminPool.end();
    fs.rmSync(expandDirectory, { recursive: true, force: true });
  }
});
