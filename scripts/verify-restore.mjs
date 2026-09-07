import { createHash } from 'node:crypto';

const tablePrimaryKeys = Object.freeze({
  products: 'id',
  inventory: 'product_id',
  orders: 'id',
  order_items: 'id',
});

async function readSnapshot(client) {
  const migration = await client.query('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
  const rows = [];
  let rowCount = 0;
  for (const [table, primaryKey] of Object.entries(tablePrimaryKeys)) {
    const result = await client.query(`SELECT * FROM ${table} ORDER BY ${primaryKey}`);
    rowCount += result.rowCount;
    rows.push({ table, rows: result.rows });
  }
  const foreignKeys = await client.query(`
    SELECT count(*)::int AS count
    FROM order_items oi
    LEFT JOIN orders o ON o.id = oi.order_id
    WHERE o.id IS NULL
  `);
  const duplicates = await client.query(`
    SELECT count(*)::int AS count
    FROM (
      SELECT idempotency_key
      FROM orders
      GROUP BY idempotency_key
      HAVING count(*) > 1
    ) duplicate_keys
  `);
  const negativeInventory = await client.query(
    'SELECT count(*)::int AS count FROM inventory WHERE available_quantity < 0',
  );
  return {
    schemaVersion: migration.rows[0]?.name ?? null,
    rowCount,
    checksum: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    foreignKeyViolations: foreignKeys.rows[0].count,
    duplicateIdempotencyKeys: duplicates.rows[0].count,
    negativeInventoryRows: negativeInventory.rows[0].count,
  };
}

function assertInvariants(snapshot, label) {
  for (const field of [
    'foreignKeyViolations',
    'duplicateIdempotencyKeys',
    'negativeInventoryRows',
  ]) {
    if (snapshot[field] !== 0) throw new Error(`${label} ${field}=${snapshot[field]}`);
  }
}

async function captureConsistentSnapshot(pool) {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const identity = await client.query(`
      SELECT current_database() AS database, inet_server_addr()::text AS host, inet_server_port() AS port
    `);
    if (!identity.rows[0]?.database) throw new Error('RESTORE_DATABASE_IDENTITY_REQUIRED');
    const snapshot = await readSnapshot(client);
    if (!snapshot.schemaVersion) throw new Error('RESTORE_SCHEMA_VERSION_REQUIRED');
    await client.query('COMMIT');
    return { identity: identity.rows[0], snapshot };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

export async function verifyRestore({ sourcePool, recoveryPool }) {
  if (!sourcePool || !recoveryPool || sourcePool === recoveryPool) {
    throw new Error('independent sourcePool and recoveryPool are required');
  }
  // Wait for both captures to clean up before the caller can close its pools.
  const captures = await Promise.allSettled([
    captureConsistentSnapshot(sourcePool),
    captureConsistentSnapshot(recoveryPool),
  ]);
  const failed = captures.find((capture) => capture.status === 'rejected');
  if (failed) throw failed.reason;
  const [sourceCapture, recoveryCapture] = captures.map((capture) => capture.value);
  if (JSON.stringify(sourceCapture.identity) === JSON.stringify(recoveryCapture.identity)) {
    throw new Error('RESTORE_DATABASES_MUST_DIFFER: source and recovery resolve to the same database endpoint');
  }
  const source = sourceCapture.snapshot;
  const recovery = recoveryCapture.snapshot;
  assertInvariants(source, 'source');
  assertInvariants(recovery, 'recovery');
  for (const field of ['schemaVersion', 'rowCount', 'checksum']) {
    if (source[field] !== recovery[field]) {
      throw new Error(`RESTORE_DATA_MISMATCH: ${field}`);
    }
  }
  return recovery;
}
