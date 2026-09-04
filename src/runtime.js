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
    checkDependency: async () => !pool || (await pool.query('SELECT 1'), true),
  }) ?? createReadiness({
    dependencyPolicy: runtimeConfig.readinessDependencyPolicy,
    failureThreshold: runtimeConfig.readinessFailureThreshold,
    recoveryThreshold: runtimeConfig.readinessRecoveryThreshold,
    checkDependency: async () => !pool || (await pool.query('SELECT 1'), true),
  });
  const observer = pool ? (dependencies.createDatabaseObservability?.({ pool, metrics, logger, readiness })
    ?? createDatabaseObservability({ pool, metrics, logger, readiness })) : null;
  const repository = pool ? createPostgresCommerceRepository(pool, {
    productReadContract: PRODUCT_READ_CONTRACT.V2_PRIME,
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
      await readiness.initialize();
      const publicServer = application.listen(runtimeConfig.publicPort);
      const managementServer = management.listen(runtimeConfig.managementPort);
      lifecycle = createLifecycle({
        readiness, publicServer, managementServer, pool, telemetry, observer, logger,
        deadlineMs: runtimeConfig.shutdownDeadlineMs, exit: dependencies.exit,
      });
      return { publicServer, managementServer };
    },
    shutdown() { return lifecycle?.shutdown() ?? Promise.resolve(); },
  };
}
