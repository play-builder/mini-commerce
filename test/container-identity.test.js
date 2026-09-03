import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const runtimeStage = dockerfile.split(/\nFROM .* AS runtime\n/)[1];

test('runtime image ownership and execution identity are numeric 10001:10001', () => {
  assert.ok(runtimeStage, 'runtime stage must exist');
  assert.match(runtimeStage, /addgroup -g 10001 -S \w+.*adduser -S -u 10001 -G \w+ \w+/);

  const runtimeCopies = runtimeStage
    .split('\n')
    .filter((line) => line.startsWith('COPY '));
  assert.ok(runtimeCopies.length > 0, 'runtime stage must copy application files');
  for (const copy of runtimeCopies) {
    assert.match(copy, /--chown=10001:10001/, `${copy} must use numeric runtime ownership`);
  }

  assert.match(runtimeStage, /^USER 10001:10001$/m);
});
