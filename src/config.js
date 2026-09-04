export class ConfigError extends Error {
  constructor(field, message) {
    super(`${field} ${message}`);
    this.name = 'ConfigError';
  }
}

function bool(value, field, fallback) {
  if (value === undefined) return fallback;
  if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new ConfigError(field, 'must be a boolean');
}

function integer(value, field, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new ConfigError(field, `must be an integer between ${min} and ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(field, `must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function rate(value, field, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ConfigError(field, 'must be a number between 0 and 1');
  }
  return parsed;
}

export function createConfig(env = process.env) {
  const environment = env.APP_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment)) {
    throw new ConfigError('APP_ENV', 'must be development, test, or production');
  }
  const publicPort = integer(env.PORT, 'PORT', 3000, 1, 65535);
  const managementPort = integer(env.MANAGEMENT_PORT, 'MANAGEMENT_PORT', 3001, 1, 65535);
  if (publicPort === managementPort) throw new ConfigError('MANAGEMENT_PORT', 'must differ from PORT');
  const databaseEnabled = bool(env.DATABASE_ENABLED, 'DATABASE_ENABLED', false);
  const ssl = bool(env.DB_SSL, 'DB_SSL', false);
  const readinessDependencyPolicy = env.READINESS_DEPENDENCY_POLICY ?? 'startup-only';
  if (!['startup-only', 'continuous'].includes(readinessDependencyPolicy)) {
    throw new ConfigError('READINESS_DEPENDENCY_POLICY', 'must be startup-only or continuous');
  }
  if (environment === 'production' && readinessDependencyPolicy === 'continuous') {
    throw new ConfigError('READINESS_DEPENDENCY_POLICY', 'continuous is not allowed in production');
  }
  if (environment === 'production' && databaseEnabled && !ssl) {
    throw new ConfigError('DB_SSL', 'must be true in production');
  }
  if (databaseEnabled) {
    for (const field of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      if (!env[field]?.trim()) throw new ConfigError(field, 'is required when DATABASE_ENABLED is true');
    }
  }
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined) {
    try { new URL(env.OTEL_EXPORTER_OTLP_ENDPOINT); } catch { throw new ConfigError('OTEL_EXPORTER_OTLP_ENDPOINT', 'must be an absolute URL'); }
  }
  return Object.freeze({
    environment,
    publicPort,
    port: publicPort,
    managementPort,
    readinessDependencyPolicy,
    version: env.APP_VERSION ?? 'dev',
    gitSha: env.GIT_SHA ?? 'unknown',
    buildDate: env.BUILD_DATE ?? 'unknown',
    podName: env.POD_NAME ?? 'local',
    nodeName: env.NODE_NAME ?? 'local',
    failureRate: rate(env.FAILURE_RATE, 'FAILURE_RATE', 0),
    latencyMs: integer(env.LATENCY_MS, 'LATENCY_MS', 0, 0, 600000),
    readyDelayMs: integer(env.READY_DELAY_MS, 'READY_DELAY_MS', 0, 0, 600000),
    shutdownDelayMs: integer(env.SHUTDOWN_DELAY_MS, 'SHUTDOWN_DELAY_MS', 5000, 0, 600000),
    shutdownDeadlineMs: integer(env.SHUTDOWN_DEADLINE_MS, 'SHUTDOWN_DEADLINE_MS', 30000, 1, 600000),
    secretKeys: (env.SECRET_KEYS ?? 'DB_HOST,DB_PASSWORD,API_KEY')
      .split(',').map((item) => item.trim()).filter(Boolean),
    databaseEnabled,
    database: Object.freeze({
      host: env.DB_HOST ?? '127.0.0.1',
      port: integer(env.DB_PORT, 'DB_PORT', 5432, 1, 65535),
      name: env.DB_NAME ?? 'commerce',
      user: env.DB_USER ?? 'commerce',
      password: env.DB_PASSWORD ?? '',
      ssl,
      connectionTimeoutMs: integer(env.DB_CONNECTION_TIMEOUT_MS, 'DB_CONNECTION_TIMEOUT_MS', 2000, 1, 600000),
      queryTimeoutMs: integer(env.DB_QUERY_TIMEOUT_MS, 'DB_QUERY_TIMEOUT_MS', 2000, 1, 600000),
    }),
  });
}

export const config = createConfig();
