export const canonicalRepositoryId = '1352247019';

export function normalizeRepositoryId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error('repositoryId must be decimal');
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) throw new Error('repositoryId must be a safe integer');
  return String(numeric);
}

export function resolveExpectedRepositoryId({ expectedRepositoryId, workflowRun } = {}) {
  if (expectedRepositoryId !== undefined) return normalizeRepositoryId(String(expectedRepositoryId));
  if (workflowRun?.repository?.id !== undefined) {
    return normalizeRepositoryId(String(workflowRun.repository.id));
  }
  return canonicalRepositoryId;
}

export function assertRepositoryIdentity({ repositoryId, repositoryName, workflowRun, expectedRepositoryId }) {
  const actualId = normalizeRepositoryId(repositoryId);
  const expectedId = resolveExpectedRepositoryId({ expectedRepositoryId, workflowRun });
  if (actualId !== expectedId) throw new Error('REPOSITORY_ID_MISMATCH');
  if (repositoryName !== undefined && (typeof repositoryName !== 'string' || repositoryName.length === 0)) {
    throw new Error('repositoryName must be nonempty when present');
  }
  if (workflowRun) {
    const runRepositoryId = normalizeRepositoryId(String(workflowRun.repository?.id ?? ''));
    if (runRepositoryId !== actualId) throw new Error('REPOSITORY_ID_MISMATCH');
    if (!Number.isSafeInteger(workflowRun.id) || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+$/.test(workflowRun.html_url ?? '')) {
      throw new Error('invalid workflow run identity');
    }
  }
  return actualId;
}

export function acceptsLegacyRepositoryIdentity(expectedRepositoryId) {
  return normalizeRepositoryId(expectedRepositoryId) === canonicalRepositoryId;
}
