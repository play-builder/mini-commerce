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
  return {
    targetUrl: env.TARGET_URL.replace(/\/$/, ''),
    ratePerSecond: boundedInteger(env.RATE_PER_SECOND, 'RATE_PER_SECOND', 1, 20),
    durationSeconds: boundedInteger(env.DURATION_SECONDS, 'DURATION_SECONDS', 30, 300),
  };
}
