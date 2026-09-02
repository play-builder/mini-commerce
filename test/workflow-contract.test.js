import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const readWorkflow = (name) => fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

test('Dev delivery는 실행을 취소하지 않고 FIFO queue에 보존한다', () => {
  const workflow = readWorkflow('ci.yml');
  assert.match(workflow, /concurrency:\n  group: dev-delivery\n  queue: max\n  cancel-in-progress: false/);
});

test('PR과 main CI는 실제 PostgreSQL integration test를 실행한다', () => {
  for (const name of ['test.yml', 'ci.yml']) {
    const workflow = readWorkflow(name);
    assert.match(workflow, /services:\n\s+postgres:/);
    assert.match(workflow, /DATABASE_TEST_URL:/);
    assert.match(workflow, /npm test/);
  }
});

test('Dev update와 Prod promotion은 application과 migration digest 계약을 사용한다', () => {
  assert.match(readWorkflow('ci.yml'), /Update dev application and migration image digests/);
  assert.match(readWorkflow('promote.yml'), /Copy the exact dev application and migration digests to prod/);
});
