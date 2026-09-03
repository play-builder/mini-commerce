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
  let target;
  try {
    target = new URL(env.TARGET_URL);
  } catch {
    throw new Error('TARGET_URL must be a valid URL');
  }
  if (typeof env.EXPECTED_DEV_HOST !== 'string' || env.EXPECTED_DEV_HOST.length === 0) {
    throw new Error('EXPECTED_DEV_HOST is required');
  }
  if (target.hostname !== env.EXPECTED_DEV_HOST) {
    throw new Error('TARGET_URL host must equal EXPECTED_DEV_HOST');
  }
  if (target.username || target.password || target.hash) {
    throw new Error('TARGET_URL must not contain credentials or fragment');
  }
  if (target.port && target.port !== '443') {
    throw new Error('TARGET_URL must use the default HTTPS port');
  }
  if (target.pathname !== '/' || target.search) {
    throw new Error('TARGET_URL must be the Dev origin only');
  }
  return {
    targetUrl: target.origin,
    ratePerSecond: boundedInteger(env.RATE_PER_SECOND, 'RATE_PER_SECOND', 1, 20),
    durationSeconds: boundedInteger(env.DURATION_SECONDS, 'DURATION_SECONDS', 30, 300),
  };
}
