#!/usr/bin/env node
import { createPrivateKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Validate only configuration shape. This cannot prove IAM, region availability,
// environment protection, or GitHub App installation/permission correctness.
export function validateDeliveryConfiguration(mode, env = process.env) {
  const invalid = [];
  const check = (name, valid) => {
    if (!valid(env[name] ?? '')) invalid.push(name);
  };
  if (mode === 'registry') {
    check('AWS_REGION', (value) => /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(value));
    for (const name of ['AWS_ROLE_ARN', 'AWS_ATTEST_VERIFY_ROLE_ARN']) {
      check(name, (value) => /^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(value));
    }
    check('ECR_REPOSITORY', (value) => value.length >= 2 && value.length <= 256
      && /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/.test(value));
  } else if (mode === 'gitops') {
    check('GITOPS_APP_ID', (value) => /^[1-9]\d*$/.test(value));
    check('GITOPS_OWNER', (value) => value.length <= 39 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(value));
    check('GITOPS_REPOSITORY_NAME', (value) => value.length <= 100 && value !== '.' && value !== '..'
      && /^[a-z\d._-]+$/i.test(value));
    check('GITOPS_APP_PRIVATE_KEY', (value) => {
      try { return createPrivateKey(value).asymmetricKeyType === 'rsa'; } catch { return false; }
    });
  } else {
    throw new Error('DELIVERY_PREFLIGHT_MODE_REQUIRED: use registry or gitops');
  }
  if (invalid.length) {
    // Never include values: this error may be written to public workflow logs.
    throw new Error(`DELIVERY_CONFIGURATION_INVALID: ${invalid.join(', ')}; configure the repository variables or selected environment secret before retrying`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateDeliveryConfiguration(process.argv[2]);
    console.log('Delivery configuration shape verified; remote permissions still require the live workflow.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
