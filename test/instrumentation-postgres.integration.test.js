import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

test('PostgreSQL telemetry exports no SQL text or query parameter', {
  skip: !process.env.DATABASE_TEST_URL,
}, async () => {
  const {
    createPrivacyFilteringExporter,
    createRuntimeInstrumentations,
  } = await import('../src/instrumentation-policy.js');
  const delegate = new InMemorySpanExporter();
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'mini-commerce-postgres-test' }),
    spanProcessors: [new SimpleSpanProcessor(createPrivacyFilteringExporter(delegate))],
    instrumentations: createRuntimeInstrumentations(),
  });
  sdk.start();
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_TEST_URL });
  try {
    const result = await pool.query("SELECT $1::text AS value /* sql-text-secret */", ['db-param-secret']);
    assert.equal(result.rows[0].value, 'db-param-secret');
    const spans = delegate.getFinishedSpans();
    assert.ok(spans.some((span) => span.instrumentationScope.name === '@opentelemetry/instrumentation-pg'));
    const serialized = JSON.stringify(spans.map((span) => ({
      name: span.name, attributes: span.attributes, status: span.status,
      events: span.events, links: span.links,
    })));
    assert.equal(serialized.includes('sql-text-secret'), false);
    assert.equal(serialized.includes('db-param-secret'), false);
  } finally {
    await pool.end();
    await sdk.shutdown();
  }
});
