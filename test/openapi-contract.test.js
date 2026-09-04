import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';
import { verifyBackwardCompatibility } from '../scripts/verify-openapi-backward-compatibility.mjs';

test('OpenAPI retains public operations and rejects response removal', () => {
  const document = YAML.parse(fs.readFileSync(new URL('../openapi/mini-commerce.v1.yaml', import.meta.url), 'utf8'));
  assert.equal(document.paths['/healthz'], undefined);
  const changed = JSON.parse(JSON.stringify(document));
  delete changed.paths['/orders'].post.responses['201'];
  assert.throws(() => verifyBackwardCompatibility({ baseDocument: document, candidateDocument: changed }), /OPENAPI_RESPONSE_REMOVED/);
});
