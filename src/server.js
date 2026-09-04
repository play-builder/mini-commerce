import { config } from './config.js';
import { createApplication } from './application.js';
import { createCommerceService, DatabaseUnavailableError } from './commerce-service.js';
import { createDatabasePool, createPostgresCommerceRepository, PRODUCT_READ_CONTRACT } from './database.js';
import { createManagement } from './management.js';
import { createReadiness } from './readiness.js';
import { initializeTelemetry } from './telemetry.js';

const telemetry = initializeTelemetry({
  serviceName: 'mini-commerce',
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
  resourceAttributes: process.env.OTEL_RESOURCE_ATTRIBUTES ?? '',
});
const pool = config.databaseEnabled ? createDatabasePool(config.database) : null;
const commerceService = pool ? createCommerceService(createPostgresCommerceRepository(pool, {
  productReadContract: PRODUCT_READ_CONTRACT.V2_PRIME,
})) : {
  listProducts: async () => { throw new DatabaseUnavailableError(); },
  getInventory: async () => { throw new DatabaseUnavailableError(); },
  getOrder: async () => { throw new DatabaseUnavailableError(); },
  createOrder: async () => { throw new DatabaseUnavailableError(); },
};
const readiness = createReadiness({
  dependencyPolicy: config.readinessDependencyPolicy,
  checkDependency: async () => !pool || (await pool.query('SELECT 1'), true),
});
const publicServer = createApplication({ commerceService }).listen(config.publicPort);
const managementServer = createManagement({
  readiness,
  metrics: { contentType: 'text/plain', metrics: async () => '' },
  build: { version: config.version, gitSha: config.gitSha, buildDate: config.buildDate, nodeVersion: process.version, pod: config.podName },
}).listen(config.managementPort);
await readiness.initialize();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  readiness.markNotReady('shutting down');
  publicServer.close();
  if (pool) await pool.end();
  await telemetry.shutdown();
  managementServer.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
