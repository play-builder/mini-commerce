import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { createApplication } from '../src/application.js';
import { withDatabaseSpan } from '../src/telemetry.js';

test('business listener exports W3C request span without request secrets or generic HTTP metrics', async (t) => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  t.after(() => provider.shutdown());
  const app = createApplication({
    telemetryTracer: provider.getTracer('mini-commerce-test'),
    commerceService: { async listProducts() { return []; } },
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/products`, {
    headers: { authorization: 'Bearer private-token', cookie: 'session=private-cookie', 'idempotency-key': 'private-key' },
  });
  assert.equal(response.status, 200);
  await provider.forceFlush();
  const serialized = JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes));
  for (const secret of ['private-token', 'private-cookie', 'private-key']) assert.equal(serialized.includes(secret), false);
});

test('database wrapper ends semantic query spans without recording SQL values', async () => {
  const spans = [];
  const tracer = { startActiveSpan(name, callback) { return callback({ recordException() {}, end() { spans.push(name); } }); } };
  assert.equal(await withDatabaseSpan({ tracer, execute: async () => 'query-result' }), 'query-result');
  assert.deepEqual(spans, ['postgresql.query']);
});
