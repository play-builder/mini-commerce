import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { exportReleaseEvidence } from '../scripts/export-release-evidence.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/release-evidence/${name}`, import.meta.url),
  'utf8',
));

test('complete release evidence를 canonical JSON으로 보존한다', () => {
  const input = fixture('complete.json');
  const output = JSON.parse(exportReleaseEvidence(input));
  assert.equal(output.sourceSha, input.sourceSha);
  assert.equal(output.imageDigest, input.imageDigest);
  assert.deepEqual(output.cleanup, input.cleanup);
});

test('analysisRun이 없거나 Contract 003 이후 non-v2prime candidate면 거부한다', () => {
  assert.throws(() => exportReleaseEvidence(fixture('missing-analysis.json')), /analysisRun is required/);
  const invalid = fixture('complete.json');
  invalid.rollbackCandidates[0].productReadContract = 'v1';
  assert.throws(() => exportReleaseEvidence(invalid), /rollbackCandidates must all use v2prime/);
});
