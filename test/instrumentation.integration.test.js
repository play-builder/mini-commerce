import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

function dockerRuntimeCommand() {
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const command = dockerfile.match(/^CMD (\[.*\])$/m)?.[1];
  assert.ok(command, 'Dockerfile must define a JSON-form CMD');
  return JSON.parse(command);
}

function runTelemetry(arguments_ = [], fixtureArguments = []) {
  const result = spawnSync(process.execPath, [
    ...arguments_, 'test/fixtures/run-http-telemetry.mjs', ...fixtureArguments,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

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
  const [, ...arguments_] = dockerRuntimeCommand();
  const output = runTelemetry(arguments_.slice(0, 2));
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

test('production Docker entrypoint includes the registration hook required by runtime telemetry', () => {
  assert.deepEqual(dockerRuntimeCommand(), [
    'node',
    '--import', './src/register-instrumentation-hooks.js',
    '--import', './src/instrumentation.js',
    'src/server.js',
  ]);
  const output = runTelemetry([], ['--defer-resource']);
  // The CommonJS HTTP patch still works without the ESM registration hook;
  // Express route templates and layer spans require that hook.
  assert.ok(output.runtimeSpans.some((span) => (
    span.scope === '@opentelemetry/instrumentation-http'
  )));
  assert.ok(output.runtimeSpans.every((span) => span.attributes['http.route'] === undefined));
  assert.ok(output.runtimeSpans.every((span) => (
    span.scope !== '@opentelemetry/instrumentation-express'
  )));
});

test('telemetry snapshot waits for exports blocked by asynchronous resource detection', () => {
  const [, ...arguments_] = dockerRuntimeCommand();
  const output = runTelemetry(arguments_.slice(0, 2), ['--defer-resource']);
  assert.ok(output.runtimeSpans.some((span) => (
    span.scope === '@opentelemetry/instrumentation-http'
      && span.attributes['http.route'] === '/orders/:id'
  )), 'completed HTTP route must be exported before the telemetry snapshot');
  assert.ok(output.runtimeSpans.some((span) => (
    span.scope === '@opentelemetry/instrumentation-express'
  )));
});
