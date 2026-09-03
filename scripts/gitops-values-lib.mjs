import fs from 'node:fs';

const digestPattern = /^sha256:[0-9a-f]{64}$/;

export function assertImage(repository, digest) {
  if (!repository || /\s/.test(repository)) {
    throw new Error('image repository must be a non-empty value without whitespace');
  }
  if (!digestPattern.test(digest)) {
    throw new Error('image digest must match sha256 followed by 64 lowercase hexadecimal characters');
  }
}

export function readImageBlock(source) {
  const lines = source.split('\n');
  const imageStart = lines.findIndex((line) => line === 'image:');
  if (imageStart < 0) {
    throw new Error('top-level image block was not found');
  }

  let repository;
  let digest;
  for (let index = imageStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[^\s#][^:]*:/.test(line)) {
      break;
    }
    const repositoryMatch = line.match(/^  repository:\s*["']?([^"']+?)["']?\s*$/);
    const digestMatch = line.match(/^  digest:\s*["']?([^"']+?)["']?\s*$/);
    if (repositoryMatch) repository = repositoryMatch[1];
    if (digestMatch) digest = digestMatch[1];
  }

  assertImage(repository, digest);
  return { repository, digest };
}

function findNestedImageStart(lines, parentName, imageName) {
  const parentStart = lines.findIndex((line) => line === `${parentName}:`);
  if (parentStart < 0) throw new Error(`top-level ${parentName} block was not found`);

  for (let index = parentStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[^\s#][^:]*:/.test(line)) break;
    if (line === `  ${imageName}:`) return index;
  }
  throw new Error(`${parentName}.${imageName} block was not found`);
}

function readNestedImage(source, parentName, imageName) {
  const lines = source.split('\n');
  const imageStart = findNestedImageStart(lines, parentName, imageName);
  let repository;
  let digest;

  for (let index = imageStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{0,2}[^\s#][^:]*:/.test(line)) break;
    const repositoryMatch = line.match(/^    repository:\s*["']?([^"']+?)["']?\s*$/);
    const digestMatch = line.match(/^    digest:\s*["']?([^"']+?)["']?\s*$/);
    if (repositoryMatch) repository = repositoryMatch[1];
    if (digestMatch) digest = digestMatch[1];
  }

  assertImage(repository, digest);
  return { repository, digest };
}

export function readMigrationImageBlock(source) {
  return readNestedImage(source, 'database', 'migrationImage');
}

export function updateImageBlock(source, repository, digest) {
  assertImage(repository, digest);
  const lines = source.split('\n');
  const imageStart = lines.findIndex((line) => line === 'image:');
  if (imageStart < 0) {
    throw new Error('top-level image block was not found');
  }

  let repositoryUpdates = 0;
  let digestUpdates = 0;
  for (let index = imageStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[^\s#][^:]*:/.test(line)) {
      break;
    }
    if (/^  repository:/.test(line)) {
      lines[index] = `  repository: "${repository}"`;
      repositoryUpdates += 1;
    }
    if (/^  digest:/.test(line)) {
      lines[index] = `  digest: "${digest}"`;
      digestUpdates += 1;
    }
  }

  if (repositoryUpdates !== 1 || digestUpdates !== 1) {
    throw new Error(`expected one repository and one digest field; found ${repositoryUpdates}/${digestUpdates}`);
  }
  return lines.join('\n');
}

function updateNestedImageBlock(source, parentName, imageName, repository, digest) {
  assertImage(repository, digest);
  const lines = source.split('\n');
  const imageStart = findNestedImageStart(lines, parentName, imageName);
  let repositoryUpdates = 0;
  let digestUpdates = 0;

  for (let index = imageStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{0,2}[^\s#][^:]*:/.test(line)) break;
    if (/^    repository:/.test(line)) {
      lines[index] = `    repository: "${repository}"`;
      repositoryUpdates += 1;
    }
    if (/^    digest:/.test(line)) {
      lines[index] = `    digest: "${digest}"`;
      digestUpdates += 1;
    }
  }

  if (repositoryUpdates !== 1 || digestUpdates !== 1) {
    throw new Error(`expected one migration repository and digest; found ${repositoryUpdates}/${digestUpdates}`);
  }
  return lines.join('\n');
}

export function updateDeliveryImages(source, repository, digest) {
  const applicationUpdated = updateImageBlock(source, repository, digest);
  return updateNestedImageBlock(applicationUpdated, 'database', 'migrationImage', repository, digest);
}

export function promoteDeliveryImages(devSource, prodSource) {
  const applicationImage = readImageBlock(devSource);
  const migrationImage = readMigrationImageBlock(devSource);
  const applicationUpdated = updateImageBlock(
    prodSource,
    applicationImage.repository,
    applicationImage.digest,
  );
  return updateNestedImageBlock(
    applicationUpdated,
    'database',
    'migrationImage',
    migrationImage.repository,
    migrationImage.digest,
  );
}

export function rollbackApplicationImage(source, repository, digest) {
  return updateImageBlock(source, repository, digest);
}

export function classifyRollbackBoundary({
  state,
  applicationDigest,
  stableDigest,
  previousMigrationDigest,
  currentMigrationDigest,
  gitDesiredStateDigest,
  stableHash,
  targetHash,
  replicaSetList,
  rolloutName,
  rolloutUid,
  rollbackWindow,
}) {
  for (const value of [
    applicationDigest, stableDigest, previousMigrationDigest, currentMigrationDigest,
    gitDesiredStateDigest,
  ]) {
    if (!digestPattern.test(value)) throw new Error('rollback evidence contains an invalid digest');
  }
  if (previousMigrationDigest !== currentMigrationDigest) {
    throw new Error('MIGRATION_DIGEST_MUST_REMAIN_UNCHANGED');
  }

  if (state === 'in-progress') {
    if (applicationDigest !== stableDigest) {
      throw new Error('APPLICATION_DIGEST_MUST_MATCH_STABLE');
    }
    if (gitDesiredStateDigest !== stableDigest) {
      throw new Error('GIT_DESIRED_STATE_MUST_MATCH_STABLE');
    }
    return 'in-progress-stable-reapply';
  }
  if (state !== 'completed') throw new Error(`unsupported rollout state: ${state}`);

  const revisions = rollbackWindow?.revisions;
  if (!Number.isSafeInteger(revisions) || revisions < 0) {
    throw new Error('rollbackWindow.revisions must be a non-negative integer');
  }
  if (replicaSetList?.apiVersion !== 'apps/v1'
    || replicaSetList.kind !== 'ReplicaSetList'
    || !Array.isArray(replicaSetList.items)) {
    throw new Error('ROLLBACK_REPLICASET_LIST_INVALID');
  }
  if (typeof rolloutName !== 'string' || rolloutName.length === 0) {
    throw new Error('ROLLBACK_ROLLOUT_NAME_REQUIRED');
  }
  if (typeof rolloutUid !== 'string' || rolloutUid.length === 0) {
    throw new Error('ROLLBACK_ROLLOUT_UID_REQUIRED');
  }
  if (typeof targetHash !== 'string' || targetHash.length === 0
    || typeof stableHash !== 'string' || stableHash.length === 0) {
    throw new Error('ROLLBACK_ENDPOINT_HASHES_REQUIRED');
  }
  if (targetHash === stableHash) throw new Error('ROLLBACK_ENDPOINT_HASHES_MUST_BE_DISTINCT');
  const eligible = replicaSetList.items.filter((replicaSet) => {
    const metadata = replicaSet?.metadata ?? {};
    const owned = metadata.ownerReferences?.some((owner) => (
      owner.kind === 'Rollout'
      && owner.name === rolloutName
      && owner.uid === rolloutUid
      && owner.controller === true
    ));
    return owned && !Object.hasOwn(
      metadata.annotations ?? {},
      'rollouts.argoproj.io/experiment-name',
    );
  }).map((replicaSet) => ({
    podTemplateHash: replicaSet.metadata.labels?.['rollouts-pod-template-hash'],
    creationTimestamp: replicaSet.metadata.creationTimestamp,
  }));
  for (const replicaSet of eligible) {
    if (typeof replicaSet.podTemplateHash !== 'string' || replicaSet.podTemplateHash.length === 0) {
      throw new Error('ROLLBACK_REPLICASET_HASH_INVALID');
    }
    if (!Number.isFinite(Date.parse(replicaSet.creationTimestamp))) {
      throw new Error('ROLLBACK_REPLICASET_TIMESTAMP_INVALID');
    }
  }
  const targets = eligible.filter(({ podTemplateHash }) => podTemplateHash === targetHash);
  const stables = eligible.filter(({ podTemplateHash }) => podTemplateHash === stableHash);
  if (targets.length === 0) throw new Error('ROLLBACK_TARGET_REPLICASET_MISSING');
  if (targets.length > 1) throw new Error('ROLLBACK_TARGET_REPLICASET_DUPLICATE');
  if (stables.length === 0) throw new Error('ROLLBACK_STABLE_REPLICASET_MISSING');
  if (stables.length > 1) throw new Error('ROLLBACK_STABLE_REPLICASET_DUPLICATE');
  const targetTime = Date.parse(targets[0].creationTimestamp);
  const stableTime = Date.parse(stables[0].creationTimestamp);
  if (!Number.isFinite(targetTime) || !Number.isFinite(stableTime)) {
    throw new Error('ROLLBACK_REPLICASET_TIMESTAMP_INVALID');
  }
  if (targetTime >= stableTime) {
    throw new Error('ROLLBACK_TARGET_MUST_BE_OLDER_THAN_STABLE');
  }

  const windowSize = eligible.filter(({ creationTimestamp }) => {
    const timestamp = Date.parse(creationTimestamp);
    return timestamp > targetTime && timestamp < stableTime;
  }).length;
  return windowSize < revisions ? 'completed-window-inside' : 'completed-window-outside';
}

export function setImageInFile(fileName, repository, digest) {
  const source = fs.readFileSync(fileName, 'utf8');
  const updated = updateImageBlock(source, repository, digest);
  fs.writeFileSync(fileName, updated);
}

export function setDeliveryImagesInFile(fileName, repository, digest) {
  const source = fs.readFileSync(fileName, 'utf8');
  fs.writeFileSync(fileName, updateDeliveryImages(source, repository, digest));
}

export function promoteDeliveryImagesInFile(devFileName, prodFileName) {
  const devSource = fs.readFileSync(devFileName, 'utf8');
  const prodSource = fs.readFileSync(prodFileName, 'utf8');
  fs.writeFileSync(prodFileName, promoteDeliveryImages(devSource, prodSource));
}
