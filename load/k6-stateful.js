/* global __ENV, __ITER */

import http from 'k6/http';
import { check, fail } from 'k6';

import { readStatefulLoadConfig } from '../scripts/load-config.mjs';

const config = readStatefulLoadConfig(__ENV);
if (__ENV.STATEFUL_LOAD_APPROVED !== 'true') {
  throw new Error('STATEFUL_LOAD_APPROVED=true is required');
}

// Inventory exhaustion is an expected, observable conflict in the bounded
// stateful scenario. Keep it out of k6's generic failed-response rate while
// still asserting the response and its error contract below.
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    dev_stateful_orders: {
      executor: 'constant-arrival-rate',
      rate: config.ratePerSecond,
      timeUnit: '1s',
      duration: `${config.durationSeconds}s`,
      preAllocatedVUs: 2,
      maxVUs: 10,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate==1'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  const response = http.get(`${config.targetUrl}/db/status`);
  if (response.status !== 200) fail('Stateful load requires an enabled and ready database');
}

export default function statefulOrderTraffic() {
  const products = http.get(`${config.targetUrl}/products`, {
    tags: { operation: 'list-products' },
  });
  const inventory = http.get(`${config.targetUrl}/products/${config.productId}/inventory`, {
    tags: { operation: 'get-inventory' },
  });
  const response = http.post(`${config.targetUrl}/orders`, JSON.stringify({
    items: [{ productId: config.productId, quantity: 1 }],
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `ch25-${config.runId}-${__ITER % config.maxUniqueOrders}`,
    },
    tags: { operation: 'create-order' },
  });
  check(products, { 'product list status is 200': (result) => result.status === 200 });
  check(inventory, { 'inventory status is 200': (result) => result.status === 200 });
  check(response, {
    // A bounded stateful run may legitimately race on stock and return 409;
    // keep that outcome visible while distinguishing it from server failures.
    'order status is 201 or expected 409': (result) => result.status === 201
      || (result.status === 409 && /insufficient stock/.test(result.body)),
  });
}
