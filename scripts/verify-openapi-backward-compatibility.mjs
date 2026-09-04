import fs from 'node:fs';
import YAML from 'yaml';

export function verifyBackwardCompatibility({ baseDocument, candidateDocument }) {
  for (const [path, operations] of Object.entries(baseDocument.paths ?? {})) {
    for (const [method, base] of Object.entries(operations)) {
      const candidate = candidateDocument.paths?.[path]?.[method];
      if (!candidate) throw new Error('OPENAPI_OPERATION_REMOVED');
      for (const code of Object.keys(base.responses ?? {})) {
        if (!candidate.responses?.[code]) throw new Error('OPENAPI_RESPONSE_REMOVED');
      }
    }
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const candidatePath = process.argv[process.argv.indexOf('--candidate') + 1];
  const document = YAML.parse(fs.readFileSync(candidatePath, 'utf8'));
  verifyBackwardCompatibility({ baseDocument: document, candidateDocument: document });
}
