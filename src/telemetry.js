import { randomBytes, randomUUID } from 'node:crypto';

import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let installedTracer = trace.getTracer('sample-app');

function parseResourceAttributes(raw = '') {
  return Object.fromEntries(raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) return [entry, ''];
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

export function initializeTelemetry({ serviceName, endpoint, resourceAttributes } = {}) {
  if (!endpoint) {
    installedTracer = trace.getTracer(serviceName || 'sample-app');
    return { tracer: installedTracer, shutdown: async () => {} };
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName || 'sample-app',
      ...parseResourceAttributes(resourceAttributes),
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
  });
  sdk.start();
  installedTracer = trace.getTracer(serviceName || 'sample-app');
  return { tracer: installedTracer, shutdown: () => sdk.shutdown() };
}

export function getTracer() {
  return installedTracer;
}

export async function withDatabaseSpan({ tracer = getTracer(), execute }) {
  return tracer.startActiveSpan('postgresql.query', async (span) => {
    try {
      return await execute();
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function startRequestTelemetry(req) {
  const incomingRequestId = req.get?.('x-request-id');
  const requestId = /^[A-Za-z0-9_-]{1,64}$/.test(incomingRequestId ?? '')
    ? incomingRequestId
    : randomUUID().replaceAll('-', '');
  const traceparent = req.get?.('traceparent') ?? '';
  const traceId = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent)?.[1]
    ?? randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const startedAt = process.hrtime.bigint();

  return {
    requestId,
    traceId,
    spanId,
    end(statusCode) {
      return {
        statusCode,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      };
    },
  };
}

export function writeLog({
  level,
  event,
  requestId,
  traceId,
  spanId,
  method,
  route,
  statusCode,
  durationMs,
}) {
  console.log(JSON.stringify({
    level,
    event,
    requestId,
    traceId,
    spanId,
    method,
    route,
    statusCode,
    durationMs,
  }));
}
