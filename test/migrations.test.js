import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const migrationDirectory = new URL('../migrations/', import.meta.url);

test('v2prime release는 순서가 고정된 Expand와 Contract migration을 포함한다', () => {
  const files = fs.readdirSync(migrationDirectory).sort();
  assert.deepEqual(files, [
    '001_initial_commerce.js',
    '002_expand_product_display_name.js',
    '003_contract_product_name.js',
  ]);
});

test('모든 migration은 명시적인 forward-only module이다', async () => {
  for (const filename of [
    '001_initial_commerce.js',
    '002_expand_product_display_name.js',
    '003_contract_product_name.js',
  ]) {
    const migration = await import(new URL(filename, migrationDirectory));
    assert.equal(typeof migration.up, 'function');
    assert.equal(migration.down, false);
  }
});

test('Contract migration은 null gate 뒤에 legacy name을 제거한다', () => {
  const source = fs.readFileSync(new URL('003_contract_product_name.js', migrationDirectory), 'utf8');
  assert.match(source, /CONTRACT_003_NULL_DISPLAY_NAME/);
  assert.match(source, /display_name IS NULL/);
  assert.match(source, /dropColumn\(['"]products['"], ['"]name['"]\)/);
});

test('초기 migration은 네 table과 idempotency key, 멱등한 mock seed를 포함한다', () => {
  const source = fs.readFileSync(new URL('001_initial_commerce.js', migrationDirectory), 'utf8');
  for (const table of ['products', 'inventory', 'orders', 'order_items']) {
    assert.match(source, new RegExp(`createTable\\(['\"]${table}['\"]`));
  }
  assert.match(source, /idempotency_key/);
  assert.match(source, /ON CONFLICT/);
});

test('Expand migration은 기존 name을 제거하지 않고 display_name을 backfill한다', () => {
  const source = fs.readFileSync(new URL('002_expand_product_display_name.js', migrationDirectory), 'utf8');
  assert.match(source, /display_name/);
  assert.match(source, /UPDATE products/);
  assert.doesNotMatch(source, /dropColumn|DROP COLUMN|renameColumn/);
});
