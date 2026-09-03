export const STATEFUL_SEED_STOCK = 20;

function boundedInteger(raw, name, minimum, maximum) {
  if (!/^\d+$/.test(raw ?? '')) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function readLoadConfig(env) {
  if (env.TARGET_ENV !== 'dev') throw new Error('TARGET_ENV must equal dev');
  if (typeof env.TARGET_URL !== 'string' || !env.TARGET_URL.startsWith('https://')) {
    throw new Error('TARGET_URL must begin with https://');
  }
  if (typeof env.EXPECTED_DEV_HOST !== 'string' || env.EXPECTED_DEV_HOST.length === 0) {
    throw new Error('EXPECTED_DEV_HOST is required');
  }
  if (/[:/?#@]/.test(env.EXPECTED_DEV_HOST)) {
    throw new Error('EXPECTED_DEV_HOST must be a hostname only');
  }
  if (env.TARGET_URL.includes('@') || env.TARGET_URL.includes('#')) {
    throw new Error('TARGET_URL must not contain credentials or fragment');
  }
  const match = /^https:\/\/([^/:?#]+)(?::(\d+))?(\/?)$/.exec(env.TARGET_URL);
  if (!match) throw new Error('TARGET_URL must be the Dev origin only');
  const [, hostname, port] = match;
  if (hostname !== env.EXPECTED_DEV_HOST) {
    throw new Error('TARGET_URL host must equal EXPECTED_DEV_HOST');
  }
  if (port && port !== '443') {
    throw new Error('TARGET_URL must use the default HTTPS port');
  }
  return {
    targetUrl: `https://${hostname}`,
    ratePerSecond: boundedInteger(env.RATE_PER_SECOND, 'RATE_PER_SECOND', 1, 20),
    durationSeconds: boundedInteger(env.DURATION_SECONDS, 'DURATION_SECONDS', 30, 300),
  };
}

export function readStatefulLoadConfig(env) {
  const base = readLoadConfig(env);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(env.STATEFUL_LOAD_RUN_ID ?? '')) {
    throw new Error('STATEFUL_LOAD_RUN_ID must be a safe nonempty run identity');
  }
  return {
    ...base,
    ratePerSecond: boundedInteger(env.RATE_PER_SECOND, 'RATE_PER_SECOND', 1, 2),
    durationSeconds: boundedInteger(env.DURATION_SECONDS, 'DURATION_SECONDS', 30, 60),
    productId: boundedInteger(env.PRODUCT_ID, 'PRODUCT_ID', 1, 2147483647),
    runId: env.STATEFUL_LOAD_RUN_ID,
    maxUniqueOrders: boundedInteger(
      env.MAX_UNIQUE_ORDERS ?? '10',
      'MAX_UNIQUE_ORDERS',
      1,
      STATEFUL_SEED_STOCK,
    ),
  };
}
