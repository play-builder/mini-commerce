import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { verifyDevReadyEvidence } from '../scripts/dev-ready-evidence.mjs';
import { assertRepositoryIdentity, normalizeRepositoryId } from '../scripts/repository-identity.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/repository-identity/${name}`, import.meta.url),
  'utf8',
));

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

test('DEV_READY accepts canonical v1 input and validates v2 against workflow repository ID', () => {
  const v1 = fixture('v1-valid.json');
  const v2 = fixture('v2-valid.json');
  const run = {
    id: 1234567890,
    html_url: v2.workflow.runUrl,
    repository: { id: 1352247019 },
    run_attempt: 1,
    head_sha: v2.sourceSha,
    event: 'push',
    name: 'ci',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
  };
  const now = new Date('2026-09-03T01:00:00Z');
  assert.throws(
    () => verifyDevReadyEvidence(v1, { expectedRepositoryId: '1352247019' }, now),
    /LEGACY_REPOSITORY_IDENTITY_NOT_ALLOWED/,
  );
  assert.doesNotThrow(() => verifyDevReadyEvidence(v1, {
    expectedRepositoryId: '1352247019',
    allowLegacyRepositoryIdentity: true,
  }, now));
  assert.throws(() => verifyDevReadyEvidence(v1, {
    expectedRepositoryId: '999',
    allowLegacyRepositoryIdentity: true,
  }, now), /LEGACY_REPOSITORY_IDENTITY_NOT_ALLOWED/);
  assert.doesNotThrow(() => verifyDevReadyEvidence(v2, {
    expectedRepositoryId: '1352247019', workflowRun: run,
  }, now));
  assert.throws(
    () => verifyDevReadyEvidence({ ...v2, repositoryId: '999' }, {}, now),
    /REPOSITORY_ID_MISMATCH/,
  );
  assert.throws(() => verifyDevReadyEvidence({ ...v2, repositoryId: '999' }, {
    expectedRepositoryId: '999',
  }, now), /REPOSITORY_ID_MISMATCH/);
  assert.throws(() => verifyDevReadyEvidence({ ...v2, repositoryId: '1352247020' }, {
    expectedRepositoryId: '1352247019', workflowRun: run,
  }, now), /REPOSITORY_ID_MISMATCH/);
});
