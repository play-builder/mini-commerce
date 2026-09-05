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
  {
    productReadContract = PRODUCT_READ_CONTRACT.V2_PRIME,
    dependencySignals,
    now = Date.now,
  } = {},
) {
  const nameProjection = productNameProjection[productReadContract];
  if (!nameProjection) throw new Error(`unsupported product read contract: ${productReadContract}`);
  const observeOperation = async (operation, execute) => {
    const startedAt = now();
    let databaseFailed = false;
    let failureReason = 'query_failed';
    const databaseCall = async (call, reason = 'query_failed') => {
      try {
        return await call();
      } catch (error) {
        databaseFailed = true;
        failureReason = reason;
        throw error;
      }
    };
    try {
      const result = await execute(databaseCall);
      dependencySignals?.recordOperationRecovery?.();
      return result;
    } catch (error) {
      if (databaseFailed) {
        const durationMs = Math.min(300000, Math.max(0, Math.round(now() - startedAt)));
        dependencySignals?.recordOperationFailure?.({
          operation, reason: failureReason, durationMs,
        });
      } else {
        dependencySignals?.recordOperationRecovery?.();
      }
      throw error;
    }
  };
  return {
    async listProducts() {
      return observeOperation('list_products', async (databaseCall) => {
        const result = await databaseCall(() => pool.query(`
          SELECT p.id, p.sku, ${nameProjection},
                 p.price_cents, i.available_quantity
          FROM products p
          JOIN inventory i ON i.product_id = p.id
          ORDER BY p.id
        `));
        return result.rows.map(mapProduct);
      });
    },

    async getInventory(productId) {
      return observeOperation('get_inventory', async (databaseCall) => {
        const result = await databaseCall(() => pool.query(`
          SELECT p.id, p.sku, ${nameProjection},
                 p.price_cents, i.available_quantity
          FROM products p
          JOIN inventory i ON i.product_id = p.id
          WHERE p.id = $1
        `, [productId]));
        if (result.rowCount === 0) throw new ProductNotFoundError(productId);
        return mapInventory(result.rows[0]);
      });
    },

    async getOrder(orderId) {
      return observeOperation('get_order', async (databaseCall) => {
        const orderResult = await databaseCall(() => pool.query(`
          SELECT id, status, total_cents, created_at
          FROM orders
          WHERE id = $1
        `, [orderId]));
        if (orderResult.rowCount === 0) throw new OrderNotFoundError(orderId);
        const itemResult = await databaseCall(() => pool.query(`
          SELECT product_id, sku, product_name, unit_price_cents, quantity
          FROM order_items
          WHERE order_id = $1
          ORDER BY product_id
        `, [orderId]));
        return mapOrder(orderResult.rows[0], itemResult.rows.map((row) => ({
          productId: Number(row.product_id),
          sku: row.sku,
          name: row.product_name,
          unitPriceCents: Number(row.unit_price_cents),
          quantity: Number(row.quantity),
        })));
      });
    },

    async isReady() {
      return observeOperation('readiness', async (databaseCall) => {
        await databaseCall(() => pool.query('SELECT 1'));
        return true;
      });
    },

    async withTransaction(callback) {
      return observeOperation('transaction', async (databaseCall) => {
        const client = await databaseCall(() => pool.connect(), 'connection_failed');
        try {
          const transactionQuery = (text, values) => databaseCall(() => client.query(text, values));
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
            await databaseCall(() => client.query('ROLLBACK'));
          } catch {
            // The original business operation error remains the stable boundary.
          }
          throw error;
        } finally {
          client.release();
        }
      });
    },
  };
}
