import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const migrationDirectory = new URL('../migrations/', import.meta.url);

test('v1-compatible release는 초기 migration 한 개로 시작한다', () => {
  const files = fs.readdirSync(migrationDirectory).sort();
  assert.deepEqual(files, ['001_initial_commerce.js']);
});

test('모든 migration은 명시적인 forward-only module이다', async () => {
  const migration = await import(new URL('001_initial_commerce.js', migrationDirectory));
  assert.equal(typeof migration.up, 'function');
  assert.equal(migration.down, false);
});

test('초기 migration은 네 table과 idempotency key, 멱등한 mock seed를 포함한다', () => {
  const source = fs.readFileSync(new URL('001_initial_commerce.js', migrationDirectory), 'utf8');
  for (const table of ['products', 'inventory', 'orders', 'order_items']) {
    assert.match(source, new RegExp(`createTable\\(['\"]${table}['\"]`));
  }
  assert.match(source, /idempotency_key/);
  assert.match(source, /ON CONFLICT/);
});
