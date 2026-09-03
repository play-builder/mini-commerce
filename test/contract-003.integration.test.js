import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runner } from 'node-pg-migrate';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_TEST_URL;
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);
const migrationsDirectory = path.resolve(new URL('../migrations', import.meta.url).pathname);

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

function runMigration(url, target, rollbackCandidatesFile) {
  const environment = { ...process.env, ...databaseEnvironment(url) };
  if (rollbackCandidatesFile) {
    const evidence = JSON.parse(fs.readFileSync(rollbackCandidatesFile, 'utf8'));
    environment.ROLLBACK_CANDIDATES_FILE = rollbackCandidatesFile;
    environment.ROLLBACK_EXPECTED_ENVIRONMENT = evidence.environment;
    environment.ROLLBACK_EXPECTED_REGION = evidence.region;
    environment.ROLLBACK_EXPECTED_CLUSTER_ARN = evidence.clusterArn;
    environment.ROLLBACK_EXPECTED_ROLLOUT_NAME = evidence.rolloutName;
    environment.ROLLBACK_EXPECTED_GITOPS_REVISION = evidence.gitopsRevision;
    environment.ROLLBACK_EXPECTED_SOURCE_EVIDENCE_DIGEST = evidence.sourceEvidenceDigest;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/migrate.mjs', '--target', target], {
      cwd: repositoryRoot,
      env: environment,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
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

test('operator target gates 003 only while it is pending and records matching evidence', {
  skip: !databaseUrl,
}, async () => {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const name = `commerce_contract_target_${process.pid}_${Date.now()}`;
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${name}`;
  const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-candidates-'));
  const evidenceFile = path.join(evidenceDirectory, 'valid.json');
  const observedAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(evidenceFile, JSON.stringify({
    schemaVersion: 'course.rollback-candidates/v1',
    evidenceGrade: 'CLOUD_RUNTIME',
    environment: 'prod',
    region: 'ap-northeast-2',
    clusterArn: 'arn:aws:eks:ap-northeast-2:123456789012:cluster/course-prod',
    rolloutName: 'sample-app',
    gitopsRevision: '2'.repeat(40),
    sourceEvidenceDigest: `sha256:${'b'.repeat(64)}`,
    observedAt,
    expiresAt,
    candidates: [{
      imageDigest: `sha256:${'a'.repeat(64)}`,
      productReadContract: 'v2prime',
      rolloutRevision: 3,
      gitRevertSha: '1'.repeat(40),
      podTemplateHash: 'stable-hash',
    }],
  }));
  await adminPool.query(`CREATE DATABASE "${name}"`);
  const pool = new Pool({ connectionString: targetUrl.toString() });
  try {
    const initial = await runMigration(targetUrl, '002_expand_product_display_name');
    assert.equal(initial.code, 0, initial.stderr);

    const missingEvidence = await runMigration(targetUrl, '003_contract_product_name');
    assert.equal(missingEvidence.code, 1);
    assert.match(missingEvidence.stderr, /ROLLBACK_CANDIDATES_FILE_REQUIRED/);
    const before003 = await pool.query('SELECT name FROM pgmigrations ORDER BY id');
    assert.deepEqual(before003.rows, [
      { name: '001_initial_commerce' },
      { name: '002_expand_product_display_name' },
    ]);

    const applied = await runMigration(targetUrl, '003_contract_product_name', evidenceFile);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /applied 1 migration/);
    const gate = await pool.query(`
      SELECT migration_filename, evidence_sha256
      FROM course_migration_contract_gate
    `);
    assert.deepEqual(gate.rows.map(({ migration_filename }) => migration_filename), [
      '003_contract_product_name.js',
    ]);
    assert.match(gate.rows[0].evidence_sha256, /^[0-9a-f]{64}$/);

    const repeated = await runMigration(targetUrl, '003_contract_product_name');
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /applied 0 migration/);
  } finally {
    await pool.end();
    await adminPool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await adminPool.end();
    fs.rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

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
