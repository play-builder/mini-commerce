#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner } from 'node-pg-migrate';

import { config } from '../src/config.js';
import { createDatabasePool } from '../src/database.js';
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

const ledgerPool = createDatabasePool(config.database);
try {
  const migrations = await withLedgerSerialization(ledgerPool, async (ledgerClient) => {
    const appliedBefore = await verifyAppliedMigrationLedger(ledgerClient, migrationsDirectory);
    const contractEvidence = appliedBefore.includes('003_contract_product_name.js')
      ? null
      : verifyContract003RollbackCandidates(process.env.ROLLBACK_CANDIDATES_FILE);
    const applied = await runner({
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
      migrationsTable: 'pgmigrations',
      checkOrder: true,
      singleTransaction: true,
      advisoryLockMode: 'wait',
    });
    await recordAppliedMigrationLedger(ledgerClient, migrationsDirectory);
    if (!appliedBefore.includes('003_contract_product_name.js')) {
      await recordContract003Gate(ledgerClient, contractEvidence);
    }
    return applied;
  });
  console.log(`applied ${migrations.length} migration(s)`);
} finally {
  await ledgerPool.end();
}
