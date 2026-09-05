import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { selectReferrerDigests, verifySupplyChain } from '../scripts/verify-supply-chain.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/supply-chain/${name}`, import.meta.url),
  'utf8',
));

const legacyFixture = () => {
  const evidence = fixture('verified.json');
  delete evidence.schemaVersion;
  delete evidence.repositoryId;
  delete evidence.repositoryName;
  return evidence;
};

test('검증된 두 platform과 일치하는 attestation/referrer를 승인한다', () => {
  const evidence = fixture('verified.json');
  assert.equal(verifySupplyChain(evidence, {
    allowLegacyRepositoryIdentity: true,
    expectedRepositoryId: '1352247019',
  }).imageDigest, evidence.imageDigest);
});

test('v2 supply-chain evidence requires canonical or explicit repository identity', () => {
  const evidence = {
    ...fixture('verified.json'),
    schemaVersion: 'course.supply-chain/v2',
    repositoryId: '999',
    repositoryName: 'fork-owner/mini-commerce',
  };
  assert.throws(() => verifySupplyChain(evidence), /REPOSITORY_ID_MISMATCH/);
  assert.doesNotThrow(() => verifySupplyChain(evidence, { expectedRepositoryId: '999' }));
  assert.doesNotThrow(() => verifySupplyChain(evidence, {
    workflowRun: {
      id: 1234567890,
      html_url: evidence.runUrl,
      repository: { id: 999 },
    },
  }));
});

test('legacy supply-chain identity requires an explicit canonical cutover allowlist', () => {
  const evidence = legacyFixture();
  assert.throws(() => verifySupplyChain(evidence), /LEGACY_REPOSITORY_IDENTITY_NOT_ALLOWED/);
  assert.doesNotThrow(() => verifySupplyChain(evidence, {
    allowLegacyRepositoryIdentity: true,
    expectedRepositoryId: '1352247019',
  }));
  assert.throws(() => verifySupplyChain(evidence, {
    allowLegacyRepositoryIdentity: true,
    expectedRepositoryId: '999',
  }), /LEGACY_REPOSITORY_IDENTITY_NOT_ALLOWED/);
});

test('unknown supply-chain schemas cannot enter the legacy cutover path', () => {
  const evidence = fixture('verified.json');
  evidence.schemaVersion = 'course.supply-chain/v3';
  assert.throws(() => verifySupplyChain(evidence, {
    allowLegacyRepositoryIdentity: true,
    expectedRepositoryId: '1352247019',
  }), /unsupported supply-chain schemaVersion/);
});

test('다른 workflow identity를 거부한다', () => {
  assert.throws(
    () => verifySupplyChain(fixture('wrong-workflow.json'), {
      allowLegacyRepositoryIdentity: true,
      expectedRepositoryId: '1352247019',
    }),
    /workflow identity mismatch/,
  );
});

test('arm64 scan이 없는 evidence를 거부한다', () => {
  assert.throws(
    () => verifySupplyChain(fixture('missing-arm64-scan.json'), {
      allowLegacyRepositoryIdentity: true,
      expectedRepositoryId: '1352247019',
    }),
    /linux\/arm64 scan is required/,
  );
});

test('공통 artifactType이 아니라 Sigstore predicateType annotation으로 referrer를 구분한다', () => {
  assert.deepEqual(selectReferrerDigests(fixture('ecr-referrers.json').referrers), {
    provenanceDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    sbomDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  });
});
