import pg from 'pg';

import { ProductNotFoundError } from './commerce-service.js';

const { Pool } = pg;

function mapProduct(row) {
  return {
    id: Number(row.id),
    sku: row.sku,
    name: row.name,
    priceCents: Number(row.price_cents),
    availableQuantity: Number(row.available_quantity),
  };
}

function mapInventory(row) {
  const product = mapProduct(row);
  return {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    priceCents: product.priceCents,
    availableQuantity: product.availableQuantity,
  };
}

function mapOrder(row, items = []) {
  return {
    id: Number(row.id),
    status: row.status,
    totalCents: Number(row.total_cents),
    createdAt: row.created_at,
    items,
  };
}

export function createDatabasePool(databaseConfig) {
  return new Pool({
    host: databaseConfig.host,
    port: databaseConfig.port,
    database: databaseConfig.name,
    user: databaseConfig.user,
    password: databaseConfig.password,
    ssl: databaseConfig.ssl ? { rejectUnauthorized: true } : false,
    max: 10,
    connectionTimeoutMillis: databaseConfig.connectionTimeoutMs,
    query_timeout: databaseConfig.queryTimeoutMs,
    application_name: 'mini-commerce',
  });
}

export function createPostgresCommerceRepository(pool) {
  return {
    async listProducts() {
      const result = await pool.query(`
        SELECT p.id, p.sku, COALESCE(p.display_name, p.name) AS name,
               p.price_cents, i.available_quantity
        FROM products p
        JOIN inventory i ON i.product_id = p.id
        ORDER BY p.id
      `);
      return result.rows.map(mapProduct);
    },

    async getInventory(productId) {
      const result = await pool.query(`
        SELECT p.id, p.sku, COALESCE(p.display_name, p.name) AS name,
               p.price_cents, i.available_quantity
        FROM products p
        JOIN inventory i ON i.product_id = p.id
        WHERE p.id = $1
      `, [productId]);
      if (result.rowCount === 0) throw new ProductNotFoundError(productId);
      return mapInventory(result.rows[0]);
    },

    async isReady() {
      await pool.query('SELECT 1');
      return true;
    },

    async withTransaction(callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const transaction = {
          async advisoryLock(idempotencyKey) {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);
          },

          async findOrderByIdempotencyKey(idempotencyKey) {
            const orderResult = await client.query(`
              SELECT id, status, total_cents, created_at
              FROM orders
              WHERE idempotency_key = $1
            `, [idempotencyKey]);
            if (orderResult.rowCount === 0) return null;

            const orderId = orderResult.rows[0].id;
            const itemResult = await client.query(`
              SELECT product_id, sku, product_name, unit_price_cents, quantity
              FROM order_items
              WHERE order_id = $1
              ORDER BY product_id
            `, [orderId]);
            const items = itemResult.rows.map((row) => ({
              productId: Number(row.product_id),
              sku: row.sku,
              name: row.product_name,
              unitPriceCents: Number(row.unit_price_cents),
              quantity: Number(row.quantity),
            }));
            return mapOrder(orderResult.rows[0], items);
          },

          async lockInventory(productIds) {
            const result = await client.query(`
              SELECT p.id, p.sku, COALESCE(p.display_name, p.name) AS name,
                     p.price_cents, i.available_quantity
              FROM products p
              JOIN inventory i ON i.product_id = p.id
              WHERE p.id = ANY($1::bigint[])
              ORDER BY p.id
              FOR UPDATE OF i
            `, [productIds]);
            return result.rows.map(mapInventory);
          },

          async insertOrder({ idempotencyKey, status, totalCents }) {
            const result = await client.query(`
              INSERT INTO orders (idempotency_key, status, total_cents)
              VALUES ($1, $2, $3)
              RETURNING id, status, total_cents, created_at
            `, [idempotencyKey, status, totalCents]);
            return mapOrder(result.rows[0]);
          },

          async insertOrderItem(item) {
            await client.query(`
              INSERT INTO order_items
                (order_id, product_id, sku, product_name, unit_price_cents, quantity)
              VALUES ($1, $2, $3, $4, $5, $6)
            `, [
              item.orderId,
              item.productId,
              item.sku,
              item.name,
              item.unitPriceCents,
              item.quantity,
            ]);
          },

          async decrementInventory(productId, quantity) {
            await client.query(`
              UPDATE inventory
              SET available_quantity = available_quantity - $2,
                  updated_at = CURRENT_TIMESTAMP
              WHERE product_id = $1
            `, [productId, quantity]);
          },
        };

        const result = await callback(transaction);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
