import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { createApplication } from '../src/application.js';
import { createManagement } from '../src/management.js';
import { createConfig } from '../src/config.js';
import { createDatabasePool, createPostgresCommerceRepository } from '../src/database.js';
import { createRuntime } from '../src/runtime.js';
import { createCommerceService, IdempotencyConflictError, ValidationError, calculateOrderTotal } from '../src/commerce-service.js';

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('production fails closed for a disabled database including NODE_ENV-only containers', () => {
  for (const env of [{ APP_ENV: 'production' }, { NODE_ENV: 'production' }]) {
    assert.throws(() => createConfig(env), /DATABASE_ENABLED must be true in production/);
  }
  const config = createConfig({ APP_ENV: 'test', NODE_ENV: 'production' });
  assert.equal(config.environment, 'test');
});

test('malformed JSON never echoes a body token, and rejected bodies retain request correlation', async (t) => {
  let calls = 0;
  const base = await listen(createApplication({ commerceService: { createOrder() { calls++; } } }), t);
  for (const [body, status, error] of [
    ['{"password":"do-not-echo-this-token",', 400, 'invalid JSON body'],
    [JSON.stringify({ token: 'x'.repeat(33000) }), 413, 'request body too large'],
  ]) {
    const response = await fetch(`${base}/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'safe-request-id' }, body,
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('x-request-id'), 'safe-request-id');
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(calls, 0);
});

test('management failures return sanitized JSON independently of NODE_ENV', async (t) => {
  const base = await listen(createManagement({
    readiness: { snapshot: () => ({ ready: true }) }, build: {},
    metrics: { contentType: 'text/plain', metrics: async () => { throw new Error('password=do-not-echo'); } },
  }), t);
  const response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'internal server error' });
});

test('order input rejects type coercion, aggregate quantity bypass, oversized item lists, and integer overflow', async () => {
  let transactions = 0;
  const service = createCommerceService({ withTransaction() { transactions++; } });
  const inputs = [
    { idempotencyKey: 17, items: [{ productId: 1, quantity: 1 }] },
    { idempotencyKey: 'key', items: [{ productId: true, quantity: 1 }] },
    { idempotencyKey: 'key', items: [{ productId: 1, quantity: '1' }] },
    { idempotencyKey: 'key', items: [{ productId: 1, quantity: 60 }, { productId: 1, quantity: 60 }] },
    { idempotencyKey: 'key', items: Array.from({ length: 101 }, () => ({ productId: 1, quantity: 1 })) },
  ];
  for (const input of inputs) await assert.rejects(service.createOrder(input), ValidationError);
  assert.throws(() => service.getInventory(true), ValidationError);
  assert.throws(() => service.getInventory('0x10'), ValidationError);
  assert.throws(() => calculateOrderTotal([{ unitPriceCents: 2147483647, quantity: 2 }]), ValidationError);
  assert.equal(transactions, 0);
});

test('idempotent retries compare normalized items before accepting the stored order', async () => {
  const existing = { id: 1, items: [{ productId: 2, quantity: 1 }, { productId: 1, quantity: 2 }] };
  let stockLocks = 0;
  const transaction = {
    advisoryLock: async () => {}, findOrderByIdempotencyKey: async () => existing,
    lockInventory: async () => { stockLocks++; },
  };
  const service = createCommerceService({ withTransaction: (callback) => callback(transaction) });
  assert.equal(await service.createOrder({ idempotencyKey: 'retry', items: [
    { productId: 1, quantity: 1 }, { productId: 2, quantity: 1 }, { productId: 1, quantity: 1 },
  ] }), existing);
  await assert.rejects(service.createOrder({ idempotencyKey: 'retry', items: [
    { productId: 1, quantity: 1 }, { productId: 2, quantity: 1 },
  ] }), IdempotencyConflictError);
  assert.equal(stockLocks, 0);
});

test('failed rollback evicts a connection rather than returning it with an unknown transaction state', async () => {
  for (const failedRollback of [false, true]) {
    let released;
    const client = {
      query: async (sql) => { if (failedRollback && sql === 'ROLLBACK') throw new Error('connection lost'); },
      release: (discard) => { released = discard; },
    };
    const repository = createPostgresCommerceRepository({ connect: async () => client });
    const original = new Error('original failure');
    await assert.rejects(repository.withTransaction(async () => { throw original; }), (error) => error === original);
    assert.equal(released, failedRollback);
  }
});

test('pool applies server-side statement and lock limits separately from client query timeout', async () => {
  const config = createConfig({ DB_POOL_MAX: '7', DB_STATEMENT_TIMEOUT_MS: '900', DB_LOCK_TIMEOUT_MS: '500' });
  const pool = createDatabasePool(config.database);
  assert.equal(pool.options.max, 7);
  assert.equal(pool.options.statement_timeout, 900);
  assert.equal(pool.options.lock_timeout, 500);
  assert.equal(pool.options.query_timeout, 3000);
  assert.equal(pool.options.idle_in_transaction_session_timeout, 10000);
  await pool.end();
  assert.throws(() => createConfig({ DB_POOL_MAX: '0' }), /DB_POOL_MAX/);
});

test('a management bind failure rejects startup and releases the public listener', async (t) => {
  const occupied = createServer();
  occupied.listen(0);
  await new Promise((resolve) => occupied.once('listening', resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  let telemetryClosed = false;
  const runtime = createRuntime({
    runtimeConfig: { environment: 'test', databaseEnabled: false, publicPort: 0, managementPort: occupied.address().port },
    dependencies: { telemetry: { shutdown: async () => { telemetryClosed = true; } }, exit() {} },
  });
  t.after(() => runtime.shutdown());
  await assert.rejects(runtime.start(), /application startup failed/);
  assert.equal(telemetryClosed, true);
});

test('the CI test entry point rejects missing PostgreSQL configuration without printing credentials', () => {
  const env = { ...process.env };
  delete env.DATABASE_TEST_URL;
  const result = spawnSync(process.execPath, ['--import', './test/require-postgres.js', '--eval', ''], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_TEST_URL is required/);
});
