import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

import { validateDeliveryConfiguration } from '../scripts/delivery-preflight.mjs';

const registry = {
  AWS_REGION: 'ap-northeast-2',
  AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/image-push',
  AWS_ATTEST_VERIFY_ROLE_ARN: 'arn:aws:iam::123456789012:role/attestation',
  ECR_REPOSITORY: 'platform/mini-commerce',
};

test('registry preflight enumerates missing variables and accepts explicit region/role/repository configuration', () => {
  assert.doesNotThrow(() => validateDeliveryConfiguration('registry', registry));
  assert.throws(() => validateDeliveryConfiguration('registry', {}), /AWS_REGION, AWS_ROLE_ARN, AWS_ATTEST_VERIFY_ROLE_ARN, ECR_REPOSITORY/);
  for (const name of Object.keys(registry)) {
    assert.throws(() => validateDeliveryConfiguration('registry', { ...registry, [name]: 'unsafe-value\n$(command)' }), (error) => {
      assert.ok(error.message.includes(name));
      assert.ok(!error.message.includes('unsafe-value'));
      return true;
    });
  }
});

test('GitOps preflight requires an RSA App key without logging its PEM or the supplied value', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GITOPS_APP_ID: '12345', GITOPS_OWNER: 'play-builder', GITOPS_REPOSITORY_NAME: 'argocd-gitops',
    GITOPS_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  assert.doesNotThrow(() => validateDeliveryConfiguration('gitops', env));
  assert.throws(() => validateDeliveryConfiguration('gitops', { ...env, GITOPS_APP_PRIVATE_KEY: 'secret-invalid-key' }), (error) => {
    assert.match(error.message, /GITOPS_APP_PRIVATE_KEY/);
    assert.doesNotMatch(error.message, /secret-invalid-key/);
    return true;
  });
});

test('workflow executes registry preflight with read-only permissions before any build and names the missing field', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs['delivery-preflight'];
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.build.needs, 'delivery-preflight');
  const step = job.steps.find((item) => item.run?.includes('delivery-preflight'));
  assert.equal(step.env.AWS_REGION, '${{ vars.AWS_REGION }}');
  const result = spawnSync('bash', ['-e', '-c', step.run], { env: { ...process.env, ...registry, AWS_REGION: '' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_CONFIGURATION_INVALID: AWS_REGION;/);
});

test('GitOps credential validation precedes App token creation in both protected environments', () => {
  for (const file of ['ci.yml', 'promote.yml']) {
    const workflow = YAML.parse(fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
    const job = workflow.jobs[file === 'ci.yml' ? 'update-dev-gitops' : 'promotion-pr'];
    const validation = job.steps.findIndex((step) => step.run?.includes('delivery-preflight'));
    const credentials = job.steps.findIndex((step) => step.uses?.startsWith('actions/create-github-app-token@'));
    assert.ok(validation >= 0 && validation < credentials);
    assert.equal(job.steps[validation].env.GITOPS_APP_PRIVATE_KEY, '${{ secrets.GITOPS_APP_PRIVATE_KEY }}');
  }
});


test('cross-architecture builds configure pinned ARM64 emulation before Buildx', () => {
  const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const lock = YAML.parse(fs.readFileSync(new URL('../versions.lock.yaml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.build.steps;
  const qemu = steps.findIndex((step) => step.uses?.startsWith('docker/setup-qemu-action@'));
  const buildx = steps.findIndex((step) => step.uses?.startsWith('docker/setup-buildx-action@'));
  assert.ok(qemu >= 0 && qemu < buildx);
  assert.equal(steps[qemu].uses, `docker/setup-qemu-action@${lock.delivery.qemuActionSha}`);
  assert.equal(steps[qemu].with.image, `docker.io/tonistiigi/binfmt@${lock.delivery.binfmtImageIndexDigest}`);
  assert.equal(steps[qemu].with.platforms, 'arm64');
});
