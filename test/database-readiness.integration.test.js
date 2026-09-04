import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createManagement } from '../src/management.js';
import { createReadiness } from '../src/readiness.js';

test('startup-only readiness remains ready after a post-ready database failure', async (t) => {
  const readiness = createReadiness({ dependencyPolicy: 'startup-only', checkDependency: async () => true });
  await readiness.initialize();
  readiness.recordDependencyFailure();
  const server = createManagement({ readiness, metrics: { contentType: 'text/plain', metrics: async () => '' }, build: {} }).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/readyz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready' });
});
