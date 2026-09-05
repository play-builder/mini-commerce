import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '../src/logger.js';
import { runWithRequestContext } from '../src/request-context.js';

test('logger emits fixed safe JSON fields', () => {
  let line;
  const logger = createLogger({ write: (value) => { line = value; }, now: () => '2026-09-05T00:00:00.000Z' });
  runWithRequestContext({ requestId: 'request-1', traceId: 'trace-1' }, () => logger.info('commerce.order.created'));
  const record = JSON.parse(line);
  assert.deepEqual(record, {
    level: 30, timestamp: '2026-09-05T00:00:00.000Z', service: 'mini-commerce',
    environment: 'development', version: 'dev', event: 'commerce.order.created',
    requestId: 'request-1', traceId: 'trace-1',
  });
});

test('logger accepts only bounded database operation details', () => {
  const lines = [];
  const logger = createLogger({ write: (value) => lines.push(JSON.parse(value)) });

  logger.error('database.operation.failed', {
    operation: 'list_products',
    reason: 'query_failed',
    durationMs: 17,
  });

  assert.deepEqual({
    operation: lines[0].operation,
    reason: lines[0].reason,
    durationMs: lines[0].durationMs,
  }, { operation: 'list_products', reason: 'query_failed', durationMs: 17 });
  assert.throws(() => logger.error('database.operation.failed', {
    operation: 'customer-8472',
    reason: 'password=secret',
    durationMs: 17,
  }), /unsupported database operation details/);
  assert.throws(() => logger.error('database.operation.failed', {
    operation: 'list_products',
    reason: 'query_failed',
    durationMs: -1,
  }), /unsupported database operation details/);
});
