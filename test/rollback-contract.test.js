import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyRollbackBoundary,
  readMigrationImageBlock,
  rollbackApplicationImage,
  updateDeliveryImages,
} from '../scripts/gitops-values-lib.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const currentSource = `image:
  repository: "new.example/sample-app"
  digest: "${digest('c')}"
database:
  migrationImage:
    repository: "new.example/sample-app"
    digest: "${digest('c')}"
`;

const replicaSet = (podTemplateHash, creationTimestamp, options = {}) => ({
  metadata: {
    name: `${options.rolloutName ?? 'sample-app'}-${podTemplateHash}`,
    creationTimestamp,
    labels: {
      'rollouts-pod-template-hash': podTemplateHash,
      ...(options.labelOnly ? { 'rollouts.argoproj.io/rollout-name': options.rolloutName ?? 'sample-app' } : {}),
    },
    annotations: Object.hasOwn(options, 'experimentName')
      ? { 'rollouts.argoproj.io/experiment-name': options.experimentName }
      : {},
    ownerReferences: options.labelOnly ? [] : [{
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Rollout',
      name: options.rolloutName ?? 'sample-app',
      uid: options.rolloutUid ?? '11111111-1111-1111-1111-111111111111',
      controller: true,
    }],
  },
});

const replicaSetList = (...items) => ({
  apiVersion: 'apps/v1',
  kind: 'ReplicaSetList',
  items,
});

test('in-progress stable reapply는 Git desired state와 stable digest가 같아야 한다', () => {
  assert.equal(classifyRollbackBoundary({
    state: 'in-progress',
    applicationDigest: digest('a'),
    stableDigest: digest('a'),
    previousMigrationDigest: digest('d'),
    currentMigrationDigest: digest('d'),
    gitDesiredStateDigest: digest('a'),
  }), 'in-progress-stable-reapply');
  assert.throws(() => classifyRollbackBoundary({
    state: 'in-progress',
    applicationDigest: digest('a'),
    stableDigest: digest('a'),
    previousMigrationDigest: digest('d'),
    currentMigrationDigest: digest('d'),
    gitDesiredStateDigest: digest('b'),
  }), /GIT_DESIRED_STATE_MUST_MATCH_STABLE/);
  assert.throws(() => classifyRollbackBoundary({
    state: 'in-progress',
    applicationDigest: digest('a'),
    stableDigest: digest('a'),
    previousMigrationDigest: digest('d'),
    currentMigrationDigest: digest('e'),
    gitDesiredStateDigest: digest('a'),
  }), /MIGRATION_DIGEST_MUST_REMAIN_UNCHANGED/);
});

test('application rollback은 migration image를 그대로 보존한다', () => {
  const current = updateDeliveryImages(currentSource, 'new.example/sample-app', digest('c'));
  const rolledBack = rollbackApplicationImage(current, 'old.example/sample-app', digest('a'));
  assert.deepEqual(readMigrationImageBlock(rolledBack), {
    repository: 'new.example/sample-app',
    digest: digest('c'),
  });
});

test('completed rollback window는 revision gap이 아니라 실제 non-Experiment RS를 센다', () => {
  const base = {
    state: 'completed',
    applicationDigest: digest('a'),
    stableDigest: digest('c'),
    previousMigrationDigest: digest('d'),
    currentMigrationDigest: digest('d'),
    gitDesiredStateDigest: digest('a'),
    stableHash: 'stable',
    targetHash: 'target',
    rolloutName: 'sample-app',
    rolloutUid: '11111111-1111-1111-1111-111111111111',
  };
  assert.equal(classifyRollbackBoundary({
    ...base,
    rollbackWindow: { revisions: 1 },
    replicaSetList: replicaSetList(
      replicaSet('target', '2026-09-03T00:00:00Z'),
      replicaSet('stable', '2026-09-03T00:30:00Z'),
    ),
  }), 'completed-window-inside');
  assert.equal(classifyRollbackBoundary({
    ...base,
    rollbackWindow: { revisions: 2 },
    replicaSetList: replicaSetList(
      replicaSet('target', '2026-09-03T00:00:00Z'),
      replicaSet('middle-a', '2026-09-03T00:10:00Z'),
      replicaSet('middle-b', '2026-09-03T00:20:00Z'),
      replicaSet('stable', '2026-09-03T00:30:00Z'),
    ),
  }), 'completed-window-outside');
  assert.equal(classifyRollbackBoundary({
    ...base,
    rollbackWindow: { revisions: 1 },
    replicaSetList: replicaSetList(
      replicaSet('target', '2026-09-03T00:00:00Z'),
      replicaSet('experiment', '2026-09-03T00:15:00Z', { experimentName: '' }),
      replicaSet('unrelated', '2026-09-03T00:20:00Z', { rolloutName: 'another-rollout' }),
      replicaSet('wrong-uid', '2026-09-03T00:25:00Z', { rolloutUid: '22222222-2222-2222-2222-222222222222' }),
      replicaSet('stable', '2026-09-03T00:30:00Z'),
    ),
  }), 'completed-window-inside');
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    rollbackWindow: { revisions: 1 },
    replicaSetList: replicaSetList(
      replicaSet('target', '2026-09-03T00:00:00Z', { labelOnly: true }),
      replicaSet('stable', '2026-09-03T00:30:00Z', { labelOnly: true }),
    ),
  }), /ROLLBACK_TARGET_REPLICASET_MISSING/);
});

test('completed rollback은 missing/reversed target-stable endpoint를 거부한다', () => {
  const base = {
    state: 'completed',
    applicationDigest: digest('a'),
    stableDigest: digest('c'),
    previousMigrationDigest: digest('d'),
    currentMigrationDigest: digest('d'),
    gitDesiredStateDigest: digest('a'),
    stableHash: 'stable',
    targetHash: 'target',
    rolloutName: 'sample-app',
    rolloutUid: '11111111-1111-1111-1111-111111111111',
    rollbackWindow: { revisions: 2 },
  };
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    replicaSetList: replicaSetList(replicaSet('stable', '2026-09-03T00:30:00Z')),
  }), /ROLLBACK_TARGET_REPLICASET_MISSING/);
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    replicaSetList: replicaSetList(
      replicaSet('target', '2026-09-03T00:00:00Z'),
      replicaSet('target', '2026-09-03T00:01:00Z'),
      replicaSet('stable', '2026-09-03T00:30:00Z'),
    ),
  }), /ROLLBACK_TARGET_REPLICASET_DUPLICATE/);
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    replicaSetList: replicaSetList(replicaSet('target', '2026-09-03T00:00:00Z')),
  }), /ROLLBACK_STABLE_REPLICASET_MISSING/);
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    replicaSetList: replicaSetList(
      replicaSet('target', '2026-09-03T00:00:00Z'),
      replicaSet('stable', '2026-09-03T00:29:00Z'),
      replicaSet('stable', '2026-09-03T00:30:00Z'),
    ),
  }), /ROLLBACK_STABLE_REPLICASET_DUPLICATE/);
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    replicaSetList: replicaSetList(
      replicaSet('stable', '2026-09-03T00:00:00Z'),
      replicaSet('target', '2026-09-03T00:30:00Z'),
    ),
  }), /ROLLBACK_TARGET_MUST_BE_OLDER_THAN_STABLE/);
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    replicaSetList: replicaSetList(
      replicaSet('target', '2026-09-03T00:00:00Z'),
      replicaSet('middle', 'not-a-timestamp'),
      replicaSet('stable', '2026-09-03T00:30:00Z'),
    ),
  }), /ROLLBACK_REPLICASET_TIMESTAMP_INVALID/);
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    targetHash: 'stable',
    replicaSetList: replicaSetList(replicaSet('stable', '2026-09-03T00:30:00Z')),
  }), /ROLLBACK_ENDPOINT_HASHES_MUST_BE_DISTINCT/);
});
