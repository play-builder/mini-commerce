import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

test('instrumentation preload installs explicit HTTP, Express, and PostgreSQL instrumentation', () => {
  const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageManifest.scripts.start,
    'node --import ./src/register-instrumentation-hooks.js --import ./src/instrumentation.js src/server.js',
  );
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

test('runtime telemetry exports route templates without HTTP or database secrets', () => {
  const result = spawnSync(process.execPath, [
    '--import', './src/register-instrumentation-hooks.js',
    'test/fixtures/run-http-telemetry.mjs',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const serialized = JSON.stringify(output);
  for (const secret of [
    'customer-8472', 'query-secret', 'authorization-secret', 'ua-secret',
    'sql-text-secret', 'db-param-secret', 'status-secret', 'event-secret', 'link-secret',
  ]) assert.equal(serialized.includes(secret), false, secret);
  assert.ok(output.runtimeSpans.some((span) => (
    span.scope === '@opentelemetry/instrumentation-http'
      && span.attributes['http.route'] === '/orders/:id'
  )));
  assert.ok(output.runtimeSpans.some((span) => (
    span.scope === '@opentelemetry/instrumentation-express'
  )));
  assert.deepEqual(output.syntheticSpan.attributes, {
    'db.system.name': 'postgresql',
    'db.operation.name': 'SELECT',
  });
  assert.deepEqual(output.syntheticSpan.status, { code: 2 });
  assert.deepEqual(output.syntheticSpan.events, []);
  assert.deepEqual(output.syntheticSpan.links[0].attributes, {});
});
