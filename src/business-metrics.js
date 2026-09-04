import { Counter, Gauge, Registry, collectDefaultMetrics } from '@prometheus-io/client';

const reasons = new Set(['validation', 'product_not_found', 'insufficient_stock', 'database', 'internal']);

export function createBusinessMetrics({ registry = new Registry() } = {}) {
  collectDefaultMetrics({ register: registry, prefix: 'mini_commerce_' });
  const created = new Counter({ name: 'mini_commerce_orders_created_total', help: 'Created orders', registers: [registry] });
  const failures = new Counter({ name: 'mini_commerce_order_failures_total', help: 'Order failures', labelNames: ['reason'], registers: [registry] });
  const conflicts = new Counter({ name: 'mini_commerce_inventory_reservation_conflicts_total', help: 'Inventory conflicts', registers: [registry] });
  const waiting = new Gauge({ name: 'mini_commerce_db_pool_waiting_requests', help: 'Waiting database requests', registers: [registry] });
  return {
    registry,
    orderCreated: () => created.inc(),
    orderFailed: (reason) => {
      if (!reasons.has(reason)) throw new TypeError('unsupported failure reason');
      failures.inc({ reason });
    },
    inventoryConflict: () => conflicts.inc(),
    observePool: (pool) => waiting.set(pool.waitingCount),
  };
}
