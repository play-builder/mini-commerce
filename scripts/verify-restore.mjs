import { createHash } from 'node:crypto';

const tablePrimaryKeys = Object.freeze({
  products: 'id',
  inventory: 'product_id',
  orders: 'id',
  order_items: 'id',
});

async function readSnapshot(pool) {
  const migration = await pool.query('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
  const rows = [];
  let rowCount = 0;
  for (const [table, primaryKey] of Object.entries(tablePrimaryKeys)) {
    const result = await pool.query(`SELECT * FROM ${table} ORDER BY ${primaryKey}`);
    rowCount += result.rowCount;
    rows.push({ table, rows: result.rows });
  }
  const foreignKeys = await pool.query(`
    SELECT count(*)::int AS count
    FROM order_items oi
    LEFT JOIN orders o ON o.id = oi.order_id
    WHERE o.id IS NULL
  `);
  const duplicates = await pool.query(`
    SELECT count(*)::int AS count
    FROM (
      SELECT idempotency_key
      FROM orders
      GROUP BY idempotency_key
      HAVING count(*) > 1
    ) duplicate_keys
  `);
  const negativeInventory = await pool.query(
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

export async function verifyRestore({ sourcePool, recoveryPool }) {
  if (!sourcePool || !recoveryPool || sourcePool === recoveryPool) {
    throw new Error('independent sourcePool and recoveryPool are required');
  }
  const [source, recovery] = await Promise.all([
    readSnapshot(sourcePool),
    readSnapshot(recoveryPool),
  ]);
  assertInvariants(source, 'source');
  assertInvariants(recovery, 'recovery');
  for (const field of ['schemaVersion', 'rowCount', 'checksum']) {
    if (source[field] !== recovery[field]) {
      throw new Error(`RESTORE_DATA_MISMATCH: ${field}`);
    }
  }
  return recovery;
}
