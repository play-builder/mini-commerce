#!/usr/bin/env node

import fs from 'node:fs';
import { verifySupplyChain } from './verify-supply-chain.mjs';

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
const deploymentKeys = [
  'schemaVersion', 'evidenceGrade', 'status', 'source', 'image', 'gitopsRevision',
  'clusterArn', 'region', 'observedAt',
];
const sloKeys = [
  'schemaVersion', 'evidenceGrade', 'status', 'source', 'image', 'gitopsRevision',
  'clusterArn', 'region', 'evidenceId', 'observedAt', 'expiresAt',
];
const prodBaselineKeys = [
  'schemaVersion', 'evidenceGrade', 'image', 'gitopsRevision', 'rollout',
  'clusterArn', 'region', 'observedAt',
];

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
  if (typeof value !== 'string' || value.trim().length === 0
    || /[\uD800-\uDFFF]/u.test(value)) {
    throw new Error(`${label} is required`);
  }
}

function parseTimestamp(value, label) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())
    || parsed.toISOString() !== value.replace(/Z$/, '.000Z')) {
    throw new Error(`invalid ${label}`);
  }
  return parsed;
}

function parseEcrRepository(repository) {
  const match = /^(\d{12})\.dkr\.ecr\.(ap-northeast-2|us-east-1)\.amazonaws\.com\/([a-z0-9]+(?:[._/-][a-z0-9]+)*)$/.exec(repository);
  if (!match || match[3].length < 2 || match[3].length > 256) {
    throw new Error('invalid image.repository');
  }
  return { accountId: match[1], region: match[2], name: match[3] };
}

function parseClusterArn(arn) {
  const match = /^arn:aws:eks:(ap-northeast-2|us-east-1):(\d{12}):cluster\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/.exec(arn);
  if (!match) throw new Error('invalid cluster.arn');
  return { region: match[1], accountId: match[2], name: match[3] };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function validateRawDeployment(deployment) {
  assertExactKeys(deployment, deploymentKeys, 'deployment');
  assertExactKeys(deployment.status, ['sync', 'health'], 'deployment.status');
  assertExactKeys(deployment.source, ['repository', 'sha'], 'deployment.source');
  assertExactKeys(deployment.image, ['repository', 'indexDigest'], 'deployment.image');
  if (deployment.schemaVersion !== 'course.dev-deployment/v1') throw new Error('unsupported deployment schemaVersion');
  if (deployment.evidenceGrade !== 'CLOUD_RUNTIME') throw new Error('deployment evidenceGrade must equal CLOUD_RUNTIME');
  if (deployment.status.sync !== 'Synced' || deployment.status.health !== 'Healthy') {
    throw new Error('deployment must be Synced and Healthy');
  }
  parseTimestamp(deployment.observedAt, 'deployment.observedAt');
}

function validateRawSlo(slo) {
  assertExactKeys(slo, sloKeys, 'slo evidence');
  assertExactKeys(slo.source, ['repository', 'sha'], 'slo.source');
  assertExactKeys(slo.image, ['repository', 'indexDigest'], 'slo.image');
  if (slo.schemaVersion !== 'course.dev-slo/v1') throw new Error('unsupported SLO schemaVersion');
  if (slo.evidenceGrade !== 'CLOUD_RUNTIME') throw new Error('SLO evidenceGrade must equal CLOUD_RUNTIME');
  if (slo.status !== 'PASS') throw new Error('SLO status must equal PASS');
  const observedAt = parseTimestamp(slo.observedAt, 'slo.observedAt');
  const expiresAt = parseTimestamp(slo.expiresAt, 'slo.expiresAt');
  if (expiresAt <= observedAt) throw new Error('invalid SLO evidence lifetime');
}

export function createDevReadyEvidence(input, now = new Date()) {
  assertExactKeys(input, rootKeys, 'root');
  for (const [name, keys] of Object.entries(nestedKeys)) assertExactKeys(input[name], keys, name);
  if (input.schemaVersion !== 'course.dev-ready/v1') throw new Error('unsupported DEV_READY schemaVersion');
  if (input.environment !== 'dev') throw new Error('DEV_READY environment must equal dev');
  if (!['ap-northeast-2', 'us-east-1'].includes(input.region)) throw new Error('unsupported DEV_READY region');
  if (!shaPattern.test(input.sourceSha)) throw new Error('invalid DEV_READY sourceSha');
  if (input.workflow.name !== 'ci') throw new Error('DEV_READY workflow.name must equal ci');
  if (input.workflow.event !== 'push') throw new Error('DEV_READY workflow.event must equal push');
  if (typeof input.workflow.runId !== 'string' || !/^\d+$/.test(input.workflow.runId)) {
    throw new Error('invalid workflow.runId');
  }
  if (!Number.isInteger(input.workflow.runAttempt) || input.workflow.runAttempt < 1) throw new Error('invalid workflow.runAttempt');
  const runUrl = /^https:\/\/github\.com\/([^/\s]+\/cicd-course-sample-app)\/actions\/runs\/(\d+)$/.exec(input.workflow.runUrl);
  if (!runUrl || runUrl[2] !== input.workflow.runId) throw new Error('invalid workflow.runUrl');
  const ecr = parseEcrRepository(input.image.repository);
  if (ecr.region !== input.region) throw new Error('image repository region mismatch');
  if (!digestPattern.test(input.image.indexDigest)) throw new Error('invalid image.indexDigest');
  if (JSON.stringify(input.image.platforms) !== JSON.stringify(['linux/amd64', 'linux/arm64'])) {
    throw new Error('image.platforms must equal linux/amd64,linux/arm64');
  }
  if (typeof input.attestation.githubId !== 'string'
    || !/^\d+$/.test(input.attestation.githubId)) {
    throw new Error('invalid attestation.githubId');
  }
  requireNonEmpty(input.attestation.githubUrl, 'attestation.githubUrl');
  if (input.attestation.githubUrl
    !== `https://github.com/${runUrl[1]}/attestations/${input.attestation.githubId}`) {
    throw new Error('invalid attestation.githubUrl');
  }
  for (const key of ['ociSbomDigest', 'ociProvenanceDigest']) {
    if (!digestPattern.test(input.attestation[key])) throw new Error(`invalid attestation.${key}`);
  }
  if (!shaPattern.test(input.gitops.devRevision)) throw new Error('invalid gitops.devRevision');
  const cluster = parseClusterArn(input.cluster.arn);
  if (cluster.region !== input.region) throw new Error('cluster.arn region mismatch');
  if (cluster.accountId !== ecr.accountId) throw new Error('ECR and EKS account mismatch');
  requireNonEmpty(input.slo.evidenceId, 'slo.evidenceId');
  const issuedAt = parseTimestamp(input.issuedAt, 'DEV_READY issuedAt');
  const expiresAt = parseTimestamp(input.expiresAt, 'DEV_READY expiresAt');
  if (expiresAt <= issuedAt) throw new Error('invalid DEV_READY evidence lifetime');
  if (issuedAt > now) throw new Error('future issuedAt is not allowed');
  if (expiresAt <= now) throw new Error('expired DEV_READY evidence');
  return structuredClone(input);
}

export function verifyDevReadyEvidence(evidence, expected = {}, now = new Date()) {
  const verified = createDevReadyEvidence(evidence, now);
  const repository = expected.githubRepository;
  if (repository) {
    assertEqual(verified.workflow.runUrl, `https://github.com/${repository}/actions/runs/${verified.workflow.runId}`, 'workflow.runUrl');
    assertEqual(verified.attestation.githubUrl, `https://github.com/${repository}/attestations/${verified.attestation.githubId}`, 'attestation.githubUrl');
  }
  if (expected.workflowRun) {
    const run = expected.workflowRun;
    if (run.status !== 'completed') throw new Error('workflowRun.status must equal completed');
    if (run.conclusion !== 'success') throw new Error('workflowRun.conclusion must equal success');
    if (run.head_branch !== 'main') throw new Error('workflowRun.head_branch must equal main');
    assertEqual(verified.workflow.runId, String(run.id), 'workflow.runId');
    assertEqual(verified.workflow.runAttempt, run.run_attempt, 'workflow.runAttempt');
    assertEqual(verified.workflow.runUrl, run.html_url, 'workflow.runUrl');
    assertEqual(verified.sourceSha, run.head_sha, 'sourceSha');
    assertEqual(verified.workflow.event, run.event, 'workflow.event');
    assertEqual(verified.workflow.name, run.name, 'workflow.name');
  }
  if (expected.supplyChain) {
    const supply = expected.supplyChain;
    assertEqual(verified.sourceSha, supply.sourceSha, 'sourceSha');
    assertEqual(verified.image.repository, supply.imageRepository, 'image.repository');
    assertEqual(verified.image.indexDigest, supply.imageDigest, 'image.indexDigest');
    assertEqual(verified.attestation.githubId, String(supply.githubAttestation.id), 'attestation.githubId');
    assertEqual(verified.attestation.githubUrl, supply.githubAttestation.url, 'attestation.githubUrl');
    assertEqual(verified.attestation.ociSbomDigest, supply.ociReferrers.sbomDigest, 'attestation.ociSbomDigest');
    assertEqual(verified.attestation.ociProvenanceDigest, supply.ociReferrers.provenanceDigest, 'attestation.ociProvenanceDigest');
  }
  if (expected.deployment) {
    assertEqual(verified.sourceSha, expected.deployment.source.sha, 'deployment sourceSha');
    assertEqual(verified.image.repository, expected.deployment.image.repository, 'deployment image.repository');
    assertEqual(verified.image.indexDigest, expected.deployment.image.indexDigest, 'deployment image.indexDigest');
    assertEqual(verified.gitops.devRevision, expected.deployment.gitopsRevision, 'deployment gitopsRevision');
    assertEqual(verified.cluster.arn, expected.deployment.clusterArn, 'deployment clusterArn');
  }
  if (expected.slo) {
    assertEqual(verified.slo.evidenceId, expected.slo.evidenceId, 'slo.evidenceId');
    if (expected.slo.source) assertEqual(verified.sourceSha, expected.slo.source.sha, 'SLO sourceSha');
    if (expected.slo.image) assertEqual(verified.image.indexDigest, expected.slo.image.indexDigest, 'SLO image.indexDigest');
    if (expected.slo.gitopsRevision) assertEqual(verified.gitops.devRevision, expected.slo.gitopsRevision, 'SLO gitopsRevision');
  }
  return verified;
}

export function verifyProdBaselineEvidence({ prodBaseline, candidateEvidence }, now = new Date()) {
  assertExactKeys(prodBaseline, prodBaselineKeys, 'Prod baseline');
  assertExactKeys(prodBaseline.image, ['repository', 'indexDigest'], 'Prod baseline.image');
  assertExactKeys(prodBaseline.rollout, ['stableHash', 'revision', 'trafficWeight'], 'Prod baseline.rollout');
  if (prodBaseline.schemaVersion !== 'course.prod-baseline/v1') throw new Error('unsupported Prod baseline schemaVersion');
  if (prodBaseline.evidenceGrade !== 'CLOUD_RUNTIME') throw new Error('Prod baseline evidenceGrade must equal CLOUD_RUNTIME');
  if (!['ap-northeast-2', 'us-east-1'].includes(prodBaseline.region)) throw new Error('unsupported Prod baseline region');
  if (!shaPattern.test(prodBaseline.gitopsRevision)) throw new Error('invalid Prod baseline gitopsRevision');
  if (!digestPattern.test(prodBaseline.image.indexDigest)) throw new Error('invalid Prod baseline image digest');
  requireNonEmpty(prodBaseline.rollout.stableHash, 'Prod baseline rollout.stableHash');
  if (prodBaseline.rollout.revision !== 1 || prodBaseline.rollout.trafficWeight !== 100) {
    throw new Error('Prod baseline must be stable revision 1 at 100 percent traffic');
  }
  const baselineEcr = parseEcrRepository(prodBaseline.image.repository);
  const baselineCluster = parseClusterArn(prodBaseline.clusterArn);
  if (baselineEcr.region !== prodBaseline.region || baselineCluster.region !== prodBaseline.region) {
    throw new Error('Prod baseline region mismatch');
  }
  if (baselineEcr.accountId !== baselineCluster.accountId) throw new Error('Prod baseline account mismatch');
  const observedAt = parseTimestamp(prodBaseline.observedAt, 'Prod baseline observedAt');
  if (observedAt > now) throw new Error('future Prod baseline observedAt is not allowed');

  const candidate = createDevReadyEvidence(candidateEvidence, now);
  assertEqual(candidate.region, prodBaseline.region, 'Prod baseline candidate region');
  assertEqual(candidate.image.repository, prodBaseline.image.repository, 'Prod baseline candidate repository');
  if (candidate.cluster.arn === prodBaseline.clusterArn) {
    throw new Error('PROD_CLUSTER_MUST_DIFFER_FROM_DEV_CLUSTER');
  }
  const candidateEcr = parseEcrRepository(candidate.image.repository);
  if (candidateEcr.accountId !== baselineCluster.accountId) throw new Error('Prod baseline candidate account mismatch');
  if (prodBaseline.image.indexDigest === candidate.image.indexDigest) {
    throw new Error('CANDIDATE_DIGEST_MUST_DIFFER_FROM_PROD_BASELINE');
  }
  return { prodBaseline, candidateEvidence: candidate };
}

export function assembleDevReadyEvidence({
  supplyChain, deployment, slo, workflowRun, githubRepository,
}, now = new Date()) {
  verifySupplyChain(supplyChain);
  validateRawDeployment(deployment);
  validateRawSlo(slo);
  assertEqual(deployment.source.repository, githubRepository, 'deployment source.repository');
  assertEqual(slo.source.repository, githubRepository, 'SLO source.repository');
  for (const [label, actual, expected] of [
    ['sourceSha', deployment.source.sha, supplyChain.sourceSha],
    ['SLO sourceSha', slo.source.sha, supplyChain.sourceSha],
    ['image.repository', deployment.image.repository, supplyChain.imageRepository],
    ['SLO image.repository', slo.image.repository, supplyChain.imageRepository],
    ['image.indexDigest', deployment.image.indexDigest, supplyChain.imageDigest],
    ['SLO image.indexDigest', slo.image.indexDigest, supplyChain.imageDigest],
    ['gitopsRevision', slo.gitopsRevision, deployment.gitopsRevision],
    ['clusterArn', slo.clusterArn, deployment.clusterArn],
    ['region', slo.region, deployment.region],
  ]) assertEqual(actual, expected, label);
  if (parseTimestamp(deployment.observedAt, 'deployment.observedAt') > parseTimestamp(slo.observedAt, 'slo.observedAt')) {
    throw new Error('SLO evidence predates deployment evidence');
  }
  const evidence = createDevReadyEvidence({
    schemaVersion: 'course.dev-ready/v1',
    environment: 'dev',
    region: deployment.region,
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
    gitops: { devRevision: deployment.gitopsRevision },
    cluster: { arn: deployment.clusterArn },
    slo: { evidenceId: slo.evidenceId },
    issuedAt: slo.observedAt,
    expiresAt: slo.expiresAt,
  }, now);
  return verifyDevReadyEvidence(evidence, {
    githubRepository, workflowRun, supplyChain, deployment, slo,
  }, now);
}

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'assemble' && args.length === 6) {
    const [supplyPath, deploymentPath, sloPath, workflowRunPath, repository, outputPath] = args;
    const evidence = assembleDevReadyEvidence({
      supplyChain: readJson(supplyPath),
      deployment: readJson(deploymentPath),
      slo: readJson(sloPath),
      workflowRun: readJson(workflowRunPath),
      githubRepository: repository,
    });
    if (process.env.EXPECTED_DIGEST && evidence.image.indexDigest !== process.env.EXPECTED_DIGEST) {
      throw new Error('expected digest does not match canonical DEV_READY evidence');
    }
    fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log('PASS: canonical DEV_READY evidence assembled from cloud runtime evidence');
  } else if (command === 'verify-baseline' && args.length === 2) {
    const [baselinePath, evidencePath] = args;
    verifyProdBaselineEvidence({
      prodBaseline: readJson(baselinePath),
      candidateEvidence: readJson(evidencePath),
    });
    console.log('PASS: candidate differs from Ch17 Prod baseline');
  } else if (command === 'verify' && args.length === 3) {
    const [evidencePath, workflowRunPath, repository] = args;
    verifyDevReadyEvidence(readJson(evidencePath), {
      workflowRun: readJson(workflowRunPath), githubRepository: repository,
    });
    console.log('PASS: canonical DEV_READY evidence');
  } else {
    throw new Error('usage: dev-ready-evidence.mjs assemble SUPPLY DEPLOYMENT SLO WORKFLOW_RUN REPOSITORY OUTPUT | verify-baseline BASELINE DEV_READY | verify DEV_READY WORKFLOW_RUN REPOSITORY');
  }
}
