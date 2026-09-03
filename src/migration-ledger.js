import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

async function ensureMigrationLedger(client) {
  const bootstrap = () => client.query(`
      CREATE TABLE IF NOT EXISTS course_migration_ledger (
        filename text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS course_migration_ledger_control (
        id smallint PRIMARY KEY CHECK (id = 1)
      );
      CREATE TABLE IF NOT EXISTS course_migration_contract_gate (
        migration_filename text PRIMARY KEY,
        evidence_sha256 text NOT NULL,
        evidence_source text NOT NULL,
        verified_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO course_migration_ledger_control (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);
  try {
    await bootstrap();
  } catch (error) {
    if (error.code !== '23505') throw error;
    await bootstrap();
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) throw new Error(`unexpected ${label} key ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`missing ${label} key ${key}`);
  }
}

function isNonblankString(value) {
  return typeof value === 'string' && value.trim().length > 0
    && !/[\uD800-\uDFFF]/u.test(value);
}

function verifyContract003RollbackCandidateSource(source, { expected, now = new Date() } = {}) {
  const evidence = JSON.parse(source);
  assertExactKeys(evidence, [
    'schemaVersion', 'evidenceGrade', 'environment', 'region', 'clusterArn', 'rolloutName',
    'gitopsRevision', 'sourceEvidenceDigest', 'observedAt', 'expiresAt', 'candidates',
  ], 'rollback candidate evidence');
  if (evidence.schemaVersion !== 'course.rollback-candidates/v1') {
    throw new Error('ROLLBACK_CANDIDATES_SCHEMA_UNSUPPORTED');
  }
  if (evidence.evidenceGrade !== 'CLOUD_RUNTIME') throw new Error('ROLLBACK_CANDIDATES_MUST_BE_CLOUD_RUNTIME');
  if (!['dev', 'prod'].includes(evidence.environment)) throw new Error('ROLLBACK_CANDIDATE_ENVIRONMENT_INVALID');
  if (!['ap-northeast-2', 'us-east-1'].includes(evidence.region)) throw new Error('ROLLBACK_CANDIDATE_REGION_INVALID');
  if (!new RegExp(
    `^arn:aws:eks:${evidence.region}:\\d{12}:cluster/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`,
  ).test(evidence.clusterArn)) {
    throw new Error('ROLLBACK_CANDIDATE_CLUSTER_ARN_INVALID');
  }
  if (!isNonblankString(evidence.rolloutName)
    || !/^[0-9a-f]{40}$/.test(evidence.gitopsRevision)
    || !/^sha256:[0-9a-f]{64}$/.test(evidence.sourceEvidenceDigest)) {
    throw new Error('ROLLBACK_CANDIDATE_IDENTITY_INVALID');
  }
  const observedAt = new Date(evidence.observedAt);
  const expiresAt = new Date(evidence.expiresAt);
  if (Number.isNaN(observedAt.valueOf()) || Number.isNaN(expiresAt.valueOf()) || expiresAt <= observedAt) {
    throw new Error('ROLLBACK_CANDIDATE_EVIDENCE_LIFETIME_INVALID');
  }
  if (expected) {
    if (observedAt > now) throw new Error('ROLLBACK_CANDIDATE_EVIDENCE_FUTURE');
    if (expiresAt <= now) throw new Error('ROLLBACK_CANDIDATE_EVIDENCE_EXPIRED');
    for (const [key, label] of [
      ['environment', 'ENVIRONMENT'],
      ['region', 'REGION'],
      ['clusterArn', 'CLUSTER_ARN'],
      ['rolloutName', 'ROLLOUT_NAME'],
      ['gitopsRevision', 'GITOPS_REVISION'],
      ['sourceEvidenceDigest', 'SOURCE_EVIDENCE_DIGEST'],
    ]) {
      if (!isNonblankString(expected[key])) {
        throw new Error(`ROLLBACK_EXPECTED_${label}_REQUIRED`);
      }
      if (evidence[key] !== expected[key]) throw new Error(`ROLLBACK_EVIDENCE_${label}_MISMATCH`);
    }
  }
  if (!Array.isArray(evidence.candidates) || evidence.candidates.length === 0) {
    throw new Error('CONTRACT_003_RETAINED_CANDIDATES_REQUIRED');
  }
  for (const candidate of evidence.candidates) {
    assertExactKeys(candidate, [
      'imageDigest', 'productReadContract', 'rolloutRevision', 'gitRevertSha', 'podTemplateHash',
    ], 'rollback candidate');
    if (candidate.productReadContract !== 'v2prime') {
      throw new Error('CONTRACT_003_RETAINED_CANDIDATE_INCOMPATIBLE');
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(candidate.imageDigest)
      || !Number.isSafeInteger(candidate.rolloutRevision)
      || candidate.rolloutRevision < 1
      || !/^[0-9a-f]{40}$/.test(candidate.gitRevertSha)
      || !isNonblankString(candidate.podTemplateHash)) {
      throw new Error('CONTRACT_003_RETAINED_CANDIDATE_INVALID');
    }
  }
  return {
    sha256: createHash('sha256').update(source).digest('hex'),
    source,
  };
}

export function verifyContract003RollbackCandidates(evidenceFile, expected, now = new Date()) {
  if (typeof evidenceFile !== 'string' || evidenceFile.length === 0) {
    throw new Error('ROLLBACK_CANDIDATES_FILE_REQUIRED');
  }
  return verifyContract003RollbackCandidateSource(
    fs.readFileSync(evidenceFile, 'utf8'),
    { expected, now },
  );
}

export async function recordContract003Gate(client, evidence) {
  const filename = '003_contract_product_name.js';
  const existing = await client.query(
    'SELECT evidence_sha256 FROM course_migration_contract_gate WHERE migration_filename = $1',
    [filename],
  );
  if (existing.rowCount === 1 && existing.rows[0].evidence_sha256 !== evidence.sha256) {
    throw new Error('CONTRACT_003_GATE_EVIDENCE_MISMATCH');
  }
  if (existing.rowCount === 0) {
    await client.query(
      `INSERT INTO course_migration_contract_gate
        (migration_filename, evidence_sha256, evidence_source)
       VALUES ($1, $2, $3)`,
      [filename, evidence.sha256, evidence.source],
    );
  }
}

function readMigrationSources(migrationDirectory) {
  return new Map(fs.readdirSync(migrationDirectory)
    .filter((filename) => /^\d+_.+\.js$/.test(filename))
    .sort()
    .map((filename) => {
      const source = fs.readFileSync(path.join(migrationDirectory, filename), 'utf8');
      const sha256 = createHash('sha256').update(source).digest('hex');
      return [filename, sha256];
    }));
}

async function readAppliedMigrations(client) {
  const table = await client.query("SELECT to_regclass('pgmigrations') AS table_name");
  if (!table.rows[0].table_name) return [];
  const result = await client.query('SELECT name FROM pgmigrations ORDER BY id');
  return result.rows.map(({ name }) => `${name}.js`);
}

export async function verifyAppliedMigrationLedger(client, migrationDirectory) {
  await ensureMigrationLedger(client);
  const sources = readMigrationSources(migrationDirectory);
  const applied = await readAppliedMigrations(client);
  const ledger = await client.query('SELECT filename, sha256 FROM course_migration_ledger');
  const recorded = new Map(ledger.rows.map(({ filename, sha256 }) => [filename, sha256]));

  for (const filename of applied) {
    const sourceSha256 = sources.get(filename);
    if (!sourceSha256) throw new Error(`APPLIED_MIGRATION_SOURCE_MISSING: ${filename}`);
    if (recorded.has(filename) && recorded.get(filename) !== sourceSha256) {
      throw new Error(`APPLIED_MIGRATION_CHECKSUM_MISMATCH: ${filename}`);
    }
  }
  if (applied.includes('003_contract_product_name.js')) {
    const gate = await client.query(`
      SELECT evidence_sha256, evidence_source
      FROM course_migration_contract_gate
      WHERE migration_filename = '003_contract_product_name.js'
    `);
    if (gate.rowCount !== 1) throw new Error('CONTRACT_003_GATE_EVIDENCE_MISSING');
    let verified;
    try {
      verified = verifyContract003RollbackCandidateSource(gate.rows[0].evidence_source);
    } catch {
      throw new Error('CONTRACT_003_GATE_EVIDENCE_CORRUPT');
    }
    if (verified.sha256 !== gate.rows[0].evidence_sha256) {
      throw new Error('CONTRACT_003_GATE_EVIDENCE_CORRUPT');
    }
  }
  return applied;
}

export async function recordAppliedMigrationLedger(client, migrationDirectory) {
  await ensureMigrationLedger(client);
  const sources = readMigrationSources(migrationDirectory);
  const applied = await readAppliedMigrations(client);

  for (const filename of applied) {
    const sourceSha256 = sources.get(filename);
    if (!sourceSha256) throw new Error(`APPLIED_MIGRATION_SOURCE_MISSING: ${filename}`);
    const existing = await client.query(
      'SELECT sha256 FROM course_migration_ledger WHERE filename = $1',
      [filename],
    );
    if (existing.rowCount === 1 && existing.rows[0].sha256 !== sourceSha256) {
      throw new Error(`APPLIED_MIGRATION_CHECKSUM_MISMATCH: ${filename}`);
    }
    if (existing.rowCount === 0) {
      await client.query(
        'INSERT INTO course_migration_ledger (filename, sha256) VALUES ($1, $2)',
        [filename, sourceSha256],
      );
    }
  }
  return applied;
}

export async function withLedgerSerialization(pool, operation) {
  const client = await pool.connect();
  try {
    await ensureMigrationLedger(client);
    await client.query('BEGIN');
    await client.query('SELECT id FROM course_migration_ledger_control WHERE id = 1 FOR UPDATE');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
