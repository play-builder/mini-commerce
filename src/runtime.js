import { createServer } from 'node:http';

import { createApplication } from './application.js';
import { createBusinessMetrics } from './business-metrics.js';
import { createCommerceService, DatabaseUnavailableError } from './commerce-service.js';
import { createDatabaseObservability } from './database-observability.js';
import { createDatabasePool, createPostgresCommerceRepository, PRODUCT_READ_CONTRACT } from './database.js';
import { createLifecycle } from './lifecycle.js';
import { createLogger } from './logger.js';
import { createManagement } from './management.js';
import { createReadiness } from './readiness.js';
import { getTracer } from './telemetry.js';

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

// Check the schema required by this image, without scanning data or modifying it.
const startupSchemaQuery = `
  SELECT p.display_name, p.price_cents, i.available_quantity,
         o.idempotency_key, o.total_cents, oi.quantity
  FROM products p, inventory i, orders o, order_items oi LIMIT 0
`;

export function createRuntime({ runtimeConfig, dependencies = {} }) {
  const telemetry = dependencies.telemetry ?? {
    tracer: getTracer(), shutdown: () => globalThis.__miniCommerceShutdownInstrumentation?.() ?? Promise.resolve(),
  };
  const metrics = dependencies.createBusinessMetrics?.() ?? createBusinessMetrics();
  const logger = dependencies.createLogger?.({
    environment: runtimeConfig.environment, version: runtimeConfig.version,
  }) ?? createLogger({ environment: runtimeConfig.environment, version: runtimeConfig.version });
  const pool = runtimeConfig.databaseEnabled
    ? (dependencies.createDatabasePool?.(runtimeConfig.database) ?? createDatabasePool(runtimeConfig.database))
    : null;
  const readiness = dependencies.createReadiness?.({
    dependencyPolicy: runtimeConfig.readinessDependencyPolicy,
    failureThreshold: runtimeConfig.readinessFailureThreshold,
    recoveryThreshold: runtimeConfig.readinessRecoveryThreshold,
    checkDependency: async () => !pool || (await pool.query(startupSchemaQuery), true),
  }) ?? createReadiness({
    dependencyPolicy: runtimeConfig.readinessDependencyPolicy,
    failureThreshold: runtimeConfig.readinessFailureThreshold,
    recoveryThreshold: runtimeConfig.readinessRecoveryThreshold,
    checkDependency: async () => !pool || (await pool.query(startupSchemaQuery), true),
  });
  const observer = pool ? (dependencies.createDatabaseObservability?.({ pool, metrics, logger, readiness })
    ?? createDatabaseObservability({ pool, metrics, logger, readiness })) : null;
  const repository = pool ? createPostgresCommerceRepository(pool, {
    productReadContract: PRODUCT_READ_CONTRACT.V2_PRIME,
    dependencySignals: observer,
  }) : null;
  const commerceService = repository ? createCommerceService(repository, { metrics, logger, tracer: telemetry.tracer }) : {
    listProducts: async () => { throw new DatabaseUnavailableError(); },
    getInventory: async () => { throw new DatabaseUnavailableError(); },
    getOrder: async () => { throw new DatabaseUnavailableError(); },
    createOrder: async () => { throw new DatabaseUnavailableError(); },
  };
  const application = createApplication({ commerceService });
  const management = createManagement({
    readiness,
    metrics: {
      contentType: metrics.registry.contentType,
      metrics: async () => {
        observer?.snapshot();
        return metrics.registry.metrics();
      },
    },
    build: { version: runtimeConfig.version, gitSha: runtimeConfig.gitSha, buildDate: runtimeConfig.buildDate, nodeVersion: process.version, pod: runtimeConfig.podName },
  });
  let lifecycle;
  return {
    application, management, commerceService, metrics, logger, observer, readiness, telemetry,
    async start() {
      const publicServer = createServer(application);
      const managementServer = createServer(management);
      // Reject startup if a required schema/connection is unavailable. A supervisor retries;
      // an indefinitely unready process must not wait for business traffic to recover.
      try {
        await readiness.initialize();
        if (!readiness.snapshot().ready) throw new Error('dependency unavailable');
        await listen(publicServer, runtimeConfig.publicPort);
        await listen(managementServer, runtimeConfig.managementPort);
      } catch {
        readiness.markNotReady('startup failed');
        await Promise.allSettled([
          ...[publicServer, managementServer].map((server) => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          })),
          pool?.end(), observer?.close(), telemetry.shutdown(),
        ]);
        throw new Error('application startup failed: check database schema, connectivity, and listener ports');
      }
      const lifecycleFactory = dependencies.createLifecycle ?? createLifecycle;
      lifecycle = lifecycleFactory({
        readiness, publicServer, managementServer, pool, telemetry, observer, logger,
        deadlineMs: runtimeConfig.shutdownDeadlineMs, exit: dependencies.exit ?? process.exit,
      });
      return { publicServer, managementServer };
    },
    shutdown() { return lifecycle?.shutdown() ?? Promise.resolve(); },
  };
}
