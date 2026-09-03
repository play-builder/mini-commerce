import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('../scripts/verify-image-index.sh', import.meta.url).pathname;
const fixture = (name) => new URL(`./fixtures/oci-index/${name}`, import.meta.url).pathname;
const digest = `sha256:${'c'.repeat(64)}`;

function verify(name, candidateDigest = digest) {
  return spawnSync('bash', [script, 'example.invalid/course/sample-app', candidateDigest], {
    encoding: 'utf8',
    env: { ...process.env, IMAGE_INDEX_INSPECT_FILE: fixture(name) },
  });
}

test('amd64와 arm64 descriptor가 모두 있는 OCI index를 승인한다', () => {
  const result = verify('amd64-arm64.json');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: multi-architecture image index/);
});

test('arm64 descriptor가 없는 index를 거부한다', () => {
  const result = verify('amd64-only.json');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required platform linux\/arm64/);
});

test('정규화되지 않은 digest를 거부한다', () => {
  const result = verify('amd64-arm64.json', 'sha256:ABC');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid digest/);
});
