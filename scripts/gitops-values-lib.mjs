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
