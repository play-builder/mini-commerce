import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { ConfigError, createConfig } from '../src/config.js';

test('invalid numeric configuration fails instead of falling back', () => {
  assert.throws(
    () => createConfig({ PORT: 'bad' }),
    (error) => error instanceof ConfigError
      && error.message === 'PORT must be an integer between 1 and 65535',
  );
});

test('production database configuration requires TLS', () => {
  assert.throws(
    () => createConfig({
      APP_ENV: 'production',
      DATABASE_ENABLED: 'true',
      DB_HOST: 'database.internal',
      DB_NAME: 'commerce',
      DB_USER: 'commerce',
      DB_PASSWORD: 'secret',
      DB_SSL: 'false',
    }),
    /DB_SSL must be true in production/,
  );
});

test('safe defaults separate public and management listeners', () => {
  const config = createConfig({});

  assert.equal(config.publicPort, 3000);
  assert.equal(config.managementPort, 3001);
  assert.equal(config.readinessDependencyPolicy, 'startup-only');
  assert.equal(Object.isFrozen(config), true);
});

test('.env.example is runnable without local database credentials', () => {
  const env = Object.fromEntries(fs.readFileSync(
    new URL('../.env.example', import.meta.url), 'utf8',
  ).trim().split('\n').map((line) => line.split('=', 2)));

  const config = createConfig(env);
  assert.equal(config.databaseEnabled, false);
  assert.equal(config.readinessDependencyPolicy, 'startup-only');
  assert.equal(config.shutdownDeadlineMs, 30000);
});
