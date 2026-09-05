const contract003Filename = '003_contract_product_name.js';

function normalizeTargetFilename(target) {
  return target.endsWith('.js') ? target : `${target}.js`;
}

export function parseMigrationTarget(argv, filenames) {
  if (argv.length === 0) throw new Error('MIGRATION_TARGET_REQUIRED');
  if (argv.length !== 2 || argv[0] !== '--target' || !argv[1]) {
    throw new Error('MIGRATION_TARGET_ARGUMENTS_INVALID');
  }

  const targetFilename = normalizeTargetFilename(argv[1]);
  if (!filenames.includes(targetFilename)) {
    throw new Error(`UNKNOWN_MIGRATION_TARGET: ${argv[1]}`);
  }
  return targetFilename;
}

export function planPendingMigrations({ filenames, applied, target }) {
  const expectedApplied = filenames.slice(0, applied.length);
  if (applied.length > filenames.length
    || applied.some((filename, index) => filename !== expectedApplied[index])) {
    throw new Error('APPLIED_MIGRATIONS_NOT_ORDERED_PREFIX');
  }

  const targetIndex = filenames.indexOf(target);
  if (targetIndex === -1) throw new Error(`UNKNOWN_MIGRATION_TARGET: ${target}`);
  if (targetIndex < applied.length - 1) {
    throw new Error('MIGRATION_TARGET_BEHIND_APPLIED_PREFIX');
  }

  const pendingFilenames = filenames.slice(applied.length, targetIndex + 1);
  return {
    targetFilename: target,
    pendingFilenames,
    count: pendingFilenames.length,
    requiresContract003Evidence: pendingFilenames.includes(contract003Filename),
  };
}
