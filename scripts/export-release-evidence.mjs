#!/usr/bin/env node

import fs from 'node:fs';

const requiredKeys = [
  'sourceSha', 'runUrl', 'runId', 'imageDigest', 'attestation', 'devGitopsSha',
  'prodGitopsSha', 'argoRevision', 'rolloutRevision', 'analysisRun', 'slo',
  'rollbackCandidates', 'cleanup',
];
const digestPattern = /^sha256:[0-9a-f]{64}$/;

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

export function exportReleaseEvidence(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('release evidence must be an object');
  }
  for (const key of requiredKeys) {
    if (isMissing(record[key])) throw new Error(`${key} is required`);
  }
  if (!/^[0-9a-f]{40}$/.test(record.sourceSha)) throw new Error('invalid sourceSha');
  if (!digestPattern.test(record.imageDigest)) throw new Error('invalid imageDigest');
  if (typeof record.analysisRun !== 'object' || isMissing(record.analysisRun.state)) {
    throw new Error('analysisRun.state is required');
  }
  if (!Array.isArray(record.rollbackCandidates)) throw new Error('rollbackCandidates must be an array');
  if (record.rollbackCandidates.some((candidate) => (
    candidate.productReadContract !== 'v2prime' || !digestPattern.test(candidate.imageDigest)
  ))) {
    throw new Error('rollbackCandidates must all use v2prime with immutable digests');
  }
  if (!record.cleanup || typeof record.cleanup !== 'object') throw new Error('cleanup is required');
  for (const key of ['reconcileFrozen', 'desiredStateRemoved', 'residualScan']) {
    if (!Object.hasOwn(record.cleanup, key)) throw new Error(`cleanup.${key} is required`);
  }
  const canonical = Object.fromEntries(requiredKeys.map((key) => [key, record[key]]));
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('usage: export-release-evidence.mjs INPUT_JSON OUTPUT_JSON');
  fs.writeFileSync(outputPath, exportReleaseEvidence(JSON.parse(fs.readFileSync(inputPath, 'utf8'))), {
    mode: 0o600,
  });
  console.log('PASS: canonical release evidence exported');
}
