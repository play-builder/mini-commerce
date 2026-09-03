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
    await migrate(targetUrl, initialDirectory);
    const v1BeforeExpand = createPostgresCommerceRepository(pool, {
      productReadContract: PRODUCT_READ_CONTRACT.V1,
    });
    assert.equal((await v1BeforeExpand.listProducts()).length, 4);

    await migrate(targetUrl, expandDirectory);
    const matrix = [
      [PRODUCT_READ_CONTRACT.V1, '001', true],
      [PRODUCT_READ_CONTRACT.V1, '002', true],
      [PRODUCT_READ_CONTRACT.V2, '002', true],
      [PRODUCT_READ_CONTRACT.V2_PRIME, '002', true],
    ];
    for (const [contract, schema, succeeds] of matrix) {
      const repository = createPostgresCommerceRepository(pool, { productReadContract: contract });
      assert.equal((await repository.listProducts()).length > 0, succeeds, `${contract}+${schema}`);
    }

    await migrate(targetUrl, migrationsDirectory);
    const v2prime = createPostgresCommerceRepository(pool, {
      productReadContract: PRODUCT_READ_CONTRACT.V2_PRIME,
    });
    assert.equal((await v2prime.listProducts()).length, 4);
    const v1AfterContract = createPostgresCommerceRepository(pool, {
      productReadContract: PRODUCT_READ_CONTRACT.V1,
    });
    await assert.rejects(
      v1AfterContract.listProducts(),
      (error) => error.code === '42703',
    );
  } finally {
    fs.rmSync(initialDirectory, { recursive: true, force: true });
    fs.rmSync(expandDirectory, { recursive: true, force: true });
    await pool.end();
  }
}));
