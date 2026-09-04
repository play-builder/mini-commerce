import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { createApplication } from '../src/application.js';
import { createCommerceService } from '../src/commerce-service.js';
import { createManagement } from '../src/management.js';

function routes(app) {
  return app.router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods)
      .map((method) => `${method.toUpperCase()} ${layer.route.path}`))
    .sort();
}

test('public and management route ownership is disjoint', () => {
  const commerceService = {
    listProducts: async () => [],
    getInventory: async () => ({}),
    createOrder: async () => ({}),
    getOrder: async () => ({}),
  };
  const readiness = { snapshot: () => ({ ready: true }) };
  const metrics = { contentType: 'text/plain', metrics: async () => '' };

  assert.deepEqual(routes(createApplication({ commerceService })), [
    'GET /orders/:id',
    'GET /products',
    'GET /products/:id/inventory',
    'POST /orders',
  ]);
  assert.deepEqual(routes(createManagement({ readiness, metrics, build: {} })), [
    'GET /healthz', 'GET /metrics', 'GET /readyz', 'GET /version',
  ]);
});

test('runtime identity is mini-commerce across package, OCI, telemetry, metrics, and README', () => {
  const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const telemetry = fs.readFileSync(new URL('../src/telemetry.js', import.meta.url), 'utf8');
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  assert.equal(packageManifest.name, 'mini-commerce');
  assert.equal(packageLock.name, 'mini-commerce');
  assert.equal(packageLock.packages[''].name, 'mini-commerce');
  assert.match(packageManifest.description, /production/i);
  assert.match(dockerfile, /org\.opencontainers\.image\.title="mini-commerce"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.description="Mini Commerce production service"/);
  assert.doesNotMatch(telemetry, /sample-app/);
  assert.match(telemetry, /trace\.getTracer\('mini-commerce'\)/);
  assert.equal(fs.existsSync(new URL('../src/metrics.js', import.meta.url)), false);
  assert.match(readme, /^# Mini Commerce/m);
});

test('database failure is an actual HTTP 503 without raw driver text', async (t) => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  t.after(() => provider.shutdown());
  const stdout = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => stdout.push(line);
  console.error = (line) => stdout.push(line);
  t.after(() => { console.log = originalLog; console.error = originalError; });
  const rawSecret = 'SELECT card_number FROM orders WHERE key=secret-idempotency-key';
  const app = createApplication({
    commerceService: createCommerceService({ async listProducts() { throw new Error(rawSecret); } }),
    telemetryTracer: provider.getTracer('runtime-identity-test'),
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/products`);
  assert.equal(response.status, 503);
  assert.match(response.headers.get('x-request-id'), /^[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual(await response.json(), { error: 'database unavailable' });
  await provider.forceFlush();
  const exported = JSON.stringify(exporter.getFinishedSpans().map((span) => ({
    name: span.name, attributes: span.attributes, status: span.status,
  })));
  const emitted = stdout.join('\n');
  for (const secret of ['secret-idempotency-key', 'card_number', rawSecret]) {
    assert.equal(emitted.includes(secret), false);
    assert.equal(exported.includes(secret), false);
  }
  assert.equal(exported.includes('url.path'), false);
});
