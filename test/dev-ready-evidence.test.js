import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  assembleDevReadyEvidence,
  createDevReadyEvidence,
  verifyDevReadyEvidence,
  verifyProdBaselineEvidence,
} from '../scripts/dev-ready-evidence.mjs';

const fixture = (directory, name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/${directory}/${name}`, import.meta.url),
  'utf8',
));

test('Seoul과 Virginia DEV_READY evidence를 같은 canonical schema로 승인한다', () => {
  const seoul = fixture('dev-ready', 'ap-northeast-2.json');
  assert.equal(
    verifyDevReadyEvidence(seoul, {
      githubRepository: 'play-builder/cicd-course-sample-app',
      workflowRun: {
        id: 1234567890, run_attempt: 1, html_url: seoul.workflow.runUrl,
        head_sha: seoul.sourceSha, event: 'push', name: 'ci',
      },
    }, new Date('2026-09-03T00:30:00Z')).region,
    'ap-northeast-2',
  );
  const virginia = fixture('dev-ready', 'us-east-1.json');
  assert.equal(
    verifyDevReadyEvidence(virginia, {
      githubRepository: 'play-builder/cicd-course-sample-app',
      workflowRun: {
        id: 2234567890, run_attempt: 2, html_url: virginia.workflow.runUrl,
        head_sha: virginia.sourceSha, event: 'push', name: 'ci',
      },
    }, new Date('2026-09-03T01:30:00Z')).region,
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
  const candidate = fixture('dev-ready', 'ap-northeast-2.json');
  candidate.image.indexDigest = baseline.image.indexDigest;
  assert.throws(() => verifyProdBaselineEvidence({
    prodBaseline: baseline,
    candidateEvidence: candidate,
  }, new Date('2026-09-03T00:30:00Z')), /CANDIDATE_DIGEST_MUST_DIFFER_FROM_PROD_BASELINE/);
  assert.throws(() => verifyProdBaselineEvidence({
    prodBaseline: { ...baseline, evidenceGrade: 'STATIC' },
    candidateEvidence: fixture('dev-ready', 'ap-northeast-2.json'),
  }, new Date('2026-09-03T00:30:00Z')), /Prod baseline evidenceGrade must equal CLOUD_RUNTIME/);
  const sameCluster = fixture('prod-baseline', 'healthy-revision-1.json');
  const distinctCandidate = fixture('dev-ready', 'ap-northeast-2.json');
  sameCluster.clusterArn = distinctCandidate.cluster.arn;
  assert.throws(() => verifyProdBaselineEvidence({
    prodBaseline: sameCluster,
    candidateEvidence: distinctCandidate,
  }, new Date('2026-09-03T00:30:00Z')), /PROD_CLUSTER_MUST_DIFFER_FROM_DEV_CLUSTER/);
});

test('supply-chain, Dev deployment, SLO 세 증거가 일치할 때만 DEV_READY를 조립한다', () => {
  const supplyChain = fixture('supply-chain', 'verified.json');
  const deployment = fixture('dev-evidence', 'deployment.json');
  const slo = fixture('dev-evidence', 'slo.json');
  const workflowRun = {
    id: 1234567890,
    run_attempt: 1,
    html_url: supplyChain.runUrl,
    head_sha: supplyChain.sourceSha,
    event: 'push',
    name: 'ci',
  };
  const evidence = assembleDevReadyEvidence({
    supplyChain,
    deployment,
    slo,
    workflowRun,
    githubRepository: 'play-builder/cicd-course-sample-app',
  }, new Date('2026-09-03T00:30:00Z'));
  assert.deepEqual(Object.keys(evidence), [
    'schemaVersion', 'environment', 'region', 'sourceSha', 'workflow', 'image',
    'attestation', 'gitops', 'cluster', 'slo', 'issuedAt', 'expiresAt',
  ]);
  assert.equal(Object.hasOwn(evidence, 'supplyChainEvidence'), false);
  assert.equal(evidence.workflow.runId, supplyChain.runId);
  assert.equal(evidence.image.indexDigest, supplyChain.imageDigest);
  assert.equal(evidence.issuedAt, slo.observedAt);
  assert.equal(evidence.expiresAt, slo.expiresAt);
});

test('raw runtime evidence의 identity 또는 grade가 다르면 assembly를 거부한다', () => {
  const supplyChain = fixture('supply-chain', 'verified.json');
  const deployment = fixture('dev-evidence', 'deployment.json');
  const slo = fixture('dev-evidence', 'slo.json');
  const workflowRun = {
    id: 1234567890, run_attempt: 1, html_url: supplyChain.runUrl,
    head_sha: supplyChain.sourceSha, event: 'push', name: 'ci',
  };
  const input = {
    supplyChain, deployment, slo, workflowRun,
    githubRepository: 'play-builder/cicd-course-sample-app',
  };
  assert.throws(
    () => assembleDevReadyEvidence({ ...input, deployment: { ...deployment, evidenceGrade: 'STATIC' } }),
    /deployment evidenceGrade must equal CLOUD_RUNTIME/,
  );
  assert.throws(
    () => assembleDevReadyEvidence({ ...input, slo: { ...slo, gitopsRevision: '1'.repeat(40) } }),
    /gitopsRevision mismatch/,
  );
});

test('future issue, wrong workflow identity, URL, cross-region, attestation, SLO mismatch를 거부한다', () => {
  const base = fixture('dev-ready', 'ap-northeast-2.json');
  const expected = {
    githubRepository: 'play-builder/cicd-course-sample-app',
    workflowRun: {
      id: 1234567890, run_attempt: 1, html_url: base.workflow.runUrl,
      head_sha: base.sourceSha, event: 'push', name: 'ci',
    },
  };
  const mutate = (callback) => {
    const value = JSON.parse(JSON.stringify(base));
    callback(value);
    return value;
  };
  assert.throws(() => verifyDevReadyEvidence(
    fixture('dev-ready', 'future-issued-at.json'), expected, new Date('2026-09-03T00:30:00Z'),
  ), /future issuedAt/);
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.workflow.event = 'workflow_dispatch'; }), expected, new Date('2026-09-03T00:30:00Z')), /workflow.event must equal push/);
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.workflow.runUrl = 'https://attacker.test/actions/runs/1234567890'; }), expected, new Date('2026-09-03T00:30:00Z')), /workflow.runUrl mismatch/);
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.image.repository = v.image.repository.replace('ap-northeast-2', 'us-east-1'); }), expected, new Date('2026-09-03T00:30:00Z')), /image repository region mismatch/);
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.attestation.githubUrl = 'https://github.com/attacker/repo/attestations/1234567'; }), expected, new Date('2026-09-03T00:30:00Z')), /attestation.githubUrl mismatch/);
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.slo.evidenceId = 'arbitrary'; }), { ...expected, slo: { evidenceId: base.slo.evidenceId } }, new Date('2026-09-03T00:30:00Z')), /slo.evidenceId mismatch/);
});
