import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

export function verifyBackwardCompatibility({ baseDocument, candidateDocument }) {
  const required = (value) => new Set(value ?? []);
  const assertEnumNotNarrowed = (baseSchema, candidateSchema) => {
    if (baseSchema?.enum && (!candidateSchema?.enum
      || baseSchema.enum.some((value) => !candidateSchema.enum.includes(value)))) {
      throw new Error('OPENAPI_ENUM_NARROWED');
    }
    for (const [name, schema] of Object.entries(baseSchema?.properties ?? {})) {
      assertEnumNotNarrowed(schema, candidateSchema?.properties?.[name]);
    }
    if (baseSchema?.items) assertEnumNotNarrowed(baseSchema.items, candidateSchema?.items);
  };
  const assertInputSchemaNotNarrowed = (baseSchema, candidateSchema) => {
    if (!baseSchema || !candidateSchema) return;
    if (candidateSchema.type !== undefined
      && (baseSchema.type === undefined
        || JSON.stringify(baseSchema.type) !== JSON.stringify(candidateSchema.type))) {
      throw new Error('OPENAPI_SCHEMA_TYPE_CHANGED');
    }
    if (candidateSchema.enum && (!baseSchema.enum
      || baseSchema.enum.some((value) => !candidateSchema.enum.includes(value)))) {
      throw new Error('OPENAPI_ENUM_NARROWED');
    }
    for (const field of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']) {
      if (candidateSchema[field] !== undefined
        && (baseSchema[field] === undefined || candidateSchema[field] > baseSchema[field])) {
        throw new Error('OPENAPI_SCHEMA_BOUND_NARROWED');
      }
    }
    for (const field of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']) {
      if (candidateSchema[field] !== undefined
        && (baseSchema[field] === undefined || candidateSchema[field] < baseSchema[field])) {
        throw new Error('OPENAPI_SCHEMA_BOUND_NARROWED');
      }
    }
    if (candidateSchema.pattern !== undefined && candidateSchema.pattern !== baseSchema.pattern) {
      throw new Error('OPENAPI_SCHEMA_BOUND_NARROWED');
    }
    const baseRequired = required(baseSchema.required);
    for (const property of required(candidateSchema.required)) {
      if (!baseRequired.has(property)) throw new Error('OPENAPI_REQUEST_PROPERTY_BECAME_REQUIRED');
    }
    for (const [name, schema] of Object.entries(baseSchema?.properties ?? {})) {
      assertInputSchemaNotNarrowed(schema, candidateSchema?.properties?.[name]);
    }
    if (baseSchema?.items) assertInputSchemaNotNarrowed(baseSchema.items, candidateSchema?.items);
  };
  for (const [path, operations] of Object.entries(baseDocument.paths ?? {})) {
    for (const [method, base] of Object.entries(operations)) {
      const candidate = candidateDocument.paths?.[path]?.[method];
      if (!candidate) throw new Error('OPENAPI_OPERATION_REMOVED');
      const baseParameters = new Map((base.parameters ?? []).map((parameter) => [`${parameter.in}:${parameter.name}`, parameter]));
      const candidateParameters = new Map((candidate.parameters ?? []).map((parameter) => [`${parameter.in}:${parameter.name}`, parameter]));
      for (const parameter of base.parameters ?? []) {
        const replacement = candidateParameters.get(`${parameter.in}:${parameter.name}`);
        if (!parameter.required && replacement?.required) throw new Error('OPENAPI_PARAMETER_BECAME_REQUIRED');
        assertInputSchemaNotNarrowed(parameter.schema, replacement?.schema);
      }
      for (const parameter of candidate.parameters ?? []) {
        if (parameter.required && !baseParameters.has(`${parameter.in}:${parameter.name}`)) {
          throw new Error('OPENAPI_REQUIRED_PARAMETER_ADDED');
        }
      }
      if (!base.requestBody?.required && candidate.requestBody?.required) {
        throw new Error('OPENAPI_REQUEST_BODY_BECAME_REQUIRED');
      }
      const baseRequestSchema = base.requestBody?.content?.['application/json']?.schema;
      const candidateRequestSchema = candidate.requestBody?.content?.['application/json']?.schema;
      assertInputSchemaNotNarrowed(baseRequestSchema, candidateRequestSchema);
      for (const code of Object.keys(base.responses ?? {})) {
        if (!candidate.responses?.[code]) throw new Error('OPENAPI_RESPONSE_REMOVED');
        const baseSchema = base.responses[code].content?.['application/json']?.schema;
        const candidateSchema = candidate.responses[code].content?.['application/json']?.schema;
        assertEnumNotNarrowed(baseSchema, candidateSchema);
        if (JSON.stringify(baseSchema ?? null) !== JSON.stringify(candidateSchema ?? null)) {
          throw new Error('OPENAPI_RESPONSE_SCHEMA_CHANGED');
        }
      }
    }
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const valueAfter = (flag) => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const candidatePath = valueAfter('--candidate');
  const baseRef = valueAfter('--base-ref');
  const bootstrapBaseSha = valueAfter('--bootstrap-base-sha');
  if (!candidatePath || !baseRef) throw new Error('OPENAPI_COMPATIBILITY_USAGE');

  const candidateDocument = YAML.parse(fs.readFileSync(candidatePath, 'utf8'));
  let baseSource;
  try {
    baseSource = execFileSync('git', ['show', `${baseRef}:${candidatePath}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    if (baseRef !== bootstrapBaseSha) throw new Error('OPENAPI_BASE_DOCUMENT_MISSING');
    baseSource = fs.readFileSync(candidatePath, 'utf8');
  }
  verifyBackwardCompatibility({ baseDocument: YAML.parse(baseSource), candidateDocument });
}
