import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { exportReleaseEvidence } from '../scripts/export-release-evidence.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/release-evidence/${name}`, import.meta.url),
  'utf8',
));

const now = new Date('2026-09-03T04:30:00Z');

test('complete release evidence를 canonical JSON으로 보존한다', () => {
  const input = fixture('complete.json');
  const output = JSON.parse(exportReleaseEvidence(input, now));
  assert.equal(output.schemaVersion, 'course.release-evidence/v1');
  assert.equal(output.evidenceGrade, 'INCIDENT_EVIDENCE');
  assert.equal(output.sourceSha, input.sourceSha);
  assert.equal(output.imageDigest, input.imageDigest);
  assert.deepEqual(output.cleanup, input.cleanup);
});

test('analysisRun이 없거나 Contract 003 이후 non-v2prime candidate면 거부한다', () => {
  const missingAnalysis = fixture('complete.json');
  delete missingAnalysis.analysisRun;
  assert.throws(() => exportReleaseEvidence(missingAnalysis, now), /analysisRun is required/);
  const invalid = fixture('complete.json');
  invalid.rollbackCandidates[0].productReadContract = 'v1';
  assert.throws(() => exportReleaseEvidence(invalid, now), /rollbackCandidates must all use v2prime/);
});

test('release evidence는 exact completed runtime schema만 허용한다', () => {
  const extra = fixture('complete.json');
  extra.untrusted = true;
  assert.throws(() => exportReleaseEvidence(extra, now), /unexpected release evidence key untrusted/);

  const failedAnalysis = fixture('complete.json');
  failedAnalysis.analysisRun.state = 'Failed';
  assert.throws(() => exportReleaseEvidence(failedAnalysis, now), /analysisRun.state must equal Successful/);

  const failedSlo = fixture('complete.json');
  failedSlo.slo.status = 'FAIL';
  assert.throws(() => exportReleaseEvidence(failedSlo, now), /slo.status must equal PASS/);

  const incompleteCleanup = fixture('complete.json');
  incompleteCleanup.cleanup.reconcileFrozen = false;
  assert.throws(() => exportReleaseEvidence(incompleteCleanup, now), /cleanup completion contract mismatch/);

  const historical = fixture('complete.json');
  historical.observedAt = '2025-09-03T04:00:00Z';
  assert.doesNotThrow(() => exportReleaseEvidence(historical, now));

  const future = fixture('complete.json');
  future.observedAt = '2026-09-03T04:30:01Z';
  assert.throws(() => exportReleaseEvidence(future, now), /future release evidence/);
});
