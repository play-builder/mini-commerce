import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  const parameterTightened = JSON.parse(JSON.stringify(document));
  parameterTightened.paths['/orders'].post.parameters[0].required = false;
  assert.throws(() => verifyBackwardCompatibility({ baseDocument: document, candidateDocument: parameterTightened }), /OPENAPI_PARAMETER_BECAME_REQUIRED/);
  const requestTightened = JSON.parse(JSON.stringify(document));
  requestTightened.paths['/orders'].post.requestBody.content['application/json'].schema.required.push('unexpected');
  assert.throws(() => verifyBackwardCompatibility({ baseDocument: document, candidateDocument: requestTightened }), /OPENAPI_REQUEST_PROPERTY_BECAME_REQUIRED/);
  const responseChanged = JSON.parse(JSON.stringify(document));
  responseChanged.paths['/orders'].post.responses['201'].content['application/json'].schema.properties.order.type = 'string';
  assert.throws(() => verifyBackwardCompatibility({ baseDocument: document, candidateDocument: responseChanged }), /OPENAPI_RESPONSE_SCHEMA_CHANGED/);
  const enumNarrowed = JSON.parse(JSON.stringify(document));
  enumNarrowed.paths['/orders/{id}'].get.responses['200'].content['application/json'].schema.properties.order.properties.status.enum = ['CONFIRMED'];
  assert.throws(() => verifyBackwardCompatibility({ baseDocument: document, candidateDocument: enumNarrowed }), /OPENAPI_ENUM_NARROWED/);
});

test('OpenAPI compatibility CLI requires a base revision', () => {
  const result = spawnSync(process.execPath, [
    'scripts/verify-openapi-backward-compatibility.mjs',
    '--candidate', 'openapi/mini-commerce.v1.yaml',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPENAPI_COMPATIBILITY_USAGE/);
});
