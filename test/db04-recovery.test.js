import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { verifyDb04RecoverySource } from '../scripts/export-release-evidence.mjs';

const scope = { courseId: 'course-fixture', accountId: '123456789012', region: 'ap-northeast-2' };
const repository = 'play-builder/cicd-course-sample-app';
const imageRepository = '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/course/sample-app';
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const sha = (letter) => letter.repeat(40);
const releaseLineage = {
  v2PrimeContractCompatible: { sourceSha: sha('4'), indexDigest: digest('c') },
  v2FaultyOrderTotal: { sourceSha: sha('2'), indexDigest: digest('2') },
  v201HotfixOrderTotal: { sourceSha: sha('3'), indexDigest: digest('3') },
};

function source(strategy) {
  const stable = {
    repository, sourceSha: sha('4'), imageRepository, indexDigest: digest('c'),
  };
  const faulty = {
    repository, sourceSha: sha('2'), imageRepository, indexDigest: digest('2'),
  };
  const recovered = strategy === 'hotfix-fix-forward'
    ? { repository, sourceSha: sha('3'), imageRepository, indexDigest: digest('3'), strategy }
    : { ...stable, strategy };
  return {
    schemaVersion: 'course.db04-recovery/v1', evidenceGrade: 'INCIDENT_EVIDENCE',
    incidentId: 'INC-DB-04', scenario: strategy, ...scope,
    executionId: `execution-${strategy}`, stable, faulty, recovered,
    workflow: {
      runId: strategy === 'git-revert' ? '1001' : strategy === 'break-glass-undo-plus-git' ? '1002' : '1003',
      runAttempt: 1,
      runUrl: `https://github.com/play-builder/cicd-course-sample-app/actions/runs/${strategy === 'git-revert' ? '1001' : strategy === 'break-glass-undo-plus-git' ? '1002' : '1003'}`,
    },
    gitopsRevision: sha(strategy === 'git-revert' ? 'a' : strategy === 'break-glass-undo-plus-git' ? 'b' : 'c'),
    rolloutRevision: strategy === 'git-revert' ? 5 : strategy === 'break-glass-undo-plus-git' ? 6 : 7,
    observedAt: '2026-09-03T03:40:00Z',
  };
}

function verify(value) {
  return verifyDb04RecoverySource(Buffer.from(JSON.stringify(value)), {
    incident: { id: 'INC-DB-04' }, scenario: { name: value.scenario },
    expectedScope: scope, releaseLineage,
  });
}

test('DB04 recovery source는 v2prime/v2 lineage와 전략에 결속된다', () => {
  assert.doesNotThrow(() => verify(source('git-revert')));
  assert.doesNotThrow(() => verify(source('break-glass-undo-plus-git')));
  assert.doesNotThrow(() => verify(source('hotfix-fix-forward')));

  const alteredStable = source('git-revert');
  alteredStable.stable.sourceSha = sha('1');
  assert.throws(() => verify(alteredStable), /stable identity|stable\/faulty identity/);

  const stableReuse = source('hotfix-fix-forward');
  stableReuse.recovered = { ...stableReuse.stable, strategy: 'hotfix-fix-forward' };
  assert.throws(() => verify(stableReuse), /hotfix does not match/);
});

test('DB04 recovery source는 strategy와 workflow URL identity가 다르면 거부한다', () => {
  const wrongStrategy = source('git-revert');
  wrongStrategy.recovered.strategy = 'hotfix-fix-forward';
  assert.throws(() => verify(wrongStrategy), /strategy\/scenario mismatch/);

  const wrongUrl = source('break-glass-undo-plus-git');
  wrongUrl.workflow.runUrl = 'https://github.com/play-builder/cicd-course-sample-app/actions/runs/9999';
  assert.throws(() => verify(wrongUrl), /workflow identity is invalid/);
});
