import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { readLoadConfig } from '../scripts/load-config.mjs';

const valid = {
  TARGET_ENV: 'dev',
  TARGET_URL: 'https://dev.example.test',
  EXPECTED_DEV_HOST: 'dev.example.test',
  RATE_PER_SECOND: '5',
  DURATION_SECONDS: '60',
};

test('load configuration은 bounded Dev HTTPS traffic만 허용한다', () => {
  assert.deepEqual(readLoadConfig(valid), {
    targetUrl: valid.TARGET_URL,
    ratePerSecond: 5,
    durationSeconds: 60,
  });
  assert.throws(() => readLoadConfig({ ...valid, TARGET_ENV: 'prod' }), /TARGET_ENV must equal dev/);
  assert.throws(() => readLoadConfig({ ...valid, TARGET_URL: 'http://dev.example.test' }), /TARGET_URL must begin with https:\/\//);
  assert.throws(() => readLoadConfig({ ...valid, TARGET_URL: 'https://prod.example.test' }), /TARGET_URL host must equal EXPECTED_DEV_HOST/);
  assert.throws(() => readLoadConfig({ ...valid, TARGET_URL: 'https://user@dev.example.test' }), /TARGET_URL must not contain credentials or fragment/);
  assert.throws(() => readLoadConfig({ ...valid, TARGET_URL: 'https://dev.example.test/#unsafe' }), /TARGET_URL must not contain credentials or fragment/);
  assert.throws(() => readLoadConfig({ ...valid, TARGET_URL: 'https://dev.example.test/api' }), /TARGET_URL must be the Dev origin only/);
  assert.throws(() => readLoadConfig({ ...valid, TARGET_URL: 'https://dev.example.test?unsafe=1' }), /TARGET_URL must be the Dev origin only/);
  assert.throws(() => readLoadConfig({ ...valid, TARGET_URL: 'https://dev.example.test:8443' }), /TARGET_URL must use the default HTTPS port/);
  assert.throws(() => readLoadConfig({ ...valid, RATE_PER_SECOND: '21' }), /RATE_PER_SECOND must be between 1 and 20/);
  assert.throws(() => readLoadConfig({ ...valid, DURATION_SECONDS: '29' }), /DURATION_SECONDS must be between 30 and 300/);
});

test('k6 baseline은 constant-arrival-rate를 사용하고 public fault endpoint를 호출하지 않는다', () => {
  const source = fs.readFileSync(new URL('../load/k6-baseline.js', import.meta.url), 'utf8');
  assert.match(source, /constant-arrival-rate/);
  assert.doesNotMatch(source, /\/fault/);
});

test('runtime verifier는 금지된 DATABASE_URL 대신 canonical DB_* config를 사용한다', () => {
  const source = fs.readFileSync(new URL('../scripts/verify-commerce-invariants.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /DATABASE_URL/);
  assert.match(source, /DATABASE_ENABLED=true is required/);
  assert.match(source, /createDatabasePool\(config\.database\)/);
});
