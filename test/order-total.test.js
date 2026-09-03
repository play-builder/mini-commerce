import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calculateOrderTotal } from '../src/commerce-service.js';

test('bulk quantity를 단가에 모두 곱해 주문 합계를 계산한다', () => {
  assert.equal(calculateOrderTotal([
    { unitPriceCents: 129900, quantity: 4 },
    { unitPriceCents: 3900, quantity: 1 },
  ]), 523500);
});
