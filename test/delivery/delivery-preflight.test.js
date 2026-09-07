import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { validateDeliveryConfiguration } from '../../scripts/delivery-preflight.mjs';

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


test('validation CLIs fail closed through symlink paths containing spaces', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'delivery cli '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, error] of [
    ['delivery-preflight.mjs', /DELIVERY_PREFLIGHT_MODE_REQUIRED/],
    ['verify-supply-chain.mjs', /usage: verify-supply-chain/],
    ['verify-openapi-backward-compatibility.mjs', /OPENAPI_COMPATIBILITY_USAGE/],
    ['verify-commerce-invariants.mjs', /DATABASE_ENABLED=true is required/],
  ]) {
    const link = path.join(directory, name);
    symlinkSync(fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url)), link);
    const result = spawnSync(process.execPath, [link], {
      encoding: 'utf8',
      env: { ...process.env, APP_ENV: 'test', DATABASE_ENABLED: 'false', DATABASE_TEST_URL: '', DATABASE_URL: '' },
    });
    assert.notEqual(result.status, 0, `${name} silently skipped validation`);
    assert.match(result.stderr, error, name);
  }
});
