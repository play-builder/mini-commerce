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
  for (const step of attestSteps) {
    assert.equal(step.with['create-storage-record'], false);
  }
  assert.ok(job.steps.some((step) => step.run?.includes('npm sbom --omit=dev --sbom-format spdx --sbom-type application')));
  const verification = job.steps.find((step) => step.name === 'Verify GitHub attestation and OCI referrers');
  const verifyCommands = verification.run
    .split('\n')
    .filter((line) => line.trim().startsWith('gh attestation verify'));
  assert.equal(verifyCommands.length, 2);
  for (const command of verifyCommands) {
    assert.match(command, /--bundle-from-oci/);
    assert.match(command, /--signer-workflow/);
    assert.match(command, /--source-digest/);
  }
  assert.ok(verifyCommands.some((command) => (
    command.includes('--predicate-type "https://slsa.dev/provenance/v1"')
  )));
  assert.ok(verifyCommands.some((command) => (
    command.includes('--predicate-type "https://spdx.dev/Document/v2.3"')
  )));
});

test('DEV_READY 게시와 baseline 이후 candidate 승격은 독립 실행 모드다', () => {
  const ci = readWorkflow('ci.yml');
  assert.equal(Object.hasOwn(ci.jobs, 'publish-dev-ready'), false);

  const promote = readWorkflow('promote.yml');
  assert.deepEqual(promote.on.workflow_dispatch.inputs.operation, {
    description: 'Publish DEV_READY evidence or open a production candidate PR',
    required: true,
    type: 'choice',
    options: ['publish-dev-ready', 'promote-candidate'],
  });
  assert.equal(promote.on.workflow_dispatch.inputs.dev_ready_run_id.required, true);
  assert.equal(promote.jobs['promotion-pr'].if, "${{ github.ref == 'refs/heads/main' }}");
  assert.equal(promote.jobs['promotion-pr'].environment, 'gitops-production');
  assert.deepEqual(promote.jobs['promotion-pr'].permissions, { actions: 'read', contents: 'read' });
  const steps = promote.jobs['promotion-pr'].steps;
  const gitopsCheckoutIndex = steps.findIndex((step) => step.name === 'Checkout GitOps repository');
  const assemblyIndex = steps.findIndex((step) => step.run?.includes('dev-ready-evidence.mjs assemble'));
  assert.ok(gitopsCheckoutIndex >= 0 && gitopsCheckoutIndex < assemblyIndex);

  const assembly = steps[assemblyIndex];
  assert.match(assembly.run, /evidence\/canonical-dev-ready\.json/);
  assert.doesNotMatch(assembly.run, /assemble[\s\S]*gitops\/envs\/prod\/promotion-evidence\.yaml/);
  assert.match(assembly.run, /repository=/);
  assert.match(assembly.run, /digest=/);

  const publish = steps.find((step) => step.name === 'Publish canonical DEV_READY evidence');
  assert.equal(publish.if, "inputs.operation == 'publish-dev-ready'");
  assert.match(publish.run, /cmp --silent evidence\/canonical-dev-ready\.json gitops\/envs\/prod\/promotion-evidence\.yaml/);
  assert.match(publish.run, /cp evidence\/canonical-dev-ready\.json gitops\/envs\/prod\/promotion-evidence\.yaml/);
  assert.match(publish.run, /git -C gitops add envs\/prod\/promotion-evidence\.yaml/);
  assert.doesNotMatch(publish.run, /envs\/prod\/values\.yaml/);

  const publishPr = steps.find((step) => step.name === 'Open DEV_READY evidence PR');
  assert.equal(
    publishPr.if,
    "inputs.operation == 'publish-dev-ready' && steps.publish.outputs.changed == 'true'",
  );

  const bindPublished = steps.find((step) => step.name === 'Bind published DEV_READY to selected runtime evidence');
  assert.equal(bindPublished.if, "inputs.operation == 'promote-candidate'");
  assert.match(bindPublished.run, /cmp --silent evidence\/canonical-dev-ready\.json gitops\/envs\/prod\/promotion-evidence\.yaml/);

  const baseline = steps.find((step) => step.name === 'Verify candidate differs from recorded Prod baseline');
  assert.equal(baseline.if, "inputs.operation == 'promote-candidate'");
  assert.match(baseline.run, /evidence\/prod\/baseline\.json/);

  const update = steps.find((step) => step.name === 'Copy the exact dev application and migration digests to prod');
  assert.equal(update.if, "inputs.operation == 'promote-candidate'");
  assert.match(update.run, /"\$DEV_READY_REPOSITORY"/);
  assert.match(update.run, /"\$DEV_READY_DIGEST"/);
  assert.match(update.run, /git -C gitops diff --quiet -- envs\/prod\/values\.yaml/);
  assert.doesNotMatch(update.run, /promotion-evidence\.yaml/);

  const promotion = steps.find((step) => step.name === 'Commit production candidate');
  assert.equal(promotion.if, "inputs.operation == 'promote-candidate' && steps.update.outputs.changed == 'true'");
  assert.match(promotion.run, /git -C gitops add envs\/prod\/values\.yaml/);
  assert.doesNotMatch(promotion.run, /promotion-evidence\.yaml/);

  const promotionPr = steps.find((step) => step.name === 'Open production approval PR');
  assert.equal(
    promotionPr.if,
    "inputs.operation == 'promote-candidate' && steps.update.outputs.changed == 'true'",
  );
  assert.match(promotionPr.run, /Merging this PR changes Git desired state only; it does not deploy by itself/);
  assert.match(promotionPr.run, /authorized operator must run Argo CD Sync to start the production Canary/);
  assert.doesNotMatch(promotionPr.run, /Merge starts the production Canary/);
});

test('README는 production promotion secret과 environment protection 경계를 안내한다', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /gitops-dev-delivery environment secret/);
  assert.match(readme, /gitops-production environment secret/);
  assert.match(readme, /두 environment[^\n]*deployment branch[^\n]*main/);
  assert.match(readme, /required reviewer/);
  assert.match(readme, /gh secret set GITOPS_APP_PRIVATE_KEY --env gitops-dev-delivery/);
  assert.match(readme, /gh secret set GITOPS_APP_PRIVATE_KEY --env gitops-production/);
  assert.match(readme, /별도 GitHub App/);
});

test('Dev와 Prod GitOps credential은 main-only environment 경계를 사용한다', () => {
  const ciJob = readWorkflow('ci.yml').jobs['update-dev-gitops'];
  assert.equal(ciJob.if, "${{ github.ref == 'refs/heads/main' }}");
  assert.equal(ciJob.environment, 'gitops-dev-delivery');

  const promotionJob = readWorkflow('promote.yml').jobs['promotion-pr'];
  assert.equal(promotionJob.if, "${{ github.ref == 'refs/heads/main' }}");
  assert.equal(promotionJob.environment, 'gitops-production');
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

test('dependency review is a read-only pinned pull-request gate', () => {
  const workflow = readWorkflow('dependency-review.yml');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(
    workflow.jobs['dependency-review'].steps[0].uses,
    'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294',
  );
});

test('Dev update와 Prod promotion은 application과 migration digest 계약을 사용한다', () => {
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const promotion = fs.readFileSync(new URL('../.github/workflows/promote.yml', import.meta.url), 'utf8');
  assert.match(ci, /Update dev application and migration image digests/);
  assert.match(promotion, /Copy the exact dev application and migration digests to prod/);
});
