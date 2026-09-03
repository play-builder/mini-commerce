import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { createPostgresCommerceRepository, PRODUCT_READ_CONTRACT } from '../src/database.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;
const migrationsDirectory = path.resolve(new URL('../migrations', import.meta.url).pathname);

async function withTemporaryDatabase(operation) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const name = `commerce_compat_${process.pid}_${Date.now()}`;
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${name}`;
  await adminPool.query(`CREATE DATABASE "${name}"`);
  try {
    return await operation(targetUrl.toString());
  } finally {
    await adminPool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await adminPool.end();
  }
}

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

test('v1, v2, v2prime query contract가 실제 schema 전환 경계에서 동작한다', {
  skip: !databaseUrl,
}, async () => withTemporaryDatabase(async (targetUrl) => {
  assert.equal(PRODUCT_READ_CONTRACT.V2, 'v2');
  const initialDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-initial-'));
  const expandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-expand-'));
  fs.copyFileSync(
    path.join(migrationsDirectory, '001_initial_commerce.js'),
    path.join(initialDirectory, '001_initial_commerce.js'),
  );
  for (const filename of ['001_initial_commerce.js', '002_expand_product_display_name.js']) {
    fs.copyFileSync(path.join(migrationsDirectory, filename), path.join(expandDirectory, filename));
  }
  const pool = new Pool({ connectionString: targetUrl });
  try {
    const observed = [];
    const assertCompatibility = async ({ contract, schema, succeeds }) => {
      const repository = createPostgresCommerceRepository(pool, { productReadContract: contract });
      if (succeeds) {
        assert.equal((await repository.listProducts()).length, 4, `${contract}+${schema}`);
      } else {
        await assert.rejects(repository.listProducts(), (error) => error.code === '42703');
      }
      observed.push([contract, schema, succeeds]);
    };

    await migrate(targetUrl, initialDirectory);
    await assertCompatibility({ contract: PRODUCT_READ_CONTRACT.V1, schema: '001', succeeds: true });

    await migrate(targetUrl, expandDirectory);
    await assertCompatibility({ contract: PRODUCT_READ_CONTRACT.V1, schema: '002', succeeds: true });
    await assertCompatibility({ contract: PRODUCT_READ_CONTRACT.V2, schema: '002', succeeds: true });
    await assertCompatibility({ contract: PRODUCT_READ_CONTRACT.V2_PRIME, schema: '002', succeeds: true });

    await migrate(targetUrl, migrationsDirectory);
    await assertCompatibility({ contract: PRODUCT_READ_CONTRACT.V2_PRIME, schema: '003', succeeds: true });
    await assertCompatibility({ contract: PRODUCT_READ_CONTRACT.V1, schema: '003', succeeds: false });
    assert.deepEqual(observed, [
      ['v1', '001', true],
      ['v1', '002', true],
      ['v2', '002', true],
      ['v2prime', '002', true],
      ['v2prime', '003', true],
      ['v1', '003', false],
    ]);
  } finally {
    fs.rmSync(initialDirectory, { recursive: true, force: true });
    fs.rmSync(expandDirectory, { recursive: true, force: true });
    await pool.end();
  }
}));
