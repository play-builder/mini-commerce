import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runner } from 'node-pg-migrate';
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

function runMigration(url, rollbackCandidatesFile, expectedOverrides = {}) {
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
    Object.assign(environment, expectedOverrides);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/migrate.mjs'], {
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
  const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-candidates-'));
  const validCandidatesFile = path.join(evidenceDirectory, 'valid.json');
  const invalidCandidatesFile = path.join(evidenceDirectory, 'invalid.json');
  const candidate = {
    imageDigest: `sha256:${'a'.repeat(64)}`,
    productReadContract: 'v2prime',
    rolloutRevision: 3,
    gitRevertSha: '1'.repeat(40),
    podTemplateHash: 'stable-hash',
  };
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const validEvidence = {
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
    candidates: [candidate],
  };
  fs.writeFileSync(validCandidatesFile, JSON.stringify(validEvidence));
  fs.writeFileSync(invalidCandidatesFile, JSON.stringify({
    ...validEvidence,
    candidates: [{ ...candidate, productReadContract: 'v2' }],
  }));

  const expandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-expand-'));
  for (const filename of ['001_initial_commerce.js', '002_expand_product_display_name.js']) {
    fs.copyFileSync(path.join(migrationsDirectory, filename), path.join(expandDirectory, filename));
  }
  await runner({
    databaseUrl: targetUrl.toString(),
    dir: expandDirectory,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
  });

  const rejected = await runMigration(targetUrl, invalidCandidatesFile);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /CONTRACT_003_RETAINED_CANDIDATE_INCOMPATIBLE/);

  const staleCandidatesFile = path.join(evidenceDirectory, 'stale.json');
  fs.writeFileSync(staleCandidatesFile, JSON.stringify({
    ...validEvidence,
    observedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-01T01:00:00Z',
  }));
  const stale = await runMigration(targetUrl, staleCandidatesFile);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /ROLLBACK_CANDIDATE_EVIDENCE_EXPIRED/);

  const wrongCurrentRevision = await runMigration(targetUrl, validCandidatesFile, {
    ROLLBACK_EXPECTED_GITOPS_REVISION: 'f'.repeat(40),
  });
  assert.equal(wrongCurrentRevision.code, 1);
  assert.match(wrongCurrentRevision.stderr, /ROLLBACK_EVIDENCE_GITOPS_REVISION_MISMATCH/);

  const preflightPool = new Pool({ connectionString: targetUrl.toString() });
  await preflightPool.query(`
    INSERT INTO course_migration_contract_gate
      (migration_filename, evidence_sha256, evidence_source)
    VALUES ('003_contract_product_name.js', $1, '{}')
  `, ['0'.repeat(64)]);
  const mismatchedGate = await runMigration(targetUrl, validCandidatesFile);
  assert.equal(mismatchedGate.code, 1);
  assert.match(mismatchedGate.stderr, /CONTRACT_003_GATE_EVIDENCE_MISMATCH/);
  const contractColumns = await preflightPool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'products' AND column_name IN ('name', 'display_name')
    ORDER BY column_name
  `);
  await preflightPool.query(`
    DELETE FROM course_migration_contract_gate
    WHERE migration_filename = '003_contract_product_name.js'
  `);
  await preflightPool.end();
  assert.deepEqual(contractColumns.rows, [
    { column_name: 'display_name' },
    { column_name: 'name' },
  ]);

  const results = await Promise.all([
    runMigration(targetUrl, validCandidatesFile),
    runMigration(targetUrl, validCandidatesFile),
  ]);
  assert.deepEqual(results.map(({ code }) => code), [0, 0], results.map((item) => item.stderr).join('\n'));
  assert.deepEqual(results.map(({ stdout }) => Number(stdout.match(/applied (\d+) migration/)?.[1])).sort(), [0, 1]);

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
    const contractGate = await pool.query(`
      SELECT migration_filename, evidence_sha256
      FROM course_migration_contract_gate
    `);
    assert.deepEqual(contractGate.rows.map(({ migration_filename }) => migration_filename), [
      '003_contract_product_name.js',
    ]);
    assert.match(contractGate.rows[0].evidence_sha256, /^[0-9a-f]{64}$/);

    const rerunWithoutExternalEvidence = await runMigration(targetUrl);
    assert.equal(rerunWithoutExternalEvidence.code, 0, rerunWithoutExternalEvidence.stderr);
    assert.match(rerunWithoutExternalEvidence.stdout, /applied 0 migration/);

    await pool.query(`
      UPDATE course_migration_contract_gate
      SET evidence_sha256 = $1
      WHERE migration_filename = '003_contract_product_name.js'
    `, ['0'.repeat(64)]);
    const corruptedGate = await runMigration(targetUrl);
    assert.equal(corruptedGate.code, 1);
    assert.match(corruptedGate.stderr, /CONTRACT_003_GATE_EVIDENCE_CORRUPT/);

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
    fs.rmSync(evidenceDirectory, { recursive: true, force: true });
    fs.rmSync(expandDirectory, { recursive: true, force: true });
    await pool.end();
  }
}));
