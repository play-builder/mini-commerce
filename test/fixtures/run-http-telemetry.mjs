import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import {
  createPrivacyFilteringExporter,
  createRuntimeInstrumentations,
} from '../../src/instrumentation-policy.js';

const delegate = new InMemorySpanExporter();
const processor = new SimpleSpanProcessor(createPrivacyFilteringExporter(delegate));
// Hold a real SDK resource attribute until HTTP has completed, independently of
// how quickly host resource detection happens on the machine running the test.
const deferredResource = process.argv.includes('--defer-resource')
  ? Promise.withResolvers() : undefined;
const sdk = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': 'mini-commerce-test' }),
  ...(deferredResource ? {
    resourceDetectors: [{
      detect: () => ({ attributes: { 'test.resource.ready': deferredResource.promise } }),
    }],
  } : {}),
  spanProcessors: [processor],
  instrumentations: createRuntimeInstrumentations(),
});
sdk.start();

const { createApplication } = await import('../../src/application.js');
const app = createApplication({
  commerceService: {
    async listProducts() { return []; },
    async getInventory() { return {}; },
    async createOrder() { return {}; },
    async getOrder(id) { return { id }; },
  },
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
await fetch(`http://127.0.0.1:${server.address().port}/orders/customer-8472?token=query-secret`, {
  headers: {
    authorization: 'Bearer authorization-secret',
    'user-agent': 'ua-secret',
    'x-request-id': 'request-secret',
  },
});
await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const syntheticCaptured = [];
const syntheticDelegate = {
  export(spans, callback) { syntheticCaptured.push(...spans); callback({ code: 0 }); },
  shutdown: async () => {},
};
const syntheticExporter = createPrivacyFilteringExporter(syntheticDelegate);
await new Promise((resolve, reject) => syntheticExporter.export([{
  name: 'SELECT /* sql-text-secret */',
  kind: 2,
  spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 }),
  startTime: [0, 0],
  endTime: [0, 1],
  duration: [0, 1],
  status: { code: 2, message: 'status-secret' },
  attributes: {
    'db.system.name': 'postgresql',
    'db.operation.name': 'SELECT',
    'db.query.text': 'SELECT /* sql-text-secret */ $1',
    'db.postgresql.values': ['db-param-secret'],
  },
  links: [{
    context: { traceId: '3'.repeat(32), spanId: '4'.repeat(16), traceFlags: 1 },
    attributes: { unsafe: 'link-secret' },
  }],
  events: [{ name: 'exception', time: [0, 1], attributes: { 'exception.message': 'event-secret' } }],
  ended: true,
  resource: resourceFromAttributes({ 'service.name': 'mini-commerce-test' }),
  instrumentationScope: { name: '@opentelemetry/instrumentation-pg', version: '0.74.0' },
  droppedAttributesCount: 0,
  droppedEventsCount: 0,
  droppedLinksCount: 0,
}], (result) => (result.code === 0 ? resolve() : reject(result.error))));

const summarize = (span) => ({
  name: span.name,
  scope: span.instrumentationScope.name,
  attributes: span.attributes,
  status: span.status,
  events: span.events,
  links: span.links,
});
deferredResource?.resolve(true);
// Completed HTTP requests may still have exports waiting for SDK resources.
// Flush the processor before reading; shutdown clears the in-memory exporter.
await processor.forceFlush();
process.stdout.write(`${JSON.stringify({
  runtimeSpans: delegate.getFinishedSpans().map(summarize),
  syntheticSpan: summarize(syntheticCaptured[0]),
})}\n`);
await sdk.shutdown();
