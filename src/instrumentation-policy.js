import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

const managementPaths = new Set(['/healthz', '/readyz', '/metrics', '/version']);
const queryParametersToRedact = [
  'sig', 'Signature', 'AWSAccessKeyId', 'X-Goog-Signature', 'X-Amz-Signature',
  'X-Amz-Credential', 'X-Amz-Security-Token', 'token', 'authorization',
  'idempotency_key', 'api_key', 'password', 'secret',
];
const safeAttributesByScope = Object.freeze({
  '@opentelemetry/instrumentation-http': new Set([
    'http.request.method', 'http.response.status_code', 'http.route', 'url.scheme',
    'network.protocol.version', 'server.port', 'error.type',
  ]),
  '@opentelemetry/instrumentation-express': new Set([
    'http.route', 'express.name', 'express.type',
  ]),
  '@opentelemetry/instrumentation-pg': new Set([
    'db.system.name', 'db.namespace', 'db.operation.name', 'server.address',
    'server.port', 'error.type',
  ]),
  'mini-commerce': new Set(['commerce.item_count']),
});
const businessSpanNames = new Set([
  'commerce.order.create', 'commerce.db.transaction', 'commerce.inventory.reserve',
]);

function safeSpanName(span, attributes) {
  const scope = span.instrumentationScope.name;
  if (scope === '@opentelemetry/instrumentation-http') {
    const method = attributes['http.request.method'] ?? 'HTTP';
    return attributes['http.route'] ? `${method} ${attributes['http.route']}` : `${method} request`;
  }
  if (scope === '@opentelemetry/instrumentation-express') {
    return `express ${attributes['express.type'] ?? 'layer'}`;
  }
  if (scope === '@opentelemetry/instrumentation-pg') {
    return `database ${attributes['db.operation.name'] ?? 'operation'}`;
  }
  if (scope === 'mini-commerce') {
    return businessSpanNames.has(span.name) ? span.name : 'mini-commerce.operation';
  }
  return 'instrumented.operation';
}

export function sanitizeReadableSpan(span) {
  const allowed = safeAttributesByScope[span.instrumentationScope.name] ?? new Set();
  const attributes = Object.fromEntries(
    Object.entries(span.attributes).filter(([name]) => allowed.has(name)),
  );
  return {
    name: safeSpanName(span, attributes),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes,
    links: span.links.map((link) => ({ ...link, attributes: {} })),
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount
      + Math.max(0, Object.keys(span.attributes).length - Object.keys(attributes).length),
    droppedEventsCount: span.droppedEventsCount + span.events.length,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export function createPrivacyFilteringExporter(delegate) {
  return {
    export(spans, callback) {
      delegate.export(spans.map(sanitizeReadableSpan), callback);
    },
    forceFlush() { return delegate.forceFlush?.() ?? Promise.resolve(); },
    shutdown() { return delegate.shutdown(); },
  };
}

export function createRuntimeInstrumentations() {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) => managementPaths.has(request.url?.split('?')[0]),
      redactedQueryParams: queryParametersToRedact,
      redactedQueryParamsServer: queryParametersToRedact,
    }),
    new ExpressInstrumentation(),
    new PgInstrumentation({
      enhancedDatabaseReporting: false,
      requestHook: (span) => {
        span.setAttribute('db.query.text', '[REDACTED]');
        span.setAttribute('db.statement', '[REDACTED]');
      },
    }),
  ];
}
