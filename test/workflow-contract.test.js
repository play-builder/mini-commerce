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
  assert.equal(workflow.jobs['update-dev-gitops'].needs, 'attest-and-verify');
  assert.match(workflow['run-name'], /^dev-\$\{\{ github\.sha \}\}-/);
});

test('attestation job은 독립 AWS identity와 정확한 GitHub 권한을 가진다', () => {
  const workflow = readWorkflow('ci.yml');
  const job = workflow.jobs['attest-and-verify'];
  assert.deepEqual(job.permissions, {
    contents: 'read',
    'id-token': 'write',
    attestations: 'write',
    packages: 'write',
  });
  const credentials = job.steps.find((step) => (
    step.uses === 'aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c'
  ));
  assert.deepEqual(credentials.with, {
    'role-to-assume': '${{ vars.AWS_ATTEST_VERIFY_ROLE_ARN }}',
    'aws-region': '${{ vars.AWS_REGION }}',
  });
  assert.ok(job.steps.some((step) => (
    step.uses === 'aws-actions/amazon-ecr-login@03f1aad4c6c7ffd436567f42f9384779290529bd'
  )));
  assert.equal(workflow.jobs['update-dev-gitops'].needs, 'attest-and-verify');
  const attestSteps = job.steps.filter((step) => (
    step.uses === 'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6'
  ));
  assert.equal(attestSteps.length, 2);
  assert.equal(attestSteps.filter((step) => step.with['sbom-path']).length, 1);
  assert.ok(job.steps.some((step) => step.run?.includes('npm sbom --omit=dev --sbom-format spdx --sbom-type application')));
  const verification = job.steps.find((step) => step.name === 'Verify GitHub attestation and OCI referrers');
  assert.match(verification.run, /--bundle-from-oci/);
  assert.match(verification.run, /--signer-workflow/);
  assert.match(verification.run, /--source-digest/);
  assert.match(verification.run, /https:\/\/spdx\.dev\/Document\/v2\.3/);
});

test('CI는 canonical DEV_READY를 publish하고 promotion은 같은 artifact를 검증한다', () => {
  const ci = readWorkflow('ci.yml');
  const publish = ci.jobs['publish-dev-ready'];
  assert.deepEqual(publish.needs, ['attest-and-verify', 'update-dev-gitops']);
  assert.deepEqual(publish.permissions, { actions: 'read', contents: 'read' });
  assert.ok(publish.steps.some((step) => step.run?.includes('dev-ready-evidence.mjs from-supply')));
  assert.ok(publish.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@')));

  const promote = readWorkflow('promote.yml');
  assert.equal(promote.on.workflow_dispatch.inputs.dev_ready_run_id.required, true);
  assert.deepEqual(promote.jobs['promotion-pr'].permissions, { actions: 'read', contents: 'read' });
  assert.ok(promote.jobs['promotion-pr'].steps.some((step) => (
    step.run?.includes('dev-ready-evidence.mjs verify')
  )));
  assert.ok(promote.jobs['promotion-pr'].steps.some((step) => (
    step.run?.includes('DEV_READY_DIGEST')
  )));
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
  assert.deepEqual(readWorkflow('promote.yml').jobs['promotion-pr'].permissions, {
    actions: 'read',
    contents: 'read',
  });
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
