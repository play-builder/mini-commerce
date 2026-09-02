import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InsufficientStockError,
  ValidationError,
  createCommerceService,
} from '../src/commerce-service.js';

function createRepository(overrides = {}) {
  const calls = [];
  const transaction = {
    async advisoryLock(key) {
      calls.push(['advisoryLock', key]);
    },
    async findOrderByIdempotencyKey(key) {
      calls.push(['findOrderByIdempotencyKey', key]);
      return null;
    },
    async lockInventory(productIds) {
      calls.push(['lockInventory', productIds]);
      return [
        { productId: 1, sku: 'COURSE-LAPTOP', name: 'Course Laptop', priceCents: 129900, availableQuantity: 5 },
        { productId: 2, sku: 'COURSE-MOUSE', name: 'Course Mouse', priceCents: 3900, availableQuantity: 10 },
      ].filter((item) => productIds.includes(item.productId));
    },
    async insertOrder(input) {
      calls.push(['insertOrder', input]);
      return { id: 77, status: 'CONFIRMED', ...input };
    },
    async insertOrderItem(input) {
      calls.push(['insertOrderItem', input]);
    },
    async decrementInventory(productId, quantity) {
      calls.push(['decrementInventory', productId, quantity]);
    },
    ...overrides.transaction,
  };

  return {
    calls,
    async listProducts() {
      return [{ id: 1, sku: 'COURSE-LAPTOP' }];
    },
    async getInventory(productId) {
      return { productId, availableQuantity: 5 };
    },
    async isReady() {
      return true;
    },
    async withTransaction(callback) {
      calls.push('BEGIN');
      const result = await callback(transaction);
      calls.push('COMMIT');
      return result;
    },
    ...overrides.repository,
  };
}

test('상품 조회와 재고 조회를 repository에 위임한다', async () => {
  const repository = createRepository();
  const service = createCommerceService(repository);

  assert.equal((await service.listProducts())[0].sku, 'COURSE-LAPTOP');
  assert.deepEqual(await service.getInventory(1), { productId: 1, availableQuantity: 5 });
});

test('주문은 멱등성 lock과 재고 row lock을 잡고 하나의 transaction으로 저장한다', async () => {
  const repository = createRepository();
  const service = createCommerceService(repository);

  const order = await service.createOrder({
    idempotencyKey: 'lesson-order-001',
    items: [
      { productId: 2, quantity: 1 },
      { productId: 1, quantity: 2 },
      { productId: 1, quantity: 1 },
    ],
  });

  assert.equal(order.id, 77);
  assert.equal(order.totalCents, 393600);
  assert.deepEqual(order.items, [
    { productId: 1, sku: 'COURSE-LAPTOP', name: 'Course Laptop', unitPriceCents: 129900, quantity: 3 },
    { productId: 2, sku: 'COURSE-MOUSE', name: 'Course Mouse', unitPriceCents: 3900, quantity: 1 },
  ]);
  assert.deepEqual(repository.calls.slice(0, 4), [
    'BEGIN',
    ['advisoryLock', 'lesson-order-001'],
    ['findOrderByIdempotencyKey', 'lesson-order-001'],
    ['lockInventory', [1, 2]],
  ]);
  assert.equal(repository.calls.at(-1), 'COMMIT');
});

test('같은 Idempotency-Key 주문은 재고를 다시 차감하지 않고 기존 주문을 반환한다', async () => {
  const existing = { id: 12, status: 'CONFIRMED', totalCents: 129900, items: [] };
  const repository = createRepository({
    transaction: {
      async findOrderByIdempotencyKey() {
        return existing;
      },
    },
  });
  const service = createCommerceService(repository);

  assert.equal(await service.createOrder({
    idempotencyKey: 'lesson-order-existing',
    items: [{ productId: 1, quantity: 1 }],
  }), existing);
  assert.ok(!repository.calls.some((call) => Array.isArray(call) && call[0] === 'decrementInventory'));
});

test('재고가 부족하면 주문 전체를 거부한다', async () => {
  const repository = createRepository({
    transaction: {
      async lockInventory() {
        return [{ productId: 1, sku: 'COURSE-LAPTOP', name: 'Course Laptop', priceCents: 129900, availableQuantity: 1 }];
      },
    },
  });
  const service = createCommerceService(repository);

  await assert.rejects(
    service.createOrder({
      idempotencyKey: 'lesson-order-no-stock',
      items: [{ productId: 1, quantity: 2 }],
    }),
    InsufficientStockError,
  );
});

test('잘못된 상품 ID, 수량, 멱등성 key를 주문 전에 거부한다', async () => {
  const service = createCommerceService(createRepository());

  await assert.rejects(
    service.createOrder({ idempotencyKey: '', items: [{ productId: 1, quantity: 1 }] }),
    ValidationError,
  );
  await assert.rejects(
    service.createOrder({ idempotencyKey: 'bad-order', items: [{ productId: 1, quantity: 0 }] }),
    ValidationError,
  );
  assert.throws(() => service.getInventory('abc'), ValidationError);
});
