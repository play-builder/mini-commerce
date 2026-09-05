import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import {
  createPrivacyFilteringExporter,
  createRuntimeInstrumentations,
} from './instrumentation-policy.js';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const exporter = createPrivacyFilteringExporter(new OTLPTraceExporter(endpoint ? { url: endpoint } : {}));

export const instrumentationSdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'mini-commerce' }),
  ...(process.env.OTEL_TRACES_EXPORTER === 'none' ? {} : { traceExporter: exporter }),
  instrumentations: createRuntimeInstrumentations(),
});

instrumentationSdk.start();

export function shutdownInstrumentation() {
  return instrumentationSdk.shutdown();
}

globalThis.__miniCommerceShutdownInstrumentation = shutdownInstrumentation;
