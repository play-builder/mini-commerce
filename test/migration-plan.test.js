import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMigrationTarget, planPendingMigrations } from '../src/migration-plan.js';

const filenames = [
  '001_initial_commerce.js',
  '002_expand_product_display_name.js',
  '003_contract_product_name.js',
];

function plan(argv, applied = []) {
  return planPendingMigrations({
    filenames,
    applied,
    target: parseMigrationTarget(argv, filenames),
  });
}

test('--target 001_initial_commerce resolves one pending migration on a clean database', () => {
  assert.deepEqual(plan(['--target', '001_initial_commerce']), {
    targetFilename: '001_initial_commerce.js',
    pendingFilenames: ['001_initial_commerce.js'],
    count: 1,
    requiresContract003Evidence: false,
  });
});

test('--target 002_expand_product_display_name resolves two pending migrations on a clean database', () => {
  assert.deepEqual(plan(['--target', '002_expand_product_display_name.js']), {
    targetFilename: '002_expand_product_display_name.js',
    pendingFilenames: [
      '001_initial_commerce.js',
      '002_expand_product_display_name.js',
    ],
    count: 2,
    requiresContract003Evidence: false,
  });
});

test('target 002 with 001 already applied resolves one pending migration', () => {
  assert.deepEqual(plan(['--target', '002_expand_product_display_name'], [
    '001_initial_commerce.js',
  ]), {
    targetFilename: '002_expand_product_display_name.js',
    pendingFilenames: ['002_expand_product_display_name.js'],
    count: 1,
    requiresContract003Evidence: false,
  });
});

test('target 003 with 001 and 002 applied resolves one migration and requires evidence', () => {
  assert.deepEqual(plan(['--target', '003_contract_product_name'], [
    '001_initial_commerce.js',
    '002_expand_product_display_name.js',
  ]), {
    targetFilename: '003_contract_product_name.js',
    pendingFilenames: ['003_contract_product_name.js'],
    count: 1,
    requiresContract003Evidence: true,
  });
});

test('target 002 never requires Contract 003 evidence', () => {
  assert.equal(plan(['--target', '002_expand_product_display_name']).requiresContract003Evidence, false);
});

test('an unknown target is rejected', () => {
  assert.throws(
    () => parseMigrationTarget(['--target', '999_unknown'], filenames),
    /UNKNOWN_MIGRATION_TARGET/,
  );
});

test('a target behind the applied prefix is rejected', () => {
  assert.throws(
    () => plan(['--target', '001_initial_commerce'], [
      '001_initial_commerce.js',
      '002_expand_product_display_name.js',
    ]),
    /MIGRATION_TARGET_BEHIND_APPLIED_PREFIX/,
  );
});

test('an applied list that is not an ordered prefix is rejected', () => {
  assert.throws(
    () => plan(['--target', '003_contract_product_name'], [
      '001_initial_commerce.js',
      '003_contract_product_name.js',
    ]),
    /APPLIED_MIGRATIONS_NOT_ORDERED_PREFIX/,
  );
});

test('missing --target is rejected instead of planning all migrations', () => {
  assert.throws(
    () => parseMigrationTarget([], filenames),
    /MIGRATION_TARGET_REQUIRED/,
  );
});

test('duplicate and unknown arguments are rejected', () => {
  assert.throws(
    () => parseMigrationTarget(['--target', '001_initial_commerce', '--target', '002_expand_product_display_name'], filenames),
    /MIGRATION_TARGET_ARGUMENTS_INVALID/,
  );
  assert.throws(
    () => parseMigrationTarget(['--target', '001_initial_commerce', '--dry-run'], filenames),
    /MIGRATION_TARGET_ARGUMENTS_INVALID/,
  );
});
