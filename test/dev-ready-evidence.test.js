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
      workflowRun: fixture('dev-ready', 'workflow-run-ap-northeast-2.json'),
    }, new Date('2026-09-03T00:30:00Z')).region,
    'ap-northeast-2',
  );
  const virginia = fixture('dev-ready', 'us-east-1.json');
  assert.equal(
    verifyDevReadyEvidence(virginia, {
      githubRepository: 'play-builder/cicd-course-sample-app',
      workflowRun: fixture('dev-ready', 'workflow-run-us-east-1.json'),
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
  const workflowRun = fixture('dev-ready', 'workflow-run-ap-northeast-2.json');
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
  const workflowRun = fixture('dev-ready', 'workflow-run-ap-northeast-2.json');
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
    workflowRun: fixture('dev-ready', 'workflow-run-ap-northeast-2.json'),
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
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.workflow.runId = 1234567890; }), expected, new Date('2026-09-03T00:30:00Z')), /invalid workflow.runId/);
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.workflow.runUrl = 'https://attacker.test/actions/runs/1234567890'; }), expected, new Date('2026-09-03T00:30:00Z')), /invalid workflow.runUrl/);
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.image.repository = v.image.repository.replace('ap-northeast-2', 'us-east-1'); }), expected, new Date('2026-09-03T00:30:00Z')), /image repository region mismatch/);
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.attestation.githubUrl = 'https://github.com/attacker/repo/attestations/1234567'; }), expected, new Date('2026-09-03T00:30:00Z')), /invalid attestation.githubUrl/);
  assert.throws(() => verifyDevReadyEvidence(mutate((v) => { v.slo.evidenceId = 'arbitrary'; }), { ...expected, slo: { evidenceId: base.slo.evidenceId } }, new Date('2026-09-03T00:30:00Z')), /slo.evidenceId mismatch/);
});

test('DEV_READY verify는 완료되고 성공한 main CI run만 승인한다', () => {
  const evidence = fixture('dev-ready', 'ap-northeast-2.json');
  const run = fixture('dev-ready', 'workflow-run-ap-northeast-2.json');
  const expected = { githubRepository: 'play-builder/cicd-course-sample-app' };
  for (const [field, value, message] of [
    ['status', 'in_progress', /workflowRun.status must equal completed/],
    ['conclusion', 'failure', /workflowRun.conclusion must equal success/],
    ['head_branch', 'dev', /workflowRun.head_branch must equal main/],
  ]) {
    assert.throws(
      () => verifyDevReadyEvidence(evidence, {
        ...expected,
        workflowRun: { ...run, [field]: value },
      }, new Date('2026-09-03T00:30:00Z')),
      message,
    );
  }
});

test('DEV_READY assemble도 완료되고 성공한 main CI run만 승인한다', () => {
  const input = {
    supplyChain: fixture('supply-chain', 'verified.json'),
    deployment: fixture('dev-evidence', 'deployment.json'),
    slo: fixture('dev-evidence', 'slo.json'),
    githubRepository: 'play-builder/cicd-course-sample-app',
  };
  const run = fixture('dev-ready', 'workflow-run-ap-northeast-2.json');
  for (const [field, value, message] of [
    ['status', 'queued', /workflowRun.status must equal completed/],
    ['conclusion', 'cancelled', /workflowRun.conclusion must equal success/],
    ['head_branch', 'feature/unreviewed', /workflowRun.head_branch must equal main/],
  ]) {
    assert.throws(
      () => assembleDevReadyEvidence({
        ...input,
        workflowRun: { ...run, [field]: value },
      }, new Date('2026-09-03T00:30:00Z')),
      message,
    );
  }
});

test('DEV_READY는 commercial ECR, canonical EKS ARN, UTC timestamp와 numeric attestation ID만 허용한다', () => {
  const base = fixture('dev-ready', 'ap-northeast-2.json');
  const mutate = (callback) => {
    const value = JSON.parse(JSON.stringify(base));
    callback(value);
    return value;
  };
  const now = new Date('2026-09-03T00:30:00Z');

  assert.throws(() => createDevReadyEvidence(mutate((value) => {
    value.image.repository = value.image.repository.replace('.amazonaws.com/', '.amazonaws.com.cn/');
  }), now), /invalid image.repository/);
  for (const clusterArn of [
    'arn:aws-cn:eks:ap-northeast-2:123456789012:cluster/course-dev',
    'arn:aws:eks:ap-northeast-2:123456789012:cluster/course-dev/garbage',
    'arn:aws:eks:ap-northeast-2:123456789012:cluster/course dev',
  ]) {
    assert.throws(() => createDevReadyEvidence(mutate((value) => {
      value.cluster.arn = clusterArn;
    }), now), /invalid cluster.arn/);
  }
  assert.throws(() => createDevReadyEvidence(mutate((value) => {
    value.issuedAt = '2026-09-03';
  }), now), /invalid DEV_READY issuedAt/);
  assert.throws(() => createDevReadyEvidence(mutate((value) => {
    value.expiresAt = '2026-09-04T09:00:00+09:00';
  }), now), /invalid DEV_READY expiresAt/);
  assert.throws(() => createDevReadyEvidence(mutate((value) => {
    value.expiresAt = '2026-02-31T00:00:00Z';
  }), now), /invalid DEV_READY expiresAt/);
  assert.throws(() => createDevReadyEvidence(mutate((value) => {
    value.attestation.githubId = 'attestation-alpha';
  }), now), /invalid attestation.githubId/);
  assert.throws(() => createDevReadyEvidence(mutate((value) => {
    value.workflow.runUrl = 'https://github.com/play-builder/renamed-app/actions/runs/1234567890';
    value.attestation.githubUrl = 'https://github.com/play-builder/renamed-app/attestations/1234567';
  }), now), /invalid workflow.runUrl/);
  assert.throws(() => createDevReadyEvidence(mutate((value) => {
    value.workflow.runUrl = 'https://github.com/play builder/cicd-course-sample-app/actions/runs/1234567890';
    value.attestation.githubUrl = 'https://github.com/play builder/cicd-course-sample-app/attestations/1234567';
  }), now), /invalid workflow.runUrl/);
});
