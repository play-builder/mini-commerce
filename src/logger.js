import { getRequestContext } from './request-context.js';

const events = new Set([
  'commerce.order.created', 'commerce.order.replayed', 'commerce.order.rejected',
  'commerce.inventory.conflict', 'database.pool.error', 'application.readiness.changed',
  'application.shutdown.started', 'application.shutdown.completed', 'application.shutdown.forced',
]);

export function createLogger({ write = console.log, now = () => new Date().toISOString(), service = 'mini-commerce', environment = 'development', version = 'dev' } = {}) {
  function emit(level, event) {
    if (!events.has(event)) throw new TypeError('unsupported log event');
    const { requestId, traceId } = getRequestContext();
    write(JSON.stringify({ timestamp: now(), level, service, environment, version, event, requestId, traceId }));
  }
  return { info: (event) => emit('info', event), error: (event) => emit('error', event) };
}
