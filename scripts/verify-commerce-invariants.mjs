#!/usr/bin/env node

import { config } from '../src/config.js';
import { createDatabasePool } from '../src/database.js';

export async function verifyCommerceInvariants(pool) {
  const queries = {
    orderCount: 'SELECT count(*)::int AS count FROM orders',
    orderItemCount: 'SELECT count(*)::int AS count FROM order_items',
    foreignKeyViolations: `
      SELECT count(*)::int AS count
      FROM order_items oi
      LEFT JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.id IS NULL OR p.id IS NULL
    `,
    duplicateIdempotencyKeys: `
      SELECT count(*)::int AS count
      FROM (
        SELECT idempotency_key
        FROM orders
        GROUP BY idempotency_key
        HAVING count(*) > 1
      ) duplicates
    `,
    negativeInventoryRows: `
      SELECT count(*)::int AS count
      FROM inventory
      WHERE available_quantity < 0
    `,
  };
  const result = {};
  for (const [name, sql] of Object.entries(queries)) {
    const response = await pool.query(sql);
    result[name] = Number(response.rows[0].count);
  }
  const violations = [
    'foreignKeyViolations', 'duplicateIdempotencyKeys', 'negativeInventoryRows',
  ].filter((name) => result[name] !== 0);
  if (violations.length > 0) {
    throw new Error(`commerce invariant violation: ${violations.map((name) => `${name}=${result[name]}`).join(', ')}`);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!config.databaseEnabled) throw new Error('DATABASE_ENABLED=true is required');
  const pool = createDatabasePool(config.database);
  try {
    const result = await verifyCommerceInvariants(pool);
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}
