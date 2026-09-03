import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { verifySupplyChain } from '../scripts/verify-supply-chain.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/supply-chain/${name}`, import.meta.url),
  'utf8',
));

test('검증된 두 platform과 일치하는 attestation/referrer를 승인한다', () => {
  const evidence = fixture('verified.json');
  assert.equal(verifySupplyChain(evidence).imageDigest, evidence.imageDigest);
});

test('다른 workflow identity를 거부한다', () => {
  assert.throws(
    () => verifySupplyChain(fixture('wrong-workflow.json')),
    /workflow identity mismatch/,
  );
});

test('arm64 scan이 없는 evidence를 거부한다', () => {
  assert.throws(
    () => verifySupplyChain(fixture('missing-arm64-scan.json')),
    /linux\/arm64 scan is required/,
  );
});
