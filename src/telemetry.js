import { randomUUID } from 'node:crypto';

import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
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

export function startRequestTelemetry(req, _res, { tracer = getTracer() } = {}) {
  const incomingRequestId = req.get?.('x-request-id');
  const requestId = /^[A-Za-z0-9_-]{1,64}$/.test(incomingRequestId ?? '')
    ? incomingRequestId
    : randomUUID().replaceAll('-', '');
  const parentContext = propagation.extract(context.active(), req.headers ?? {});
  const span = tracer.startSpan('http.request', {
    kind: SpanKind.SERVER,
    attributes: {
      'http.request.method': req.method,
      'url.path': req.path,
    },
  }, parentContext);
  const activeContext = trace.setSpan(parentContext, span);
  const { traceId, spanId } = span.spanContext();
  const startedAt = process.hrtime.bigint();
  let ended = false;

  return {
    requestId,
    traceId,
    spanId,
    run(callback) {
      return context.with(activeContext, callback);
    },
    end(statusCode) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (!ended) {
        ended = true;
        span.setAttribute('http.response.status_code', statusCode);
        span.setStatus(statusCode >= 500
          ? { code: SpanStatusCode.ERROR }
          : { code: SpanStatusCode.OK });
        span.end();
      }
      return { statusCode, durationMs };
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
