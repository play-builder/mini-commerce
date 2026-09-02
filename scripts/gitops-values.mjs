#!/usr/bin/env node

import fs from 'node:fs';

import {
  promoteDeliveryImagesInFile,
  readImageBlock,
  setDeliveryImagesInFile,
  setImageInFile,
} from './gitops-values-lib.mjs';

const [command, ...args] = process.argv.slice(2);

if (command === 'set' && args.length === 3) {
  const [fileName, repository, digest] = args;
  setDeliveryImagesInFile(fileName, repository, digest);
  console.log(`updated application and migration images in ${fileName} -> ${repository}@${digest}`);
} else if (command === 'promote' && (args.length === 2 || args.length === 3)) {
  const [devFile, prodFile, expectedDigest] = args;
  const devImage = readImageBlock(fs.readFileSync(devFile, 'utf8'));
  if (expectedDigest && expectedDigest !== devImage.digest) {
    throw new Error(`requested digest ${expectedDigest} is not the current dev digest ${devImage.digest}`);
  }
  promoteDeliveryImagesInFile(devFile, prodFile);
  console.log(`promoted application and migration images to ${prodFile}`);
} else if (command === 'rollback-app' && args.length === 3) {
  const [fileName, repository, digest] = args;
  setImageInFile(fileName, repository, digest);
  console.log(`rolled back application image in ${fileName} -> ${repository}@${digest}`);
} else {
  console.error('usage: gitops-values.mjs set FILE REPOSITORY DIGEST');
  console.error('   or: gitops-values.mjs promote DEV_FILE PROD_FILE [EXPECTED_DIGEST]');
  console.error('   or: gitops-values.mjs rollback-app FILE REPOSITORY DIGEST');
  process.exit(2);
}
