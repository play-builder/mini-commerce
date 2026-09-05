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

test('OpenAPI input requiredness can relax but cannot tighten', () => {
  const document = YAML.parse(fs.readFileSync(new URL('../openapi/mini-commerce.v1.yaml', import.meta.url), 'utf8'));

  const relaxed = JSON.parse(JSON.stringify(document));
  relaxed.paths['/orders'].post.parameters[0].required = false;
  relaxed.paths['/orders'].post.requestBody.required = false;
  assert.doesNotThrow(() => verifyBackwardCompatibility({
    baseDocument: document,
    candidateDocument: relaxed,
  }));

  const optionalBase = JSON.parse(JSON.stringify(document));
  optionalBase.paths['/orders'].post.parameters[0].required = false;
  optionalBase.paths['/orders'].post.requestBody.required = false;

  const requiredCandidate = JSON.parse(JSON.stringify(optionalBase));
  requiredCandidate.paths['/orders'].post.parameters[0].required = true;
  assert.throws(() => verifyBackwardCompatibility({
    baseDocument: optionalBase,
    candidateDocument: requiredCandidate,
  }), /OPENAPI_PARAMETER_BECAME_REQUIRED/);

  const requiredBody = JSON.parse(JSON.stringify(optionalBase));
  requiredBody.paths['/orders'].post.requestBody.required = true;
  assert.throws(() => verifyBackwardCompatibility({
    baseDocument: optionalBase,
    candidateDocument: requiredBody,
  }), /OPENAPI_REQUEST_BODY_BECAME_REQUIRED/);

  const newRequiredParameter = JSON.parse(JSON.stringify(document));
  newRequiredParameter.paths['/orders'].post.parameters.push({
    name: 'X-Required', in: 'header', required: true, schema: { type: 'string' },
  });
  assert.throws(() => verifyBackwardCompatibility({
    baseDocument: document,
    candidateDocument: newRequiredParameter,
  }), /OPENAPI_REQUIRED_PARAMETER_ADDED/);
});

test('OpenAPI request schemas reject type and bound narrowing recursively', () => {
  const baseDocument = YAML.parse(fs.readFileSync(new URL('../openapi/mini-commerce.v1.yaml', import.meta.url), 'utf8'));
  const baseSchema = baseDocument.paths['/orders'].post.requestBody.content['application/json'].schema;
  baseSchema.properties.items = {
    type: 'array',
    minItems: 1,
    maxItems: 20,
    items: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId: { type: 'integer', minimum: 1, maximum: 999999 },
        note: { type: 'string', minLength: 0, maxLength: 200 },
      },
    },
  };

  const mutations = [
    ['type', (schema) => { schema.properties.items.items.properties.productId.type = 'string'; }, /OPENAPI_SCHEMA_TYPE_CHANGED/],
    ['minimum', (schema) => { schema.properties.items.items.properties.productId.minimum = 2; }, /OPENAPI_SCHEMA_BOUND_NARROWED/],
    ['maximum', (schema) => { schema.properties.items.items.properties.productId.maximum = 100; }, /OPENAPI_SCHEMA_BOUND_NARROWED/],
    ['minLength', (schema) => { schema.properties.items.items.properties.note.minLength = 1; }, /OPENAPI_SCHEMA_BOUND_NARROWED/],
    ['maxLength', (schema) => { schema.properties.items.items.properties.note.maxLength = 100; }, /OPENAPI_SCHEMA_BOUND_NARROWED/],
    ['minItems', (schema) => { schema.properties.items.minItems = 2; }, /OPENAPI_SCHEMA_BOUND_NARROWED/],
    ['maxItems', (schema) => { schema.properties.items.maxItems = 10; }, /OPENAPI_SCHEMA_BOUND_NARROWED/],
    ['items required', (schema) => { schema.properties.items.items.required.push('note'); }, /OPENAPI_REQUEST_PROPERTY_BECAME_REQUIRED/],
  ];

  for (const [label, mutate, expected] of mutations) {
    const candidateDocument = JSON.parse(JSON.stringify(baseDocument));
    mutate(candidateDocument.paths['/orders'].post.requestBody.content['application/json'].schema);
    assert.throws(() => verifyBackwardCompatibility({ baseDocument, candidateDocument }), expected, label);
  }

  const unconstrainedBase = JSON.parse(JSON.stringify(baseDocument));
  delete unconstrainedBase.paths['/orders'].post.requestBody.content['application/json']
    .schema.properties.items.items.properties.note.type;
  const constrainedCandidate = JSON.parse(JSON.stringify(unconstrainedBase));
  constrainedCandidate.paths['/orders'].post.requestBody.content['application/json']
    .schema.properties.items.items.properties.note.type = 'string';
  assert.throws(() => verifyBackwardCompatibility({
    baseDocument: unconstrainedBase,
    candidateDocument: constrainedCandidate,
  }), /OPENAPI_SCHEMA_TYPE_CHANGED/);

  const enumCandidate = JSON.parse(JSON.stringify(unconstrainedBase));
  enumCandidate.paths['/orders'].post.requestBody.content['application/json']
    .schema.properties.items.items.properties.note.enum = ['internal'];
  assert.throws(() => verifyBackwardCompatibility({
    baseDocument: unconstrainedBase,
    candidateDocument: enumCandidate,
  }), /OPENAPI_ENUM_NARROWED/);
});

test('OpenAPI compatibility CLI requires a base revision', () => {
  const result = spawnSync(process.execPath, [
    'scripts/verify-openapi-backward-compatibility.mjs',
    '--candidate', 'openapi/mini-commerce.v1.yaml',
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPENAPI_COMPATIBILITY_USAGE/);
});
