/* global __ENV */

import http from 'k6/http';
import { check, fail } from 'k6';

import { readLoadConfig } from '../scripts/load-config.mjs';

const config = readLoadConfig(__ENV);

export const options = {
  scenarios: {
    dev_baseline: {
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
  // Every business route is DB-backed and answers 503 while the database is disabled,
  // so abort before the run instead of reporting the precondition as a latency regression.
  const response = http.get(`${config.targetUrl}/products`);
  if (response.status !== 200) {
    fail(`Baseline load precondition failed: GET /products returned ${response.status} ${response.body}`);
  }
}

export default function baselineTraffic() {
  // The application serves no `/`; the catalog listing is the cheapest DB-backed read path.
  const response = http.get(`${config.targetUrl}/products`, {
    tags: { operation: 'list-products' },
  });
  check(response, {
    'product list status is 200': (result) => result.status === 200,
  });
}
