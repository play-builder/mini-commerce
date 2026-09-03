import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../src/routes.js';
import { markReady } from '../src/state.js';

test('DB readiness 실패는 driver 오류를 숨기고 고정된 503 응답을 반환한다', async (t) => {
  markReady();
  const commerceService = {
    async isReady() {
      throw new Error('connection refused');
    },
  };
  const server = createApp({ databaseEnabled: true, commerceService }).listen(0);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/readyz`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: 'not ready',
    reason: 'database unavailable',
  });
});
