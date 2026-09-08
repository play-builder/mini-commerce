import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertRepositoryIdentity, normalizeRepositoryId } from '../../scripts/repository-identity.mjs';

test('repository ID is decimal, safe, and independent of display name', () => {
  assert.equal(normalizeRepositoryId('1352247019'), '1352247019');
  assert.throws(() => normalizeRepositoryId('play-builder/mini-commerce'), /repositoryId must be decimal/);
  assert.throws(() => assertRepositoryIdentity({
    repositoryId: 1352247019,
  }), /repositoryId must be decimal/);
  assert.doesNotThrow(() => assertRepositoryIdentity({
    repositoryId: '1352247019', repositoryName: 'renamed-owner/renamed-app',
    expectedRepositoryId: '1352247019',
  }));
});
