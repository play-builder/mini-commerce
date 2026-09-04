import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '../src/logger.js';
import { runWithRequestContext } from '../src/request-context.js';

test('logger emits fixed safe JSON fields', () => {
  let line;
  const logger = createLogger({ write: (value) => { line = value; }, now: () => '2026-09-05T00:00:00.000Z' });
  runWithRequestContext({ requestId: 'request-1', traceId: 'trace-1' }, () => logger.info('commerce.order.created'));
  assert.deepEqual(JSON.parse(line), {
    timestamp: '2026-09-05T00:00:00.000Z', level: 'info', service: 'mini-commerce',
    environment: 'development', version: 'dev', event: 'commerce.order.created',
    requestId: 'request-1', traceId: 'trace-1',
  });
});
