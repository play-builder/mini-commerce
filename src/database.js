import pg from 'pg';

import { OrderNotFoundError, ProductNotFoundError } from './commerce-service.js';

const { Pool } = pg;

export const PRODUCT_READ_CONTRACT = Object.freeze({
  V1: 'v1',
  V2: 'v2',
  V2_PRIME: 'v2prime',
});

const productNameProjection = Object.freeze({
  [PRODUCT_READ_CONTRACT.V1]: 'p.name AS name',
  [PRODUCT_READ_CONTRACT.V2]: 'COALESCE(p.display_name, p.name) AS name',
  [PRODUCT_READ_CONTRACT.V2_PRIME]: 'p.display_name AS name',
});

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

export function createPostgresCommerceRepository(
  pool,
  { productReadContract = PRODUCT_READ_CONTRACT.V2_PRIME, dependencySignals } = {},
) {
  const nameProjection = productNameProjection[productReadContract];
  if (!nameProjection) throw new Error(`unsupported product read contract: ${productReadContract}`);
  const observeQuery = async (execute) => {
    try {
      const result = await execute();
      dependencySignals?.recordDependencyRecovery();
      return result;
    } catch (error) {
      dependencySignals?.recordDependencyFailure();
      throw error;
    }
  };
  const query = (text, values) => observeQuery(() => pool.query(text, values));
  return {
    async listProducts() {
      const result = await query(`
        SELECT p.id, p.sku, ${nameProjection},
               p.price_cents, i.available_quantity
        FROM products p
        JOIN inventory i ON i.product_id = p.id
        ORDER BY p.id
      `);
      return result.rows.map(mapProduct);
    },

    async getInventory(productId) {
      const result = await query(`
        SELECT p.id, p.sku, ${nameProjection},
               p.price_cents, i.available_quantity
        FROM products p
        JOIN inventory i ON i.product_id = p.id
        WHERE p.id = $1
      `, [productId]);
      if (result.rowCount === 0) throw new ProductNotFoundError(productId);
      return mapInventory(result.rows[0]);
    },

    async getOrder(orderId) {
      const orderResult = await query(`
        SELECT id, status, total_cents, created_at
        FROM orders
        WHERE id = $1
      `, [orderId]);
      if (orderResult.rowCount === 0) throw new OrderNotFoundError(orderId);
      const itemResult = await query(`
        SELECT product_id, sku, product_name, unit_price_cents, quantity
        FROM order_items
        WHERE order_id = $1
        ORDER BY product_id
      `, [orderId]);
      return mapOrder(orderResult.rows[0], itemResult.rows.map((row) => ({
        productId: Number(row.product_id),
        sku: row.sku,
        name: row.product_name,
        unitPriceCents: Number(row.unit_price_cents),
        quantity: Number(row.quantity),
      })));
    },

    async isReady() {
      await query('SELECT 1');
      return true;
    },

    async withTransaction(callback) {
      const client = await observeQuery(() => pool.connect());
      try {
        const transactionQuery = (text, values) => observeQuery(() => client.query(text, values));
        await transactionQuery('BEGIN');
        const transaction = {
          async advisoryLock(idempotencyKey) {
            await transactionQuery('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);
          },

          async findOrderByIdempotencyKey(idempotencyKey) {
            const orderResult = await transactionQuery(`
              SELECT id, status, total_cents, created_at
              FROM orders
              WHERE idempotency_key = $1
            `, [idempotencyKey]);
            if (orderResult.rowCount === 0) return null;

            const orderId = orderResult.rows[0].id;
            const itemResult = await transactionQuery(`
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
            const result = await transactionQuery(`
              SELECT p.id, p.sku, ${nameProjection},
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
            const result = await transactionQuery(`
              INSERT INTO orders (idempotency_key, status, total_cents)
              VALUES ($1, $2, $3)
              RETURNING id, status, total_cents, created_at
            `, [idempotencyKey, status, totalCents]);
            return mapOrder(result.rows[0]);
          },

          async insertOrderItem(item) {
            await transactionQuery(`
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
            await transactionQuery(`
              UPDATE inventory
              SET available_quantity = available_quantity - $2,
                  updated_at = CURRENT_TIMESTAMP
              WHERE product_id = $1
            `, [productId, quantity]);
          },
        };

        const result = await callback(transaction);
        await transactionQuery('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The original business operation error remains the stable boundary.
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
