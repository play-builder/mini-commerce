import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { verifyContract003RollbackCandidates } from '../src/migration-ledger.js';

const validEvidence = () => ({
  schemaVersion: 'course.rollback-candidates/v1',
  evidenceGrade: 'CLOUD_RUNTIME',
  environment: 'prod',
  region: 'ap-northeast-2',
  clusterArn: 'arn:aws:eks:ap-northeast-2:123456789012:cluster/course-prod',
  rolloutName: 'sample-app',
  gitopsRevision: 'a'.repeat(40),
  sourceEvidenceDigest: `sha256:${'b'.repeat(64)}`,
  observedAt: '2026-09-03T00:00:00Z',
  expiresAt: '2026-09-03T01:00:00Z',
  candidates: [{
    imageDigest: `sha256:${'c'.repeat(64)}`,
    productReadContract: 'v2prime',
    rolloutRevision: 3,
    gitRevertSha: 'd'.repeat(40),
    podTemplateHash: 'stable-hash',
  }],
});

function verify(evidence, now = new Date('2026-09-03T00:30:00Z')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-candidates-'));
  const evidenceFile = path.join(directory, 'evidence.json');
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence));
  try {
    return verifyContract003RollbackCandidates(evidenceFile, {
      environment: evidence.environment,
      region: evidence.region,
      clusterArn: evidence.clusterArn,
      rolloutName: evidence.rolloutName,
      gitopsRevision: evidence.gitopsRevision,
      sourceEvidenceDigest: evidence.sourceEvidenceDigest,
    }, now);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('rollback candidate evidence는 canonical commercial EKS ARN만 허용한다', () => {
  assert.doesNotThrow(() => verify(validEvidence()));

  for (const clusterArn of [
    'arn:aws-cn:eks:ap-northeast-2:123456789012:cluster/course-prod',
    'arn:aws:eks:ap-northeast-2:123456789012:cluster/course-prod/junk',
    'arn:aws:eks:ap-northeast-2:123456789012:cluster/course prod',
  ]) {
    const evidence = validEvidence();
    evidence.clusterArn = clusterArn;
    assert.throws(() => verify(evidence), /ROLLBACK_CANDIDATE_CLUSTER_ARN_INVALID/);
  }
});

test('rollback candidate evidence의 이름과 hash는 공백이 아닌 식별자여야 한다', () => {
  for (const mutate of [
    (evidence) => { evidence.rolloutName = '   '; },
    (evidence) => { evidence.rolloutName = '\uFEFF'; },
    (evidence) => { evidence.candidates[0].podTemplateHash = '   '; },
    (evidence) => { evidence.candidates[0].podTemplateHash = '\uFEFF'; },
  ]) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.throws(
      () => verify(evidence),
      /ROLLBACK_CANDIDATE_(?:IDENTITY|RETAINED_CANDIDATE)_INVALID|CONTRACT_003_RETAINED_CANDIDATE_INVALID/,
    );
  }
});

test('rollback candidate evidence 시각은 calendar-valid canonical UTC seconds여야 한다', () => {
  assert.doesNotThrow(() => verify(validEvidence()));

  for (const field of ['observedAt', 'expiresAt']) {
    for (const timestamp of [
      '2026-09-03T00:00:00.123Z',
      '2026-09-03T09:00:00+09:00',
      '2026-02-30T00:00:00Z',
    ]) {
      const evidence = validEvidence();
      evidence[field] = timestamp;
      assert.throws(
        () => verify(evidence),
        /ROLLBACK_CANDIDATE_EVIDENCE_LIFETIME_INVALID/,
        `${field} accepted ${timestamp}`,
      );
    }
  }
});
