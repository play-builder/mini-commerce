import { SpanStatusCode, trace } from '@opentelemetry/api';

export function getTracer() { return trace.getTracer('mini-commerce'); }

export async function withBusinessSpan({ name, attributes = {}, execute, tracer = getTracer() }) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await execute();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
