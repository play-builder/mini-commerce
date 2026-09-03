import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import YAML from 'yaml';

const readWorkflow = (name) => YAML.parse(fs.readFileSync(
  new URL(`../.github/workflows/${name}`, import.meta.url),
  'utf8',
));

function assertPinnedActions(workflow) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) {
        assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.uses} must be full-SHA pinned`);
      }
    }
  }
}

test('Dev delivery는 공식 queue를 사용하고 실행 중인 run을 취소하지 않는다', () => {
  const workflow = readWorkflow('ci.yml');
  assert.deepEqual(workflow.concurrency, {
    group: 'dev-delivery-${{ github.ref }}',
    queue: 'max',
    'cancel-in-progress': false,
  });
  assert.equal(Object.hasOwn(workflow.on, 'workflow_dispatch'), true);
  assert.equal(
    workflow['run-name'],
    'dev-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
  );
});

test('CI job permissions와 multi-arch verification 의존성이 최소 권한 계약을 따른다', () => {
  const workflow = readWorkflow('ci.yml');
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.build.permissions, {
    contents: 'read',
    'id-token': 'write',
  });
  assert.deepEqual(workflow.jobs['verify-image-index'].permissions, {
    contents: 'read',
    'id-token': 'write',
  });
  assert.ok(workflow.jobs['verify-image-index'].steps.some((step) => (
    step.uses?.startsWith('aws-actions/configure-aws-credentials@')
  )));
  assert.ok(workflow.jobs['verify-image-index'].steps.some((step) => (
    step.uses?.startsWith('aws-actions/amazon-ecr-login@')
  )));
  assert.deepEqual(workflow.jobs['update-dev-gitops'].permissions, { contents: 'read' });
  assert.equal(workflow.jobs['update-dev-gitops'].needs, 'verify-image-index');
  assert.match(workflow['run-name'], /^dev-\$\{\{ github\.sha \}\}-/);
});

test('PR과 main CI는 실제 PostgreSQL integration test를 실행한다', () => {
  for (const name of ['test.yml', 'ci.yml']) {
    const workflow = readWorkflow(name);
    const job = name === 'test.yml' ? workflow.jobs.test : workflow.jobs.build;
    assert.ok(job.services.postgres);
    assert.ok(job.env.DATABASE_TEST_URL);
    assert.ok(job.steps.some((step) => step.run?.includes('npm test')));
  }
});

test('test와 promotion job은 contents read만 가진다', () => {
  assert.deepEqual(readWorkflow('test.yml').jobs.test.permissions, { contents: 'read' });
  assert.deepEqual(readWorkflow('promote.yml').jobs['promotion-pr'].permissions, { contents: 'read' });
});

test('모든 third-party Action은 full commit SHA로 고정된다', () => {
  for (const name of ['ci.yml', 'test.yml', 'promote.yml']) {
    assertPinnedActions(readWorkflow(name));
  }
});

test('Dev update와 Prod promotion은 application과 migration digest 계약을 사용한다', () => {
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const promotion = fs.readFileSync(new URL('../.github/workflows/promote.yml', import.meta.url), 'utf8');
  assert.match(ci, /Update dev application and migration image digests/);
  assert.match(promotion, /Copy the exact dev application and migration digests to prod/);
});
