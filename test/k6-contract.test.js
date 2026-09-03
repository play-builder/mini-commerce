import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { readLoadConfig } from '../scripts/load-config.mjs';

const valid = {
  TARGET_ENV: 'dev',
  TARGET_URL: 'https://dev.example.test',
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
  assert.throws(() => readLoadConfig({ ...valid, RATE_PER_SECOND: '21' }), /RATE_PER_SECOND must be between 1 and 20/);
  assert.throws(() => readLoadConfig({ ...valid, DURATION_SECONDS: '29' }), /DURATION_SECONDS must be between 30 and 300/);
});

test('k6 baseline은 constant-arrival-rate를 사용하고 public fault endpoint를 호출하지 않는다', () => {
  const source = fs.readFileSync(new URL('../load/k6-baseline.js', import.meta.url), 'utf8');
  assert.match(source, /constant-arrival-rate/);
  assert.doesNotMatch(source, /\/fault/);
});
