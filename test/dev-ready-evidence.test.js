import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  createDevReadyFromSupplyChain,
  createDevReadyEvidence,
  verifyDevReadyEvidence,
  verifyProdBaselineEvidence,
} from '../scripts/dev-ready-evidence.mjs';

const fixture = (directory, name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/${directory}/${name}`, import.meta.url),
  'utf8',
));

test('Seoul과 Virginia DEV_READY evidence를 같은 canonical schema로 승인한다', () => {
  assert.equal(
    verifyDevReadyEvidence(fixture('dev-ready', 'ap-northeast-2.json'), new Date('2026-09-03T00:30:00Z')).region,
    'ap-northeast-2',
  );
  assert.equal(
    verifyDevReadyEvidence(fixture('dev-ready', 'us-east-1.json'), new Date('2026-09-03T01:30:00Z')).region,
    'us-east-1',
  );
});

test('만료된 evidence를 거부한다', () => {
  assert.throws(
    () => createDevReadyEvidence(
      fixture('dev-ready', 'expired-ap-northeast-2.json'),
      new Date('2026-09-03T00:00:00Z'),
    ),
    /expired DEV_READY evidence/,
  );
});

test('nested workflow.runId를 root로 평탄화한 schema drift를 거부한다', () => {
  const evidence = fixture('dev-ready', 'ap-northeast-2.json');
  evidence.runId = evidence.workflow.runId;
  assert.throws(
    () => createDevReadyEvidence(evidence, new Date('2026-09-03T00:30:00Z')),
    /unexpected root key runId/,
  );
});

test('Prod baseline과 같은 candidate digest를 거부한다', () => {
  const baseline = fixture('prod-baseline', 'healthy-revision-1.json');
  assert.throws(() => verifyProdBaselineEvidence({
    prodBaselineDigest: baseline.imageDigest,
    candidateDigest: baseline.imageDigest,
  }), /CANDIDATE_DIGEST_MUST_DIFFER_FROM_PROD_BASELINE/);
});

test('내부 supply-chain artifact를 canonical DEV_READY root schema로만 매핑한다', () => {
  const supplyChain = fixture('supply-chain', 'verified.json');
  const evidence = createDevReadyFromSupplyChain(supplyChain, {
    region: 'ap-northeast-2',
    devRevision: 'fedcba9876543210fedcba9876543210fedcba98',
    clusterArn: 'arn:aws:eks:ap-northeast-2:123456789012:cluster/course-dev',
    sloEvidenceId: 'dev-slo-20260903T000000Z',
    issuedAt: '2026-09-03T00:00:00Z',
    expiresAt: '2026-09-03T02:00:00Z',
  }, new Date('2026-09-03T00:30:00Z'));
  assert.deepEqual(Object.keys(evidence), [
    'schemaVersion', 'environment', 'region', 'sourceSha', 'workflow', 'image',
    'attestation', 'gitops', 'cluster', 'slo', 'issuedAt', 'expiresAt',
  ]);
  assert.equal(Object.hasOwn(evidence, 'supplyChainEvidence'), false);
  assert.equal(evidence.workflow.runId, supplyChain.runId);
  assert.equal(evidence.image.indexDigest, supplyChain.imageDigest);
});
