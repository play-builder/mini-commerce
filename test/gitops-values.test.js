import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  promoteDeliveryImages,
  readImageBlock,
  readMigrationImageBlock,
  rollbackApplicationImage,
  updateDeliveryImages,
  updateImageBlock,
} from '../scripts/gitops-values-lib.mjs';

const source = `environment: dev

image:
  repository: "old.example/sample-app"
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

workload:
  kind: Deployment

database:
  enabled: false
  migrationImage:
    repository: "old.example/sample-app"
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
`;

test('GitOps image block만 새 immutable digest로 바꾼다', () => {
  const digest = `sha256:${'b'.repeat(64)}`;
  const updated = updateImageBlock(source, 'new.example/sample-app', digest);

  assert.deepEqual(readImageBlock(updated), {
    repository: 'new.example/sample-app',
    digest,
  });
  assert.ok(updated.includes('workload:\n  kind: Deployment'));
});

test('mutable tag나 잘못된 digest를 거부한다', () => {
  assert.throws(
    () => updateImageBlock(source, 'new.example/sample-app', 'latest'),
    /image digest must match/,
  );
});

test('forward delivery는 application과 migration digest를 함께 갱신한다', () => {
  const digest = `sha256:${'c'.repeat(64)}`;
  const updated = updateDeliveryImages(source, 'new.example/sample-app', digest);

  assert.deepEqual(readImageBlock(updated), { repository: 'new.example/sample-app', digest });
  assert.deepEqual(readMigrationImageBlock(updated), { repository: 'new.example/sample-app', digest });
});

test('promotion은 Dev의 application과 migration digest를 Prod에 함께 복사한다', () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const dev = updateDeliveryImages(source, 'dev.example/sample-app', digest);
  const prod = promoteDeliveryImages(dev, source);

  assert.deepEqual(readImageBlock(prod), { repository: 'dev.example/sample-app', digest });
  assert.deepEqual(readMigrationImageBlock(prod), { repository: 'dev.example/sample-app', digest });
});

test('promotion은 Dev application과 migration image가 다르면 거부한다', () => {
  const applicationDigest = `sha256:${'d'.repeat(64)}`;
  const migrationDigest = `sha256:${'e'.repeat(64)}`;
  const dev = updateDeliveryImages(source, 'dev.example/sample-app', applicationDigest)
    .replace(
      `    digest: "${applicationDigest}"`,
      `    digest: "${migrationDigest}"`,
    );

  assert.throws(
    () => promoteDeliveryImages(dev, source),
    /application and migration images must match/,
  );
});

test('Fix-Backward는 application digest만 되돌리고 migration digest는 유지한다', () => {
  const currentDigest = `sha256:${'e'.repeat(64)}`;
  const rollbackDigest = `sha256:${'f'.repeat(64)}`;
  const current = updateDeliveryImages(source, 'new.example/sample-app', currentDigest);
  const rolledBack = rollbackApplicationImage(current, 'old.example/sample-app', rollbackDigest);

  assert.deepEqual(readImageBlock(rolledBack), {
    repository: 'old.example/sample-app',
    digest: rollbackDigest,
  });
  assert.deepEqual(readMigrationImageBlock(rolledBack), {
    repository: 'new.example/sample-app',
    digest: currentDigest,
  });
});
