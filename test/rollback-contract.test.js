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
    annotations: options.experimentName
      ? { 'rollouts.argoproj.io/experiment-name': options.experimentName }
      : {},
    ownerReferences: options.labelOnly ? [] : [{
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Rollout',
      name: options.rolloutName ?? 'sample-app',
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
    migrationDigest: digest('d'),
    gitDesiredStateDigest: digest('a'),
  }), 'in-progress-stable-reapply');
  assert.throws(() => classifyRollbackBoundary({
    state: 'in-progress',
    applicationDigest: digest('a'),
    stableDigest: digest('a'),
    migrationDigest: digest('d'),
    gitDesiredStateDigest: digest('b'),
  }), /GIT_DESIRED_STATE_MUST_MATCH_STABLE/);
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
    migrationDigest: digest('d'),
    gitDesiredStateDigest: digest('a'),
    stableHash: 'stable',
    targetHash: 'target',
    rolloutName: 'sample-app',
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
      replicaSet('experiment', '2026-09-03T00:15:00Z', { experimentName: 'canary-analysis' }),
      replicaSet('unrelated', '2026-09-03T00:20:00Z', { rolloutName: 'another-rollout' }),
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
  }), /ROLLBACK_REPLICASET_ENDPOINT_MISSING/);
});

test('completed rollback은 missing/reversed target-stable endpoint를 거부한다', () => {
  const base = {
    state: 'completed',
    applicationDigest: digest('a'),
    stableDigest: digest('c'),
    migrationDigest: digest('d'),
    gitDesiredStateDigest: digest('a'),
    stableHash: 'stable',
    targetHash: 'target',
    rolloutName: 'sample-app',
    rollbackWindow: { revisions: 2 },
  };
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    replicaSetList: replicaSetList(replicaSet('stable', '2026-09-03T00:30:00Z')),
  }), /ROLLBACK_REPLICASET_ENDPOINT_MISSING/);
  assert.throws(() => classifyRollbackBoundary({
    ...base,
    replicaSetList: replicaSetList(
      replicaSet('stable', '2026-09-03T00:00:00Z'),
      replicaSet('target', '2026-09-03T00:30:00Z'),
    ),
  }), /ROLLBACK_TARGET_MUST_BE_OLDER_THAN_STABLE/);
});
