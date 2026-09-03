import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import { test } from 'node:test';

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
