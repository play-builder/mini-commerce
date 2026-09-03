import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';

import {
  exportReleaseEvidence,
  exportReleaseEvidenceFiles,
  validateReleaseEvidenceFixture,
} from '../scripts/export-release-evidence.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/release-evidence/${name}`, import.meta.url),
  'utf8',
));

const now = new Date('2026-09-03T04:30:00Z');
const readSource = (path) => fs.readFileSync(new URL(`./fixtures/${path}`, import.meta.url));
const rawSha256 = (source) => crypto.createHash('sha256').update(source).digest('hex');
const upstreamSources = {
  devReadySource: readSource('dev-ready/ap-northeast-2.json'),
  prodBaselineSource: readSource('release-evidence/prod-baseline.json'),
  prodSloSource: readSource('release-evidence/prod-slo.json'),
  rollbackCompatibilitySource: readSource('release-evidence/rollback-compatibility.yaml'),
  incidentIndexSource: readSource('release-evidence/incident-index.json'),
  freezeSource: readSource('release-evidence/gitops-freeze.json'),
  removalSource: readSource('release-evidence/gitops-removal.json'),
  ownershipSource: readSource('release-evidence/ownership-inventory.json'),
  retainSource: readSource('release-evidence/retain-decisions.json'),
  preDestroySource: readSource('release-evidence/kubernetes-pre-destroy.json'),
  residualSource: readSource('release-evidence/residual-scan.json'),
};
const fixtureOptions = { upstreamSources, mode: 'fixture', now };

test('complete release evidence를 canonical JSON으로 보존한다', () => {
  const input = fixture('complete.json');
  const output = JSON.parse(exportReleaseEvidence(input, fixtureOptions));
  assert.equal(output.schemaVersion, 'course.release-evidence/v1');
  assert.equal(output.evidenceGrade, 'STATIC');
  assert.equal(output.sourceSha, input.sourceSha);
  assert.equal(output.imageDigest, input.imageDigest);
  assert.deepEqual(output.cleanup, input.cleanup);
});

test('analysisRun이 없거나 Contract 003 이후 non-v2prime candidate면 거부한다', () => {
  const missingAnalysis = fixture('complete.json');
  delete missingAnalysis.analysisRun;
  assert.throws(() => exportReleaseEvidence(missingAnalysis, fixtureOptions), /analysisRun is required/);
  const invalid = fixture('complete.json');
  invalid.rollbackCandidates[0].productReadContract = 'v1';
  assert.throws(() => exportReleaseEvidence(invalid, fixtureOptions), /rollbackCandidates must all use v2prime/);
});

test('release evidence는 exact completed runtime schema만 허용한다', () => {
  const extra = fixture('complete.json');
  extra.untrusted = true;
  assert.throws(() => exportReleaseEvidence(extra, fixtureOptions), /unexpected release evidence key untrusted/);

  const failedAnalysis = fixture('complete.json');
  failedAnalysis.analysisRun.state = 'Failed';
  assert.throws(() => exportReleaseEvidence(failedAnalysis, fixtureOptions), /analysisRun.state must equal Successful/);

  const failedSlo = fixture('complete.json');
  failedSlo.slo.status = 'FAIL';
  assert.throws(() => exportReleaseEvidence(failedSlo, fixtureOptions), /slo.status must equal PASS/);

  const incompleteCleanup = fixture('complete.json');
  incompleteCleanup.cleanup.reconcileFrozen = false;
  assert.throws(() => exportReleaseEvidence(incompleteCleanup, fixtureOptions), /cleanup completion contract mismatch/);

  const historicalRead = fixture('complete.json');
  assert.doesNotThrow(() => exportReleaseEvidence(historicalRead, {
    ...fixtureOptions,
    now: new Date('2027-09-03T04:30:00Z'),
  }));

  const future = fixture('complete.json');
  future.observedAt = '2026-09-03T04:30:01Z';
  assert.throws(() => exportReleaseEvidence(future, fixtureOptions), /future release evidence/);

  const sameCluster = fixture('complete.json');
  const prodSlo = fixture('prod-slo.json');
  prodSlo.clusterArn = fixture('gitops-freeze.json').clusters[0].clusterArn;
  assert.throws(() => exportReleaseEvidence(sameCluster, {
    ...fixtureOptions,
    upstreamSources: {
      ...upstreamSources,
      prodSloSource: Buffer.from(JSON.stringify(prodSlo)),
    },
  }), /Prod SLO digest mismatch|Dev and Prod clusters must differ/);
});

test('fixture validation은 runtime INCIDENT_EVIDENCE를 발급하지 않는다', () => {
  const input = fixture('complete.json');
  assert.equal(validateReleaseEvidenceFixture(input, upstreamSources, now).marker, '[STATIC]');
  assert.throws(
    () => exportReleaseEvidence(input, { upstreamSources, mode: 'runtime', now }),
    /runtime release evidence requires INCIDENT_EVIDENCE/,
  );
  assert.throws(() => exportReleaseEvidenceFiles({
    inputPath: new URL('./fixtures/release-evidence/complete.json', import.meta.url),
    gitopsRepoRoot: new URL('./fixtures/release-evidence', import.meta.url),
    infraRepoRoot: new URL('./fixtures/release-evidence', import.meta.url),
    outputPath: new URL('./fixtures/release-evidence/runtime-output.json', import.meta.url),
  }, now), /test fixtures cannot be exported as runtime evidence/);

  assert.throws(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, incidentIndexSource: Buffer.from('{}') },
  }), /incident index digest mismatch/);
});

test('semantic object key order가 달라도 canonical bytes는 같다', () => {
  const input = fixture('complete.json');
  const reordered = JSON.parse(JSON.stringify(input));
  reordered.analysisRun = { state: input.analysisRun.state, name: input.analysisRun.name };
  reordered.cleanup = {
    residualScan: input.cleanup.residualScan,
    desiredStateRemoved: input.cleanup.desiredStateRemoved,
    reconcileFrozen: input.cleanup.reconcileFrozen,
  };
  assert.equal(
    exportReleaseEvidence(input, fixtureOptions),
    exportReleaseEvidence(reordered, fixtureOptions),
  );
});

test('Prod SLO는 실패 이력을 제거하지 않고 성공 terminal measurement를 요구한다', () => {
  const input = fixture('complete.json');
  const prodSlo = JSON.parse(upstreamSources.prodSloSource.toString('utf8'));
  prodSlo.metricResults[0].measurements = [
    {
      value: '0', phase: 'Failed', startedAt: '2026-09-03T03:20:00Z', finishedAt: '2026-09-03T03:21:00Z',
    },
    {
      value: '12.5', phase: 'Successful', startedAt: '2026-09-03T03:25:00Z', finishedAt: '2026-09-03T03:26:00Z',
    },
  ];
  const prodSloSource = Buffer.from(JSON.stringify(prodSlo));
  const prodSloDigest = `sha256:${crypto.createHash('sha256').update(prodSloSource).digest('hex')}`;
  input.upstreamEvidence.prodSloDigest = prodSloDigest;
  const serialized = exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, prodSloSource },
  });
  assert.deepEqual(JSON.parse(serialized).upstreamEvidence.prodSloDigest, prodSloDigest);

  for (const invalidValue of [12.5, null, '']) {
    const invalidSlo = JSON.parse(upstreamSources.prodSloSource.toString('utf8'));
    invalidSlo.metricResults[0].measurements[0].value = invalidValue;
    const invalidSource = Buffer.from(JSON.stringify(invalidSlo));
    input.upstreamEvidence.prodSloDigest = `sha256:${crypto.createHash('sha256').update(invalidSource).digest('hex')}`;
    assert.throws(() => exportReleaseEvidence(input, {
      ...fixtureOptions,
      upstreamSources: { ...upstreamSources, prodSloSource: invalidSource },
    }), /terminal measurement is invalid/);
  }

  prodSlo.metricResults[0].measurements[1].phase = 'Error';
  const failedOnlySource = Buffer.from(JSON.stringify(prodSlo));
  input.upstreamEvidence.prodSloDigest = `sha256:${crypto.createHash('sha256').update(failedOnlySource).digest('hex')}`;
  assert.throws(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, prodSloSource: failedOnlySource },
  }), /successful terminal measurement/);
});

test('runtime evidence input은 canonical upstream 11개 파일만 받는다', () => {
  const input = fixture('complete.json');
  assert.throws(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, unexpectedSource: Buffer.from('not evidence') },
  }), /unexpected upstreamSources key unexpectedSource/);
});

test('runtime exporter는 canonical upstream symlink가 저장소 밖으로 나가면 거부한다', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'release-evidence-path-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const gitopsRoot = path.join(sandbox, 'argocd-gitops');
  const infraRoot = path.join(sandbox, 'EKS-infra');
  const canonicalDirectory = path.join(gitopsRoot, 'envs/prod');
  const outside = path.join(sandbox, 'outside.json');
  fs.mkdirSync(canonicalDirectory, { recursive: true });
  fs.mkdirSync(infraRoot, { recursive: true });
  fs.writeFileSync(outside, '{}\n');
  fs.symlinkSync(outside, path.join(canonicalDirectory, 'promotion-evidence.yaml'));

  assert.throws(() => exportReleaseEvidenceFiles({
    inputPath: new URL('../package.json', import.meta.url),
    gitopsRepoRoot: gitopsRoot,
    infraRepoRoot: infraRoot,
  }, now), /canonical upstream evidence escapes its repository root/);
});

test('runtime exporter는 final evidence directory symlink escape를 거부한다', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'runtime-export-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const isolatedRoot = path.join(sandbox, 'sample-app');
  const isolatedScripts = path.join(isolatedRoot, 'scripts');
  const outside = path.join(sandbox, 'outside');
  fs.mkdirSync(isolatedScripts, { recursive: true });
  fs.mkdirSync(path.join(isolatedRoot, 'evidence'), { recursive: true });
  fs.mkdirSync(outside);
  for (const script of ['export-release-evidence.mjs', 'gitops-values-lib.mjs']) {
    fs.copyFileSync(new URL(`../scripts/${script}`, import.meta.url), path.join(isolatedScripts, script));
  }
  fs.symlinkSync(outside, path.join(isolatedRoot, 'evidence/release'));
  const isolatedExporter = await import(`${pathToFileURL(
    path.join(isolatedScripts, 'export-release-evidence.mjs'),
  ).href}?test=${Date.now()}`);

  assert.throws(() => isolatedExporter.exportReleaseEvidenceFiles({
    inputPath: path.join(isolatedRoot, 'input.json'),
    gitopsRepoRoot: path.join(sandbox, 'argocd-gitops'),
    infraRepoRoot: path.join(sandbox, 'EKS-infra'),
  }, now), /canonical final evidence directory escapes the sample application repository/);
});

test('cleanup residual은 inventory의 EXTERNAL_SHARED와 RETAIN 결정을 빠짐없이 보존한다', () => {
  for (const collection of ['externalShared', 'retained']) {
    const input = fixture('complete.json');
    const residual = JSON.parse(upstreamSources.residualSource.toString('utf8'));
    residual[collection] = residual[collection].slice(1);
    const residualSource = Buffer.from(JSON.stringify(residual));
    input.upstreamEvidence.residualScanDigest = `sha256:${crypto.createHash('sha256').update(residualSource).digest('hex')}`;

    assert.throws(() => exportReleaseEvidence(input, {
      ...fixtureOptions,
      upstreamSources: { ...upstreamSources, residualSource },
    }), /cleanup residual does not exactly match ownership decisions/);
  }
});

test('GitOps removal과 pre-destroy는 승인된 Kubernetes retained set을 생략할 수 없다', () => {
  const input = fixture('complete.json');
  const removal = JSON.parse(upstreamSources.removalSource.toString('utf8'));
  const preDestroy = JSON.parse(upstreamSources.preDestroySource.toString('utf8'));
  const residual = JSON.parse(upstreamSources.residualSource.toString('utf8'));
  removal.retained = [];
  const removalSource = Buffer.from(JSON.stringify(removal));
  const removalHex = crypto.createHash('sha256').update(removalSource).digest('hex');
  preDestroy.retainedStorage = [];
  preDestroy.gitopsRemovalSha256 = removalHex;
  const preDestroySource = Buffer.from(JSON.stringify(preDestroy));
  const preDestroyHex = crypto.createHash('sha256').update(preDestroySource).digest('hex');
  residual.gitopsRemovalSha256 = removalHex;
  residual.kubernetesPreDestroySha256 = preDestroyHex;
  const residualSource = Buffer.from(JSON.stringify(residual));
  input.upstreamEvidence.gitopsRemovalDigest = `sha256:${removalHex}`;
  input.upstreamEvidence.kubernetesPreDestroyDigest = `sha256:${preDestroyHex}`;
  input.upstreamEvidence.residualScanDigest = `sha256:${crypto.createHash('sha256').update(residualSource).digest('hex')}`;

  assert.throws(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: {
      ...upstreamSources, removalSource, preDestroySource, residualSource,
    },
  }), /GitOps removal retained set does not match ownership inventory/);
});

test('cluster-scoped retained resource는 빈 namespace와 canonical name으로 연결한다', () => {
  const input = fixture('complete.json');
  const ownership = JSON.parse(upstreamSources.ownershipSource.toString('utf8'));
  const retain = JSON.parse(upstreamSources.retainSource.toString('utf8'));
  const removal = JSON.parse(upstreamSources.removalSource.toString('utf8'));
  const preDestroy = JSON.parse(upstreamSources.preDestroySource.toString('utf8'));
  const residual = JSON.parse(upstreamSources.residualSource.toString('utf8'));
  const clusterResource = {
    kind: 'VolumeSnapshotContent',
    id: 'snapshot-content-dev',
    environment: 'dev',
    classification: 'recovery-evidence',
    owner: 'course-fixture',
    managedBy: 'argocd-gitops',
    billable: true,
    decision: 'RETAIN',
    reason: 'snapshot recovery evidence retained',
    followUpAction: 'delete after retention approval',
  };
  ownership.resources.push(clusterResource);
  ownership.resources.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const ownershipSource = Buffer.from(JSON.stringify(ownership));

  retain.inventorySha256 = rawSha256(ownershipSource);
  retain.decisions.push({
    kind: clusterResource.kind,
    id: clusterResource.id,
    decision: clusterResource.decision,
    reason: clusterResource.reason,
    followUpAction: clusterResource.followUpAction,
  });
  retain.decisions.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const retainSource = Buffer.from(JSON.stringify(retain));

  const retainedItem = {
    environment: 'dev',
    namespace: '',
    kind: clusterResource.kind,
    name: clusterResource.id,
    uid: '66666666-7777-8888-9999-000000000000',
    classification: clusterResource.classification,
  };
  removal.retained.push({ ...retainedItem, requiresExplicitDeletion: true });
  const removalSource = Buffer.from(JSON.stringify(removal));

  preDestroy.gitopsRemovalSha256 = rawSha256(removalSource);
  preDestroy.retainedStorage.push(retainedItem);
  const preDestroySource = Buffer.from(JSON.stringify(preDestroy));

  residual.inventorySha256 = rawSha256(ownershipSource);
  residual.retainDecisionsSha256 = rawSha256(retainSource);
  residual.gitopsRemovalSha256 = rawSha256(removalSource);
  residual.kubernetesPreDestroySha256 = rawSha256(preDestroySource);
  residual.retained.push({
    kind: clusterResource.kind,
    id: clusterResource.id,
    owner: clusterResource.owner,
    reason: clusterResource.reason,
    followUpAction: clusterResource.followUpAction,
    presentAfterCleanup: true,
  });
  residual.retained.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const residualSource = Buffer.from(JSON.stringify(residual));

  input.upstreamEvidence.ownershipInventoryDigest = `sha256:${rawSha256(ownershipSource)}`;
  input.upstreamEvidence.retainDecisionsDigest = `sha256:${rawSha256(retainSource)}`;
  input.upstreamEvidence.gitopsRemovalDigest = `sha256:${rawSha256(removalSource)}`;
  input.upstreamEvidence.kubernetesPreDestroyDigest = `sha256:${rawSha256(preDestroySource)}`;
  input.upstreamEvidence.residualScanDigest = `sha256:${rawSha256(residualSource)}`;

  assert.doesNotThrow(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: {
      ...upstreamSources,
      ownershipSource,
      retainSource,
      removalSource,
      preDestroySource,
      residualSource,
    },
  }));
});

test('final exporter는 push가 아닌 DEV_READY workflow event를 거부한다', () => {
  const input = fixture('complete.json');
  const devReady = JSON.parse(upstreamSources.devReadySource.toString('utf8'));
  devReady.workflow.event = 'workflow_dispatch';
  const devReadySource = Buffer.from(JSON.stringify(devReady));
  input.upstreamEvidence.devReadyDigest = `sha256:${crypto.createHash('sha256').update(devReadySource).digest('hex')}`;

  assert.throws(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, devReadySource },
  }), /invalid DEV_READY identity/);
});

test('final exporter는 숫자형 DEV_READY workflow runId를 거부한다', () => {
  const input = fixture('complete.json');
  const devReady = JSON.parse(upstreamSources.devReadySource.toString('utf8'));
  devReady.workflow.runId = Number(devReady.workflow.runId);
  const devReadySource = Buffer.from(JSON.stringify(devReady));
  input.upstreamEvidence.devReadyDigest = `sha256:${crypto.createHash('sha256').update(devReadySource).digest('hex')}`;

  assert.throws(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, devReadySource },
  }), /invalid DEV_READY identity/);
});

test('final exporter는 두 canonical image platform이 아닌 DEV_READY를 거부한다', () => {
  const input = fixture('complete.json');
  const devReady = JSON.parse(upstreamSources.devReadySource.toString('utf8'));
  devReady.image.platforms = ['linux/amd64'];
  const devReadySource = Buffer.from(JSON.stringify(devReady));
  input.upstreamEvidence.devReadyDigest = `sha256:${crypto.createHash('sha256').update(devReadySource).digest('hex')}`;

  assert.throws(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, devReadySource },
  }), /invalid DEV_READY identity/);
});

test('final exporter는 noncanonical DEV_READY AWS identity를 거부한다', () => {
  const mutations = [
    (value) => { value.cluster.arn = 'arn:aws-cn:eks:ap-northeast-2:123456789012:cluster/course-dev'; },
    (value) => { value.cluster.arn = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/course-dev/garbage'; },
    (value) => { value.cluster.arn = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/course dev'; },
    (value) => { value.image.repository = value.image.repository.replace('.amazonaws.com/', '.amazonaws.com.cn/'); },
  ];

  for (const mutate of mutations) {
    const input = fixture('complete.json');
    const devReady = JSON.parse(upstreamSources.devReadySource.toString('utf8'));
    mutate(devReady);
    const devReadySource = Buffer.from(JSON.stringify(devReady));
    input.upstreamEvidence.devReadyDigest = `sha256:${rawSha256(devReadySource)}`;
    assert.throws(() => exportReleaseEvidence(input, {
      ...fixtureOptions,
      upstreamSources: { ...upstreamSources, devReadySource },
    }), /invalid DEV_READY (?:cluster ARN|image repository)/);
  }
});

test('final exporter는 renamed sample application repository의 DEV_READY를 거부한다', () => {
  const input = fixture('complete.json');
  const devReady = JSON.parse(upstreamSources.devReadySource.toString('utf8'));
  devReady.workflow.runUrl = 'https://github.com/play-builder/renamed-app/actions/runs/1234567890';
  devReady.attestation.githubUrl = 'https://github.com/play-builder/renamed-app/attestations/1234567';
  const devReadySource = Buffer.from(JSON.stringify(devReady));
  input.upstreamEvidence.devReadyDigest = `sha256:${rawSha256(devReadySource)}`;

  assert.throws(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, devReadySource },
  }), /invalid DEV_READY workflow identity/);
});

test('final exporter는 rollback window 안의 모든 v2prime candidate를 보존한다', () => {
  const input = fixture('complete.json');
  const rollback = YAML.parse(upstreamSources.rollbackCompatibilitySource.toString('utf8'));
  const secondCandidate = {
    imageDigest: rollback.releaseLineage.v2PrimeContractCompatible.indexDigest,
    productReadContract: 'v2prime',
    rolloutRevision: 2,
    gitRevertSha: rollback.releaseLineage.v2PrimeContractCompatible.sourceSha,
    podTemplateHash: 'older-compatible-hash',
  };
  rollback.completedRollback.candidates.push(secondCandidate);
  rollback.completedRollback.replicaSetList.items.unshift({
    metadata: {
      name: 'sample-app-older-compatible',
      creationTimestamp: '2026-09-03T02:50:00Z',
      labels: { 'rollouts-pod-template-hash': secondCandidate.podTemplateHash },
      ownerReferences: [{
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Rollout',
        name: rollback.completedRollback.rolloutName,
        uid: rollback.completedRollback.rolloutUid,
        controller: true,
      }],
    },
  });
  input.rollbackCandidates.push(secondCandidate);
  const rollbackCompatibilitySource = Buffer.from(YAML.stringify(rollback));
  input.upstreamEvidence.rollbackCompatibilityDigest = `sha256:${crypto.createHash('sha256').update(rollbackCompatibilitySource).digest('hex')}`;

  const output = JSON.parse(exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, rollbackCompatibilitySource },
  }));
  assert.deepEqual(output.rollbackCandidates, input.rollbackCandidates);

  rollback.completedRollback.candidates[1].podTemplateHash = 'missing-compatible-hash';
  input.rollbackCandidates[1].podTemplateHash = 'missing-compatible-hash';
  const invalidSource = Buffer.from(YAML.stringify(rollback));
  input.upstreamEvidence.rollbackCompatibilityDigest = `sha256:${crypto.createHash('sha256').update(invalidSource).digest('hex')}`;
  assert.throws(() => exportReleaseEvidence(input, {
    ...fixtureOptions,
    upstreamSources: { ...upstreamSources, rollbackCompatibilitySource: invalidSource },
  }), /ROLLBACK_TARGET_REPLICASET_MISSING/);
});
