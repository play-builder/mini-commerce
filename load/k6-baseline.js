/* global __ENV */

import http from 'k6/http';
import { check } from 'k6';

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
  },
};

export default function baselineTraffic() {
  const response = http.get(`${config.targetUrl}/products`, {
    tags: { operation: 'list-products' },
  });
  check(response, {
    'products status is 200': (result) => result.status === 200,
  });
}
