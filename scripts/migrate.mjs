#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { runner } from 'node-pg-migrate';

import { config } from '../src/config.js';
import { createDatabasePool } from '../src/database.js';
import { parseMigrationTarget, planPendingMigrations } from '../src/migration-plan.js';
import {
  recordAppliedMigrationLedger,
  recordContract003Gate,
  verifyContract003RollbackCandidates,
  verifyAppliedMigrationLedger,
  withLedgerSerialization,
} from '../src/migration-ledger.js';

if (!config.databaseEnabled) {
  throw new Error('DATABASE_ENABLED=true is required to run migrations');
}

const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const filenames = fs.readdirSync(migrationsDirectory)
  .filter((filename) => /^\d+_.+\.js$/.test(filename))
  .sort();
const target = parseMigrationTarget(process.argv.slice(2), filenames);

const ledgerPool = createDatabasePool(config.database);
try {
  const migrations = await withLedgerSerialization(ledgerPool, async (ledgerClient) => {
    const appliedBefore = await verifyAppliedMigrationLedger(ledgerClient, migrationsDirectory);
    const plan = planPendingMigrations({ filenames, applied: appliedBefore, target });
    const contractEvidence = plan.requiresContract003Evidence
      ? verifyContract003RollbackCandidates(process.env.ROLLBACK_CANDIDATES_FILE, {
          environment: process.env.ROLLBACK_EXPECTED_ENVIRONMENT,
          region: process.env.ROLLBACK_EXPECTED_REGION,
          clusterArn: process.env.ROLLBACK_EXPECTED_CLUSTER_ARN,
          rolloutName: process.env.ROLLBACK_EXPECTED_ROLLOUT_NAME,
          gitopsRevision: process.env.ROLLBACK_EXPECTED_GITOPS_REVISION,
          sourceEvidenceDigest: process.env.ROLLBACK_EXPECTED_SOURCE_EVIDENCE_DIGEST,
        })
      : null;
    if (contractEvidence) await recordContract003Gate(ledgerClient, contractEvidence);
    const applied = plan.count === 0 ? [] : await runner({
      databaseUrl: {
        host: config.database.host,
        port: config.database.port,
        database: config.database.name,
        user: config.database.user,
        password: config.database.password,
        ssl: config.database.ssl ? { rejectUnauthorized: true } : false,
        connectionTimeoutMillis: config.database.connectionTimeoutMs,
        application_name: 'mini-commerce-migration',
      },
      dir: migrationsDirectory,
      direction: 'up',
      count: plan.count,
      migrationsTable: 'pgmigrations',
      checkOrder: true,
      singleTransaction: true,
      advisoryLockMode: 'wait',
    });
    await recordAppliedMigrationLedger(ledgerClient, migrationsDirectory);
    return applied;
  });
  console.log(`applied ${migrations.length} migration(s)`);
} finally {
  await ledgerPool.end();
}
