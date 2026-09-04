import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const managementPaths = new Set(['/healthz', '/readyz', '/metrics', '/version']);
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

export const instrumentationSdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'mini-commerce' }),
  ...(endpoint ? { traceExporter: new OTLPTraceExporter({ url: endpoint }) } : {}),
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) => managementPaths.has(request.url?.split('?')[0]),
    }),
    new ExpressInstrumentation(),
    new PgInstrumentation({ enhancedDatabaseReporting: false }),
  ],
});

instrumentationSdk.start();

export function shutdownInstrumentation() {
  return instrumentationSdk.shutdown();
}

globalThis.__miniCommerceShutdownInstrumentation = shutdownInstrumentation;
