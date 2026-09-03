#!/usr/bin/env node

import fs from 'node:fs';

const requiredKeys = [
  'schemaVersion', 'evidenceGrade', 'observedAt', 'upstreamEvidence',
  'sourceSha', 'runUrl', 'runId', 'imageDigest', 'attestation', 'devGitopsSha',
  'prodGitopsSha', 'argoRevision', 'rolloutRevision', 'analysisRun', 'slo',
  'rollbackCandidates', 'cleanup',
];
const digestPattern = /^sha256:[0-9a-f]{64}$/;

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) throw new Error(`unexpected ${label} key ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
}

export function exportReleaseEvidence(record, now = new Date()) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('release evidence must be an object');
  }
  assertExactKeys(record, requiredKeys, 'release evidence');
  for (const key of requiredKeys) {
    if (isMissing(record[key])) throw new Error(`${key} is required`);
  }
  if (record.schemaVersion !== 'course.release-evidence/v1') {
    throw new Error('unsupported release evidence schemaVersion');
  }
  if (record.evidenceGrade !== 'INCIDENT_EVIDENCE') {
    throw new Error('release evidenceGrade must equal INCIDENT_EVIDENCE');
  }
  const observedAt = new Date(record.observedAt);
  if (Number.isNaN(observedAt.valueOf())) throw new Error('invalid release evidence observedAt');
  if (observedAt > now) throw new Error('future release evidence is not allowed');
  assertExactKeys(record.upstreamEvidence, [
    'devReadyDigest', 'prodBaselineDigest', 'prodSloDigest', 'incidentIndexDigest',
  ], 'upstreamEvidence');
  for (const key of [
    'devReadyDigest', 'prodBaselineDigest', 'prodSloDigest', 'incidentIndexDigest',
  ]) {
    if (!digestPattern.test(record.upstreamEvidence[key])) {
      throw new Error(`invalid upstreamEvidence.${key}`);
    }
  }
  for (const key of ['sourceSha', 'devGitopsSha', 'prodGitopsSha', 'argoRevision']) {
    if (!/^[0-9a-f]{40}$/.test(record[key])) throw new Error(`invalid ${key}`);
  }
  if (record.argoRevision !== record.prodGitopsSha) throw new Error('argoRevision must equal prodGitopsSha');
  if (!/^\d+$/.test(String(record.runId))) throw new Error('invalid runId');
  const run = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(record.runUrl);
  if (!run || run[2] !== String(record.runId)) throw new Error('runUrl must match runId');
  if (!digestPattern.test(record.imageDigest)) throw new Error('invalid imageDigest');
  assertExactKeys(record.attestation, [
    'githubId', 'githubUrl', 'ociSbomDigest', 'ociProvenanceDigest',
  ], 'attestation');
  if (!/^\d+$/.test(String(record.attestation.githubId))) throw new Error('invalid attestation.githubId');
  if (record.attestation.githubUrl !== `https://github.com/${run[1]}/attestations/${record.attestation.githubId}`) {
    throw new Error('attestation.githubUrl mismatch');
  }
  for (const key of ['ociSbomDigest', 'ociProvenanceDigest']) {
    if (!digestPattern.test(record.attestation[key])) throw new Error(`invalid attestation.${key}`);
  }
  if (!Number.isSafeInteger(record.rolloutRevision) || record.rolloutRevision < 1) {
    throw new Error('invalid rolloutRevision');
  }
  assertExactKeys(record.analysisRun, ['name', 'state'], 'analysisRun');
  if (typeof record.analysisRun.name !== 'string' || record.analysisRun.name.length === 0) {
    throw new Error('analysisRun.name is required');
  }
  if (record.analysisRun.state !== 'Successful') throw new Error('analysisRun.state must equal Successful');
  assertExactKeys(record.slo, ['evidenceId', 'status'], 'slo');
  if (typeof record.slo.evidenceId !== 'string' || record.slo.evidenceId.length === 0) {
    throw new Error('slo.evidenceId is required');
  }
  if (record.slo.status !== 'PASS') throw new Error('slo.status must equal PASS');
  if (!Array.isArray(record.rollbackCandidates) || record.rollbackCandidates.length === 0) {
    throw new Error('rollbackCandidates must be a nonempty array');
  }
  if (record.rollbackCandidates.some((candidate) => (
    (() => {
      try {
        assertExactKeys(candidate, [
          'imageDigest', 'productReadContract', 'rolloutRevision', 'gitRevertSha', 'podTemplateHash',
        ], 'rollback candidate');
      } catch {
        return true;
      }
      return candidate.productReadContract !== 'v2prime'
        || !digestPattern.test(candidate.imageDigest)
        || !Number.isSafeInteger(candidate.rolloutRevision)
        || candidate.rolloutRevision < 1
        || !/^[0-9a-f]{40}$/.test(candidate.gitRevertSha)
        || typeof candidate.podTemplateHash !== 'string'
        || candidate.podTemplateHash.length === 0;
    })()
  ))) {
    throw new Error('rollbackCandidates must all use v2prime with immutable digests');
  }
  assertExactKeys(record.cleanup, ['reconcileFrozen', 'desiredStateRemoved', 'residualScan'], 'cleanup');
  if (record.cleanup.reconcileFrozen !== true
    || record.cleanup.desiredStateRemoved !== true
    || record.cleanup.residualScan !== 'PASS') {
    throw new Error('cleanup completion contract mismatch');
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
