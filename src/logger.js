import pino from 'pino';
import { getRequestContext } from './request-context.js';

const events = new Set([
  'commerce.order.created', 'commerce.order.replayed', 'commerce.order.rejected',
  'commerce.inventory.conflict', 'database.pool.error', 'database.operation.failed',
  'application.readiness.changed',
  'application.shutdown.started', 'application.shutdown.completed', 'application.shutdown.forced',
  'application.shutdown.cleanup_failed', 'application.shutdown.failed',
]);
const databaseOperations = new Set([
  'list_products', 'get_inventory', 'get_order', 'readiness', 'transaction',
]);
const databaseReasons = new Set(['query_failed', 'connection_failed']);
const orderFailureReasons = new Set([
  'validation', 'product_not_found', 'insufficient_stock', 'database', 'internal',
]);

function safeDetails(event, details) {
  if (details === undefined) return {};
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new TypeError('unsupported log details');
  }
  if (event === 'database.operation.failed') {
    const keys = Object.keys(details).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['durationMs', 'operation', 'reason'])
      || !databaseOperations.has(details.operation)
      || !databaseReasons.has(details.reason)
      || !Number.isInteger(details.durationMs)
      || details.durationMs < 0
      || details.durationMs > 300000) {
      throw new TypeError('unsupported database operation details');
    }
    return details;
  }
  if (event === 'database.pool.error') {
    if (Object.keys(details).length !== 1 || details.reason !== 'idle_client_error') {
      throw new TypeError('unsupported database pool details');
    }
    return details;
  }
  if (event === 'commerce.order.rejected') {
    if (Object.keys(details).length !== 1 || !orderFailureReasons.has(details.reason)) {
      throw new TypeError('unsupported order rejection details');
    }
    return details;
  }
  if (Object.keys(details).length !== 0) throw new TypeError('unsupported log details');
  return {};
}

export function createLogger({ write, now = () => new Date().toISOString(), service = 'mini-commerce', environment = 'development', version = 'dev' } = {}) {
  const destination = write ? { write } : undefined;
  const sink = pino({ base: null, timestamp: false }, destination);
  function emit(level, event, details) {
    if (!events.has(event)) throw new TypeError('unsupported log event');
    const { requestId, traceId } = getRequestContext();
    sink[level]({
      timestamp: now(), service, environment, version, event, requestId, traceId,
      ...safeDetails(event, details),
    });
  }
  return {
    info: (event, details) => emit('info', event, details),
    error: (event, details) => emit('error', event, details),
  };
}
