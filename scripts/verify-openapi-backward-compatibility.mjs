import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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
