#!/usr/bin/env node

import fs from 'node:fs';

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const rootKeys = [
  'schemaVersion', 'environment', 'region', 'sourceSha', 'workflow', 'image',
  'attestation', 'gitops', 'cluster', 'slo', 'issuedAt', 'expiresAt',
];
const nestedKeys = {
  workflow: ['name', 'event', 'runId', 'runAttempt', 'runUrl'],
  image: ['repository', 'indexDigest', 'platforms'],
  attestation: ['githubId', 'githubUrl', 'ociSbomDigest', 'ociProvenanceDigest'],
  gitops: ['devRevision'],
  cluster: ['arn'],
  slo: ['evidenceId'],
};

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) throw new Error(`unexpected ${label} key ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`missing ${label} key ${key}`);
  }
}

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
}

export function createDevReadyEvidence(input, now = new Date()) {
  assertExactKeys(input, rootKeys, 'root');
  for (const [name, keys] of Object.entries(nestedKeys)) assertExactKeys(input[name], keys, name);

  if (input.schemaVersion !== 'course.dev-ready/v1') throw new Error('unsupported DEV_READY schemaVersion');
  if (input.environment !== 'dev') throw new Error('DEV_READY environment must equal dev');
  if (!['ap-northeast-2', 'us-east-1'].includes(input.region)) throw new Error('unsupported DEV_READY region');
  if (!shaPattern.test(input.sourceSha)) throw new Error('invalid DEV_READY sourceSha');
  if (input.workflow.name !== 'ci') throw new Error('DEV_READY workflow.name must equal ci');
  requireNonEmpty(input.workflow.event, 'workflow.event');
  if (!/^\d+$/.test(input.workflow.runId)) throw new Error('invalid workflow.runId');
  if (!Number.isInteger(input.workflow.runAttempt) || input.workflow.runAttempt < 1) throw new Error('invalid workflow.runAttempt');
  requireNonEmpty(input.workflow.runUrl, 'workflow.runUrl');
  requireNonEmpty(input.image.repository, 'image.repository');
  if (!digestPattern.test(input.image.indexDigest)) throw new Error('invalid image.indexDigest');
  if (JSON.stringify(input.image.platforms) !== JSON.stringify(['linux/amd64', 'linux/arm64'])) {
    throw new Error('image.platforms must equal linux/amd64,linux/arm64');
  }
  requireNonEmpty(input.attestation.githubId, 'attestation.githubId');
  requireNonEmpty(input.attestation.githubUrl, 'attestation.githubUrl');
  for (const key of ['ociSbomDigest', 'ociProvenanceDigest']) {
    if (!digestPattern.test(input.attestation[key])) throw new Error(`invalid attestation.${key}`);
  }
  if (!shaPattern.test(input.gitops.devRevision)) throw new Error('invalid gitops.devRevision');
  if (!input.cluster.arn.startsWith(`arn:aws:eks:${input.region}:`)) throw new Error('cluster.arn region mismatch');
  requireNonEmpty(input.slo.evidenceId, 'slo.evidenceId');

  const issuedAt = new Date(input.issuedAt);
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(issuedAt.valueOf()) || Number.isNaN(expiresAt.valueOf()) || expiresAt <= issuedAt) {
    throw new Error('invalid DEV_READY evidence lifetime');
  }
  if (expiresAt <= now) throw new Error('expired DEV_READY evidence');
  return structuredClone(input);
}

export function verifyDevReadyEvidence(evidence, now = new Date()) {
  return createDevReadyEvidence(evidence, now);
}

export function verifyProdBaselineEvidence({ prodBaselineDigest, candidateDigest }) {
  if (!digestPattern.test(prodBaselineDigest) || !digestPattern.test(candidateDigest)) {
    throw new Error('invalid Prod baseline or candidate digest');
  }
  if (prodBaselineDigest === candidateDigest) {
    throw new Error('CANDIDATE_DIGEST_MUST_DIFFER_FROM_PROD_BASELINE');
  }
  return { prodBaselineDigest, candidateDigest };
}

export function createDevReadyFromSupplyChain(supplyChain, metadata, now = new Date()) {
  return createDevReadyEvidence({
    schemaVersion: 'course.dev-ready/v1',
    environment: 'dev',
    region: metadata.region,
    sourceSha: supplyChain.sourceSha,
    workflow: {
      name: supplyChain.workflowName,
      event: supplyChain.workflowEvent,
      runId: String(supplyChain.runId),
      runAttempt: supplyChain.runAttempt,
      runUrl: supplyChain.runUrl,
    },
    image: {
      repository: supplyChain.imageRepository,
      indexDigest: supplyChain.imageDigest,
      platforms: ['linux/amd64', 'linux/arm64'],
    },
    attestation: {
      githubId: String(supplyChain.githubAttestation.id),
      githubUrl: supplyChain.githubAttestation.url,
      ociSbomDigest: supplyChain.ociReferrers.sbomDigest,
      ociProvenanceDigest: supplyChain.ociReferrers.provenanceDigest,
    },
    gitops: { devRevision: metadata.devRevision },
    cluster: { arn: metadata.clusterArn },
    slo: { evidenceId: metadata.sloEvidenceId },
    issuedAt: metadata.issuedAt,
    expiresAt: metadata.expiresAt,
  }, now);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, inputFile, outputFile] = process.argv.slice(2);
  if (command === 'verify' && inputFile) {
    const evidence = verifyDevReadyEvidence(JSON.parse(fs.readFileSync(inputFile, 'utf8')));
    if (process.env.EXPECTED_RUN_ID && evidence.workflow.runId !== process.env.EXPECTED_RUN_ID) {
      throw new Error('DEV_READY workflow.runId mismatch');
    }
    if (process.env.EXPECTED_DIGEST && evidence.image.indexDigest !== process.env.EXPECTED_DIGEST) {
      throw new Error('DEV_READY image.indexDigest mismatch');
    }
    console.log('PASS: canonical DEV_READY evidence');
  } else if (command === 'from-supply' && inputFile && outputFile) {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.valueOf() + (2 * 60 * 60 * 1000));
    const evidence = createDevReadyFromSupplyChain(
      JSON.parse(fs.readFileSync(inputFile, 'utf8')),
      {
        region: process.env.AWS_REGION,
        devRevision: process.env.DEV_GITOPS_REVISION,
        clusterArn: process.env.DEV_CLUSTER_ARN,
        sloEvidenceId: process.env.DEV_SLO_EVIDENCE_ID,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      issuedAt,
    );
    fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log('PASS: canonical DEV_READY evidence created');
  } else {
    throw new Error('usage: dev-ready-evidence.mjs verify FILE | from-supply SUPPLY_JSON OUTPUT_JSON');
  }
}
