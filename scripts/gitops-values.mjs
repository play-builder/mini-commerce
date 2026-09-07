#!/usr/bin/env node

import {
  promoteDeliveryImagesInFile,
  setDeliveryImagesInFile,
  setImageInFile,
} from './gitops-values-lib.mjs';

const [command, ...args] = process.argv.slice(2);

if (command === 'set' && args.length === 3) {
  const [fileName, repository, digest] = args;
  setDeliveryImagesInFile(fileName, repository, digest);
  console.log(`updated application and migration images in ${fileName} -> ${repository}@${digest}`);
} else if (command === 'promote' && args.length === 4) {
  const [devFile, prodFile, expectedRepository, expectedDigest] = args;
  promoteDeliveryImagesInFile(devFile, prodFile, {
    repository: expectedRepository,
    digest: expectedDigest,
  });
  console.log(`promoted application and migration images to ${prodFile}`);
} else if (command === 'rollback-app' && args.length === 3) {
  const [fileName, repository, digest] = args;
  setImageInFile(fileName, repository, digest);
  console.log(`rolled back application image in ${fileName} -> ${repository}@${digest}`);
} else {
  console.error('usage: gitops-values.mjs set FILE REPOSITORY DIGEST');
  console.error('   or: gitops-values.mjs promote DEV_FILE PROD_FILE EXPECTED_REPOSITORY EXPECTED_DIGEST');
  console.error('   or: gitops-values.mjs rollback-app FILE REPOSITORY DIGEST');
  process.exit(2);
}
