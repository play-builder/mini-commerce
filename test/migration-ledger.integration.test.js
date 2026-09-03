import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import pg from 'pg';

import { verifyAppliedMigrationLedger } from '../src/migration-ledger.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);
const migrationsDirectory = path.join(repositoryRoot, 'migrations');

function databaseEnvironment(url) {
  return {
    DATABASE_ENABLED: 'true',
    DB_HOST: url.hostname,
    DB_PORT: url.port || '5432',
    DB_NAME: url.pathname.slice(1),
    DB_USER: decodeURIComponent(url.username),
    DB_PASSWORD: decodeURIComponent(url.password),
    DB_SSL: 'false',
  };
}

function runMigration(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/migrate.mjs'], {
      cwd: repositoryRoot,
      env: { ...process.env, ...databaseEnvironment(url) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withTemporaryDatabase(operation) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const name = `commerce_ledger_${process.pid}_${Date.now()}`;
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${name}`;
  await adminPool.query(`CREATE DATABASE "${name}"`);
  try {
    return await operation(targetUrl);
  } finally {
    await adminPool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await adminPool.end();
  }
}

test('동시 migration을 직렬화하고 적용된 source checksum 변경을 거부한다', {
  skip: !databaseUrl,
}, async () => withTemporaryDatabase(async (targetUrl) => {
  const results = await Promise.all([runMigration(targetUrl), runMigration(targetUrl)]);
  assert.deepEqual(results.map(({ code }) => code), [0, 0], results.map((item) => item.stderr).join('\n'));
  assert.deepEqual(results.map(({ stdout }) => Number(stdout.match(/applied (\d+) migration/)?.[1])).sort(), [0, 3]);

  const pool = new Pool({ connectionString: targetUrl.toString() });
  const copiedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-migrations-'));
  try {
    const ledger = await pool.query('SELECT filename, sha256 FROM course_migration_ledger ORDER BY filename');
    assert.deepEqual(ledger.rows.map(({ filename }) => filename), [
      '001_initial_commerce.js',
      '002_expand_product_display_name.js',
      '003_contract_product_name.js',
    ]);
    assert.ok(ledger.rows.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256)));

    const locks = await pool.query(`
      SELECT count(*)::int AS count
      FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      WHERE c.relname = 'course_migration_ledger_control'
    `);
    assert.equal(locks.rows[0].count, 0);

    for (const filename of [
      '001_initial_commerce.js',
      '002_expand_product_display_name.js',
      '003_contract_product_name.js',
    ]) {
      fs.copyFileSync(path.join(migrationsDirectory, filename), path.join(copiedDirectory, filename));
    }
    fs.appendFileSync(path.join(copiedDirectory, '002_expand_product_display_name.js'), '\n// altered\n');
    const client = await pool.connect();
    try {
      await assert.rejects(
        verifyAppliedMigrationLedger(client, copiedDirectory),
        /APPLIED_MIGRATION_CHECKSUM_MISMATCH/,
      );
    } finally {
      client.release();
    }
  } finally {
    fs.rmSync(copiedDirectory, { recursive: true, force: true });
    await pool.end();
  }
}));
