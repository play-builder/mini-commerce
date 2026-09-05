import { Counter, Gauge, Registry, collectDefaultMetrics } from '@prometheus-io/client';

const reasons = new Set(['validation', 'product_not_found', 'insufficient_stock', 'database', 'internal']);
const databaseOperations = new Set([
  'list_products', 'get_inventory', 'get_order', 'readiness', 'transaction',
]);

export function createBusinessMetrics({ registry = new Registry() } = {}) {
  collectDefaultMetrics({ register: registry, prefix: 'mini_commerce_' });
  const created = new Counter({ name: 'mini_commerce_orders_created_total', help: 'Created orders', registers: [registry] });
  const failures = new Counter({ name: 'mini_commerce_order_failures_total', help: 'Order failures', labelNames: ['reason'], registers: [registry] });
  const conflicts = new Counter({ name: 'mini_commerce_inventory_reservation_conflicts_total', help: 'Inventory conflicts', registers: [registry] });
  const poolErrors = new Counter({ name: 'mini_commerce_db_pool_errors_total', help: 'Database pool errors', registers: [registry] });
  const databaseFailures = new Counter({
    name: 'mini_commerce_db_operation_failures_total',
    help: 'Failed database operations',
    labelNames: ['operation'],
    registers: [registry],
  });
  const connections = new Gauge({ name: 'mini_commerce_db_pool_connections', help: 'Database pool connections', labelNames: ['state'], registers: [registry] });
  const waiting = new Gauge({ name: 'mini_commerce_db_pool_waiting_requests', help: 'Waiting database requests', registers: [registry] });
  return {
    registry,
    orderCreated: () => created.inc(),
    orderFailed: (reason) => {
      if (!reasons.has(reason)) throw new TypeError('unsupported failure reason');
      failures.inc({ reason });
    },
    inventoryConflict: () => conflicts.inc(),
    recordPoolError: () => poolErrors.inc(),
    recordDatabaseFailure: (operation) => {
      if (!databaseOperations.has(operation)) throw new TypeError('unsupported database operation');
      databaseFailures.inc({ operation });
    },
    observePool: (pool) => {
      connections.set({ state: 'total' }, pool.totalCount);
      connections.set({ state: 'idle' }, pool.idleCount);
      waiting.set(pool.waitingCount);
    },
  };
}
