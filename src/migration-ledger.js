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
