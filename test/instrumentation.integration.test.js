import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

test('instrumentation preload installs explicit HTTP, Express, and PostgreSQL instrumentation', () => {
  const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageManifest.scripts.start, 'node --import ./src/instrumentation.js src/server.js');
  for (const dependency of [
    '@opentelemetry/instrumentation-http', '@opentelemetry/instrumentation-express',
    '@opentelemetry/instrumentation-pg', 'pino',
  ]) assert.ok(packageManifest.dependencies[dependency]);
  const result = spawnSync(process.execPath, [
    '--import', './src/instrumentation.js', '--input-type=module', '-e',
    "import { shutdownInstrumentation } from './src/instrumentation.js'; await shutdownInstrumentation();",
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
