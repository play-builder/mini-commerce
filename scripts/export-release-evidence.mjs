#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { classifyRollbackBoundary } from './gitops-values-lib.mjs';

const requiredKeys = [
  'schemaVersion', 'evidenceGrade', 'courseId', 'accountId', 'region',
  'observedAt', 'upstreamEvidence',
  'sourceSha', 'runUrl', 'runId', 'imageDigest', 'attestation', 'devGitopsSha',
  'prodGitopsSha', 'argoRevision', 'rolloutRevision', 'analysisRun', 'slo',
  'rollbackCandidates', 'cleanup',
];
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const hexDigestPattern = /^[0-9a-f]{64}$/;
const awsAccountPattern = /^\d{12}$/;
const supportedRegions = new Set(['ap-northeast-2', 'us-east-1']);
const allIncidentIds = [
  'INC-AWS-01', 'INC-AWS-02', 'INC-AWS-03', 'INC-AWS-04', 'INC-AWS-05',
  'INC-CI-01', 'INC-CI-02',
  'INC-SC-01', 'INC-SC-02', 'INC-SC-03', 'INC-SC-04',
  'INC-GO-01', 'INC-GO-02',
  'INC-K8S-01', 'INC-K8S-02', 'INC-K8S-03', 'INC-K8S-04',
  'INC-SEC-01',
  'INC-OBS-01', 'INC-OBS-02',
  'INC-REL-01', 'INC-REL-02', 'INC-REL-03', 'INC-REL-04',
  'INC-DB-01', 'INC-DB-02', 'INC-DB-03', 'INC-DB-04', 'INC-DB-05', 'INC-DB-06',
  'INC-RES-01', 'INC-RES-02',
  'INC-CAP-01', 'INC-CAP-02',
  'INC-CLN-01', 'INC-CLN-02', 'INC-CLN-03',
];
const coreMustIncidentIds = new Set([
  'INC-AWS-01', 'INC-AWS-02', 'INC-AWS-03', 'INC-AWS-05',
  'INC-CI-01', 'INC-SC-01', 'INC-SC-04', 'INC-GO-01', 'INC-K8S-01',
  'INC-K8S-03', 'INC-SEC-01', 'INC-OBS-01', 'INC-REL-02', 'INC-REL-03',
  'INC-DB-03', 'INC-DB-04', 'INC-DB-05', 'INC-CLN-01',
]);
const lifecyclePhases = [
  'baseline', 'inject', 'detect', 'mitigate', 'recover', 'reconcile', 'prevent', 'cleanup',
];
const incidentChapters = new Map([
  ...['INC-AWS-01', 'INC-AWS-02', 'INC-AWS-03'].map((id) => [id, 2]),
  ...['INC-AWS-04', 'INC-AWS-05'].map((id) => [id, 3]),
  ...['INC-CI-01', 'INC-CI-02'].map((id) => [id, 5]),
  ...['INC-SC-01', 'INC-SC-02'].map((id) => [id, 6]),
  ...['INC-SC-03', 'INC-SC-04'].map((id) => [id, 7]),
  ...['INC-GO-01', 'INC-GO-02'].map((id) => [id, 11]),
  ['INC-SEC-01', 12],
  ...['INC-K8S-01', 'INC-K8S-02'].map((id) => [id, 13]),
  ...['INC-K8S-03', 'INC-K8S-04'].map((id) => [id, 14]),
  ['INC-OBS-01', 15], ['INC-OBS-02', 16], ['INC-REL-01', 17], ['INC-REL-04', 18],
  ...['INC-REL-02', 'INC-REL-03'].map((id) => [id, 19]),
  ...['INC-DB-01', 'INC-DB-02'].map((id) => [id, 20]),
  ['INC-DB-03', 21], ['INC-DB-04', 22], ['INC-DB-05', 23], ['INC-DB-06', 24],
  ...['INC-RES-01', 'INC-RES-02', 'INC-CAP-01', 'INC-CAP-02'].map((id) => [id, 25]),
  ...['INC-CLN-01', 'INC-CLN-02', 'INC-CLN-03'].map((id) => [id, 26]),
]);

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseClusterArn(value, label) {
  const match = /^arn:aws:eks:(ap-northeast-2|us-east-1):(\d{12}):cluster\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/.exec(value ?? '');
  if (!match) {
    throw new Error(`invalid ${label}`);
  }
  return { region: match[1], accountId: match[2], name: match[3] };
}

function parseEcrRepository(value, label) {
  const match = /^(\d{12})\.dkr\.ecr\.(ap-northeast-2|us-east-1)\.amazonaws\.com\/([a-z0-9]+(?:[._/-][a-z0-9]+)*)$/.exec(value ?? '');
  if (!match || match[3].length > 256) {
    throw new Error(`invalid ${label}`);
  }
  return { accountId: match[1], region: match[2], name: match[3] };
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function compareCodepoints(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function parseTimestamp(value, label) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())
    || timestamp.toISOString() !== value.replace(/Z$/, '.000Z')) {
    throw new Error(`invalid ${label}`);
  }
  return timestamp;
}

function parseSource(source, expectedDigest, label, parser = JSON.parse) {
  if (typeof source !== 'string' && !Buffer.isBuffer(source)) {
    throw new Error(`${label} bytes are required`);
  }
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== expectedDigest) throw new Error(`${label} digest mismatch`);
  return { bytes, value: parser(bytes.toString('utf8')) };
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative);
}

function verifyIncidentArtifact(bytes, {
  incident, scenario, phase, expectedScope, artifactRoots, indexStartedAt, indexGeneratedAt,
}) {
  const envelope = JSON.parse(bytes.toString('utf8'));
  assertExactKeys(envelope, [
    'schemaVersion', 'evidenceGrade', 'incidentId', 'scenario', 'phase', 'courseId',
    'accountId', 'region', 'environment', 'producer', 'subject', 'sources', 'outcome', 'observedAt',
  ], 'incident artifact');
  assertExactKeys(envelope.producer, ['repository', 'revision'], 'incident artifact.producer');
  assertExactKeys(envelope.subject, ['kind', 'id'], 'incident artifact.subject');
  assertExactKeys(envelope.outcome, ['status', 'summary'], 'incident artifact.outcome');
  if (envelope.schemaVersion !== 'course.incident-artifact/v1'
    || envelope.evidenceGrade !== 'INCIDENT_EVIDENCE'
    || envelope.incidentId !== incident.id || envelope.scenario !== scenario.name
    || envelope.phase !== phase || envelope.courseId !== expectedScope.courseId
    || envelope.accountId !== expectedScope.accountId || envelope.region !== expectedScope.region
    || !['dev', 'prod', 'shared'].includes(envelope.environment)
    || !artifactRoots[envelope.producer.repository]
    || !shaPattern.test(envelope.producer.revision)
    || !isNonemptyString(envelope.subject.kind) || !isNonemptyString(envelope.subject.id)
    || envelope.outcome.status !== 'PASS' || !isNonemptyString(envelope.outcome.summary)
    || !Array.isArray(envelope.sources) || envelope.sources.length === 0) {
    throw new Error('incident artifact identity/completion mismatch');
  }
  const observedAt = parseTimestamp(envelope.observedAt, 'incident artifact observedAt');
  if (observedAt < indexStartedAt || observedAt > indexGeneratedAt) {
    throw new Error('incident artifact timestamp is outside index lifecycle');
  }
  for (const source of envelope.sources) {
    assertExactKeys(source, ['repository', 'path', 'sha256'], 'incident artifact source');
    const root = artifactRoots[source.repository];
    if (!root || !isNonemptyString(source.path) || path.isAbsolute(source.path)
      || source.path.split(path.sep).includes('..') || !hexDigestPattern.test(source.sha256)) {
      throw new Error('incident artifact source is invalid');
    }
    const resolved = fs.realpathSync(path.join(root, source.path));
    if (!isWithinRoot(resolved, root) || isFixturePath(resolved)) {
      throw new Error('incident artifact source escapes reviewed repository roots');
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
    if (actual !== source.sha256) throw new Error('incident artifact source digest mismatch');
  }
  return { observedAt, envelope };
}

export function verifyDb04RecoverySource(bytes, {
  incident, scenario, expectedScope, releaseLineage, indexStartedAt, indexGeneratedAt,
}) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('INC-DB-04 recovery source must be JSON');
  }
  assertExactKeys(value, [
    'schemaVersion', 'evidenceGrade', 'incidentId', 'scenario', 'courseId', 'accountId',
    'region', 'executionId', 'stable', 'faulty', 'recovered', 'workflow',
    'gitopsRevision', 'rolloutRevision', 'observedAt',
  ], 'INC-DB-04 recovery source');
  for (const [name, keys] of [
    ['stable', ['repository', 'sourceSha', 'imageRepository', 'indexDigest']],
    ['faulty', ['repository', 'sourceSha', 'imageRepository', 'indexDigest']],
    ['recovered', ['repository', 'sourceSha', 'imageRepository', 'indexDigest', 'strategy']],
    ['workflow', ['runId', 'runAttempt', 'runUrl']],
  ]) assertExactKeys(value[name], keys, `INC-DB-04 recovery source.${name}`);
  if (value.schemaVersion !== 'course.db04-recovery/v1'
    || value.evidenceGrade !== 'INCIDENT_EVIDENCE'
    || value.incidentId !== incident.id || value.scenario !== scenario.name
    || value.courseId !== expectedScope.courseId || value.accountId !== expectedScope.accountId
    || value.region !== expectedScope.region || !isNonemptyString(value.executionId)
    || !shaPattern.test(value.gitopsRevision)
    || !Number.isSafeInteger(value.rolloutRevision) || value.rolloutRevision < 1) {
    throw new Error('INC-DB-04 recovery source identity mismatch');
  }
  const applicationRepository = value.stable.repository;
  if (!/^[^/\s]+\/cicd-course-sample-app$/.test(applicationRepository)) {
    throw new Error('INC-DB-04 recovery source application identity is invalid');
  }
  const image = parseEcrRepository(
    value.stable.imageRepository,
    'INC-DB-04 stable image repository',
  );
  if (image.accountId !== expectedScope.accountId || image.region !== expectedScope.region
    || !/(^|\/)sample-app$/.test(image.name)) {
    throw new Error('INC-DB-04 recovery source ECR identity is invalid');
  }
  for (const name of ['stable', 'faulty', 'recovered']) {
    const identity = value[name];
    if (identity.repository !== applicationRepository
      || identity.imageRepository !== value.stable.imageRepository
      || !shaPattern.test(identity.sourceSha) || !digestPattern.test(identity.indexDigest)) {
      throw new Error(`INC-DB-04 recovery source ${name} identity is invalid`);
    }
  }
  if (!['git-revert', 'break-glass-undo-plus-git', 'hotfix-fix-forward']
    .includes(value.recovered.strategy)) {
    throw new Error('INC-DB-04 recovery strategy is invalid');
  }
  if (value.recovered.strategy !== scenario.name) {
    throw new Error('INC-DB-04 recovery strategy/scenario mismatch');
  }
  const workflow = /^https:\/\/github\.com\/([^/\s]+\/cicd-course-sample-app)\/actions\/runs\/(\d+)$/.exec(
    value.workflow.runUrl,
  );
  if (typeof value.workflow.runId !== 'string' || !/^\d+$/.test(value.workflow.runId)
    || !Number.isSafeInteger(value.workflow.runAttempt) || value.workflow.runAttempt < 1
    || !workflow || workflow[1] !== applicationRepository || workflow[2] !== value.workflow.runId) {
    throw new Error('INC-DB-04 workflow identity is invalid');
  }
  const observedAt = parseTimestamp(value.observedAt, 'INC-DB-04 recovery observedAt');
  if (!(indexStartedAt instanceof Date) || Number.isNaN(indexStartedAt.valueOf())
    || !(indexGeneratedAt instanceof Date) || Number.isNaN(indexGeneratedAt.valueOf())
    || observedAt < indexStartedAt || observedAt > indexGeneratedAt) {
    throw new Error('INC-DB-04 recovery observedAt is outside incident lifecycle');
  }
  if (value.recovered.strategy === 'hotfix-fix-forward') {
    const lineage = releaseLineage?.v201HotfixOrderTotal;
    if (!lineage || value.recovered.sourceSha !== String(lineage.sourceSha)
      || value.recovered.indexDigest !== lineage.indexDigest
      || [value.stable, value.faulty].some((identity) => (
        identity.sourceSha === value.recovered.sourceSha
        || identity.indexDigest === value.recovered.indexDigest
      ))) {
      throw new Error('INC-DB-04 hotfix does not match canonical release lineage');
    }
  } else {
    const { strategy: _strategy, ...recoveredIdentity } = value.recovered;
    if (JSON.stringify(canonicalize(recoveredIdentity))
      !== JSON.stringify(canonicalize(value.stable))) {
      throw new Error('INC-DB-04 rollback must recover the stable identity');
    }
  }
  const stableLineage = releaseLineage?.v2PrimeContractCompatible;
  const faultyLineage = releaseLineage?.v2FaultyOrderTotal;
  if (!stableLineage || !faultyLineage
    || value.stable.sourceSha !== String(stableLineage.sourceSha)
    || value.stable.indexDigest !== stableLineage.indexDigest
    || value.faulty.sourceSha !== String(faultyLineage.sourceSha)
    || value.faulty.indexDigest !== faultyLineage.indexDigest) {
    throw new Error('INC-DB-04 stable/faulty identity is not bound to release lineage');
  }
  return value;
}

function verifyIncidentIndex(source, {
  expectedGrade, expectedDigest, releaseObservedAt, now, artifactRoots = {}, expectedScope,
  incidentCatalog, releaseLineage,
}) {
  const { value: index } = parseSource(source, expectedDigest, 'incident index');
  assertExactKeys(index, [
    'schemaVersion', 'evidenceGrade', 'curriculumVersion', 'courseId', 'accountId',
    'region', 'startedAt', 'generatedAt', 'completionLevel', 'incidents',
  ], 'incident index');
  if (index.schemaVersion !== 'course.incident-index/v1') {
    throw new Error('unsupported incident index schemaVersion');
  }
  if (index.curriculumVersion !== 'v3.4') throw new Error('incident curriculumVersion mismatch');
  if (index.evidenceGrade !== expectedGrade) throw new Error('incident index evidenceGrade mismatch');
  if (!isNonemptyString(index.courseId) || !awsAccountPattern.test(index.accountId)
    || !supportedRegions.has(index.region)) throw new Error('invalid incident index scope');
  if (expectedScope && (index.courseId !== expectedScope.courseId
    || index.accountId !== expectedScope.accountId || index.region !== expectedScope.region)) {
    throw new Error('incident index scope identity mismatch');
  }
  const startedAt = parseTimestamp(index.startedAt, 'incident index startedAt');
  const observedAt = parseTimestamp(index.generatedAt, 'incident index generatedAt');
  if (startedAt >= observedAt || observedAt > now || observedAt > releaseObservedAt) {
    throw new Error('future incident index evidence is not allowed');
  }
  if (!Array.isArray(index.incidents)) throw new Error('incident index incidents must be an array');
  if (expectedGrade === 'INCIDENT_EVIDENCE'
    && (!(incidentCatalog instanceof Map) || incidentCatalog.size !== 37)) {
    throw new Error('canonical incident catalog is required');
  }
  if (index.incidents.length !== allIncidentIds.length) {
    throw new Error('incident index must contain all 37 curriculum incidents');
  }
  const actualIds = new Set();
  const db04Recoveries = [];
  for (const incident of index.incidents) {
    assertExactKeys(incident, [
      'id', 'chapter', 'tier', 'status', 'notRunReason', 'scenarios',
    ], 'incident index item');
    if (!allIncidentIds.includes(incident.id) || actualIds.has(incident.id)) {
      throw new Error('incident index contains an invalid or duplicate incident ID');
    }
    actualIds.add(incident.id);
    const mustRun = coreMustIncidentIds.has(incident.id);
    const expectedTier = mustRun ? 'Core-must'
      : (['INC-AWS-04', 'INC-SC-02', 'INC-K8S-04'].includes(incident.id) ? 'Extended' : 'Core-should');
    if (incident.tier !== expectedTier) throw new Error('incident index tier mismatch');
    if (incident.chapter !== incidentChapters.get(incident.id)) throw new Error('incident index chapter mismatch');
    if (mustRun || incident.status === 'COMPLETE') {
      if (incident.status !== 'COMPLETE' || incident.notRunReason !== null
        || !Array.isArray(incident.scenarios) || incident.scenarios.length === 0) {
        throw new Error('completed incident evidence is invalid');
      }
      for (const scenario of incident.scenarios) {
        assertExactKeys(scenario, ['name', 'status', 'evidenceGrade', 'lifecycle'], 'incident scenario');
        if (scenario.status !== 'COMPLETE' || scenario.evidenceGrade !== expectedGrade) {
          throw new Error('incident scenario is not complete at the required grade');
        }
        if (typeof scenario.name !== 'string' || scenario.name.length === 0) {
          throw new Error('incident scenario name is required');
        }
        assertExactKeys(scenario.lifecycle, lifecyclePhases, 'incident lifecycle');
        const phaseTimes = new Map();
        for (const phase of lifecyclePhases) {
          if (!Array.isArray(scenario.lifecycle[phase]) || scenario.lifecycle[phase].length === 0) {
            throw new Error('incident lifecycle phase requires evidence references');
          }
          for (const reference of scenario.lifecycle[phase]) {
            assertExactKeys(reference, ['repository', 'path', 'sha256'], 'incident evidence reference');
            if (!isNonemptyString(reference.repository) || !isNonemptyString(reference.path)
              || !hexDigestPattern.test(reference.sha256)) {
              throw new Error('incident evidence reference is invalid');
            }
            if (expectedGrade === 'INCIDENT_EVIDENCE') {
              const root = artifactRoots[reference.repository];
              if (!root || path.isAbsolute(reference.path)
                || reference.path.split(path.sep).includes('..')) {
                throw new Error('incident evidence repository/path is not canonical');
              }
              const resolved = fs.realpathSync(path.join(root, reference.path));
              if (isFixturePath(resolved)) {
                throw new Error('runtime incident evidence cannot reference test fixtures');
              }
              if (!isWithinRoot(resolved, root)) {
                throw new Error('incident lifecycle artifact escapes reviewed repository roots');
              }
              const envelopeBytes = fs.readFileSync(resolved);
              const actual = crypto.createHash('sha256').update(envelopeBytes).digest('hex');
              if (actual !== reference.sha256) throw new Error('incident lifecycle artifact digest mismatch');
              const artifact = verifyIncidentArtifact(envelopeBytes, {
                incident, scenario, phase, expectedScope, artifactRoots,
                indexStartedAt: startedAt, indexGeneratedAt: observedAt,
              });
              if (incident.id === 'INC-DB-04' && phase === 'recover') {
                if (artifact.envelope.sources.length !== 1) {
                  throw new Error('INC-DB-04 recover must reference exactly one recovery source');
                }
                const recoveryReference = artifact.envelope.sources[0];
                const recoveryRoot = artifactRoots[recoveryReference.repository];
                const recoveryPath = fs.realpathSync(path.join(recoveryRoot, recoveryReference.path));
                db04Recoveries.push(verifyDb04RecoverySource(fs.readFileSync(recoveryPath), {
                  incident, scenario, expectedScope, releaseLineage,
                  indexStartedAt: startedAt, indexGeneratedAt: observedAt,
                }));
              }
              const times = phaseTimes.get(phase) ?? [];
              times.push(artifact.observedAt);
              phaseTimes.set(phase, times);
            }
          }
        }
        if (expectedGrade === 'INCIDENT_EVIDENCE') {
          let previous = startedAt;
          for (const phase of lifecyclePhases) {
            const times = phaseTimes.get(phase).sort((a, b) => a - b);
            if (times[0] < previous) throw new Error('incident lifecycle timestamps are out of order');
            previous = times.at(-1);
          }
          const maximumDurationMs = incidentCatalog.get(incident.id).maximumDurationMs;
          if (phaseTimes.get('mitigate')[0] - phaseTimes.get('inject')[0] > maximumDurationMs) {
            throw new Error('incident mitigation exceeded maximumDuration');
          }
        }
      }
      if (new Set(incident.scenarios.map(({ name }) => name)).size !== incident.scenarios.length) {
        throw new Error('incident scenario names must be unique');
      }
    } else if (incident.status === 'NOT_RUN') {
      if (incident.scenarios.length !== 0
        || !isNonemptyString(incident.notRunReason)) {
        throw new Error('NOT_RUN incident requires a reason and no evidence digest');
      }
    } else {
      throw new Error('optional incident status must be COMPLETE or NOT_RUN');
    }
    if (incident.id === 'INC-DB-04') {
      const names = incident.scenarios.map(({ name }) => name).sort();
      if (JSON.stringify(names) !== JSON.stringify([
        'break-glass-undo-plus-git', 'git-revert', 'hotfix-fix-forward',
      ])) {
        throw new Error('INC-DB-04 must contain the three canonical scenarios');
      }
    } else if (incident.status === 'COMPLETE'
      && (incident.scenarios.length !== 1 || incident.scenarios[0].name !== 'primary')) {
      throw new Error('completed incident must contain exactly one primary scenario');
    }
  }
  if (expectedGrade === 'INCIDENT_EVIDENCE') {
    if (db04Recoveries.length !== 3) throw new Error('INC-DB-04 recovery evidence is incomplete');
    const recoveriesByStrategy = new Map(
      db04Recoveries.map((value) => [value.recovered.strategy, value]),
    );
    const first = recoveriesByStrategy.get('git-revert');
    const second = recoveriesByStrategy.get('break-glass-undo-plus-git');
    const hotfix = recoveriesByStrategy.get('hotfix-fix-forward');
    const identity = (value) => JSON.stringify(canonicalize(value));
    if (identity(first.stable) !== identity(second.stable)
      || identity(first.faulty) !== identity(second.faulty)
      || identity(first.faulty) !== identity(hotfix.faulty)) {
      throw new Error('INC-DB-04 stable/faulty identity mismatch');
    }
    for (const key of ['executionId', 'gitopsRevision', 'rolloutRevision']) {
      if (new Set(db04Recoveries.map((value) => String(value[key]))).size !== 3) {
        throw new Error(`INC-DB-04 ${key} must be distinct`);
      }
    }
    if (new Set(db04Recoveries.map((value) => `${value.workflow.runId}/${value.workflow.runAttempt}`)).size !== 3) {
      throw new Error('INC-DB-04 workflow runs must be distinct');
    }
    for (const incident of index.incidents) {
      const metadata = incidentCatalog.get(incident.id);
      if (!metadata || metadata.chapter !== incident.chapter || metadata.tier !== incident.tier) {
        throw new Error('incident index does not match canonical catalog');
      }
    }
  }
  const completeCount = index.incidents.filter(({ status }) => status === 'COMPLETE').length;
  const coreAndShouldComplete = index.incidents
    .filter(({ tier }) => tier !== 'Extended').every(({ status }) => status === 'COMPLETE');
  const expectedLevel = completeCount === 37 ? 'ALL_INCIDENTS_COMPLETE'
    : (coreAndShouldComplete ? 'CORE_AND_SHOULD_COMPLETE' : 'CORE_MUST_COMPLETE');
  if (index.completionLevel !== expectedLevel) throw new Error('incident completionLevel mismatch');
  return index;
}

function verifyDevReady(value) {
  assertExactKeys(value, [
    'schemaVersion', 'environment', 'region', 'sourceSha', 'workflow', 'image',
    'attestation', 'gitops', 'cluster', 'slo', 'issuedAt', 'expiresAt',
  ], 'DEV_READY');
  assertExactKeys(value.workflow, ['name', 'event', 'runId', 'runAttempt', 'runUrl'], 'DEV_READY.workflow');
  assertExactKeys(value.image, ['repository', 'indexDigest', 'platforms'], 'DEV_READY.image');
  assertExactKeys(value.attestation, [
    'githubId', 'githubUrl', 'ociSbomDigest', 'ociProvenanceDigest',
  ], 'DEV_READY.attestation');
  assertExactKeys(value.gitops, ['devRevision'], 'DEV_READY.gitops');
  assertExactKeys(value.cluster, ['arn'], 'DEV_READY.cluster');
  assertExactKeys(value.slo, ['evidenceId'], 'DEV_READY.slo');
  if (value.schemaVersion !== 'course.dev-ready/v1' || value.environment !== 'dev'
    || !supportedRegions.has(value.region) || value.workflow.name !== 'ci'
    || value.workflow.event !== 'push'
    || !Number.isSafeInteger(value.workflow.runAttempt) || value.workflow.runAttempt < 1
    || typeof value.workflow.runId !== 'string' || !/^\d+$/.test(value.workflow.runId)
    || JSON.stringify(value.image.platforms) !== JSON.stringify(['linux/amd64', 'linux/arm64'])
    || typeof value.attestation.githubId !== 'string'
    || !/^\d+$/.test(value.attestation.githubId)
    || !isNonemptyString(value.attestation.githubUrl)
    || !digestPattern.test(value.attestation.ociSbomDigest)
    || !digestPattern.test(value.attestation.ociProvenanceDigest)
    || !isNonemptyString(value.slo.evidenceId)) {
    throw new Error('invalid DEV_READY identity');
  }
  if (!shaPattern.test(value.sourceSha) || !shaPattern.test(value.gitops.devRevision)
    || !digestPattern.test(value.image.indexDigest)) throw new Error('invalid DEV_READY immutable identity');
  const runMatch = /^https:\/\/github\.com\/([^/]+\/cicd-course-sample-app)\/actions\/runs\/(\d+)$/.exec(value.workflow.runUrl);
  if (!runMatch || runMatch[2] !== String(value.workflow.runId)) {
    throw new Error('invalid DEV_READY workflow identity');
  }
  if (value.attestation.githubUrl
    !== `https://github.com/${runMatch[1]}/attestations/${value.attestation.githubId}`) {
    throw new Error('invalid DEV_READY attestation identity');
  }
  const cluster = parseClusterArn(value.cluster.arn, 'DEV_READY cluster ARN');
  const ecr = parseEcrRepository(value.image.repository, 'DEV_READY image repository');
  if (cluster.region !== value.region || ecr.region !== value.region
    || cluster.accountId !== ecr.accountId) {
    throw new Error('DEV_READY Region/account identity mismatch');
  }
  const issuedAt = parseTimestamp(value.issuedAt, 'DEV_READY issuedAt');
  const expiresAt = parseTimestamp(value.expiresAt, 'DEV_READY expiresAt');
  if (expiresAt <= issuedAt) throw new Error('invalid DEV_READY lifetime');
}

function verifyProdBaseline(value, mode) {
  assertExactKeys(value, [
    'schemaVersion', 'evidenceGrade', 'image', 'gitopsRevision', 'rollout',
    'clusterArn', 'region', 'observedAt',
  ], 'Prod baseline');
  assertExactKeys(value.image, ['repository', 'indexDigest'], 'Prod baseline.image');
  assertExactKeys(value.rollout, ['stableHash', 'revision', 'trafficWeight'], 'Prod baseline.rollout');
  if (value.schemaVersion !== 'course.prod-baseline/v1'
    || value.evidenceGrade !== (mode === 'runtime' ? 'CLOUD_RUNTIME' : 'STATIC')
    || !shaPattern.test(value.gitopsRevision) || !digestPattern.test(value.image.indexDigest)
    || !isNonemptyString(value.image.repository) || !isNonemptyString(value.rollout.stableHash)
    || !isNonemptyString(value.clusterArn) || !supportedRegions.has(value.region)
    || value.rollout.revision !== 1 || value.rollout.trafficWeight !== 100) {
    throw new Error('invalid Prod baseline');
  }
  parseTimestamp(value.observedAt, 'Prod baseline observedAt');
}

function verifyProdSlo(value, mode) {
  assertExactKeys(value, [
    'schemaVersion', 'evidenceGrade', 'status', 'source', 'image', 'gitopsRevision',
    'clusterArn', 'region', 'evidenceId', 'rollout', 'analysisRun', 'metricResults',
    'observedAt',
  ], 'Prod SLO');
  assertExactKeys(value.source, ['repository', 'sha'], 'Prod SLO.source');
  assertExactKeys(value.image, ['repository', 'indexDigest'], 'Prod SLO.image');
  assertExactKeys(value.rollout, [
    'name', 'uid', 'revision', 'stableHash', 'currentPodHash', 'trafficWeight', 'phase',
  ], 'Prod SLO.rollout');
  assertExactKeys(value.analysisRun, ['name', 'uid', 'phase', 'templateName'], 'Prod SLO.analysisRun');
  if (!Array.isArray(value.metricResults) || value.metricResults.length !== 2) {
    throw new Error('Prod SLO requires exactly two metric results');
  }
  for (const metric of value.metricResults) {
    assertExactKeys(metric, ['name', 'phase', 'measurements'], 'Prod SLO metric');
    if (metric.phase !== 'Successful' || !Array.isArray(metric.measurements)
      || metric.measurements.length === 0) throw new Error('Prod SLO metric measurements are incomplete');
    let successfulTerminalMeasurements = 0;
    for (const measurement of metric.measurements) {
      assertExactKeys(measurement, [
        'value', 'phase', 'startedAt', 'finishedAt',
      ], 'Prod SLO measurement');
      const startedAt = parseTimestamp(measurement.startedAt, 'Prod SLO measurement startedAt');
      const finishedAt = parseTimestamp(measurement.finishedAt, 'Prod SLO measurement finishedAt');
      if (!['Successful', 'Failed', 'Error'].includes(measurement.phase)
        || typeof measurement.value !== 'string'
        || measurement.value.trim().length === 0
        || !Number.isFinite(Number(measurement.value))
        || finishedAt < startedAt) throw new Error('Prod SLO terminal measurement is invalid');
      if (measurement.phase === 'Successful') successfulTerminalMeasurements += 1;
    }
    if (successfulTerminalMeasurements === 0) {
      throw new Error('Prod SLO requires a successful terminal measurement');
    }
  }
  const metrics = [...value.metricResults].sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(metrics.map(({ name, phase }) => ({ name, phase }))) !== JSON.stringify([
    { name: 'request-rate', phase: 'Successful' }, { name: 'success-rate', phase: 'Successful' },
  ])) throw new Error('Prod SLO metrics are incomplete');
  if (value.schemaVersion !== 'course.prod-slo/v1'
    || value.evidenceGrade !== (mode === 'runtime' ? 'CLOUD_RUNTIME' : 'STATIC')
    || value.status !== 'PASS' || !shaPattern.test(value.source.sha)
    || !isNonemptyString(value.source.repository) || !isNonemptyString(value.image.repository)
    || !isNonemptyString(value.evidenceId) || !isNonemptyString(value.rollout.name)
    || !isNonemptyString(value.rollout.uid) || !isNonemptyString(value.rollout.stableHash)
    || !isNonemptyString(value.rollout.currentPodHash) || !isNonemptyString(value.analysisRun.name)
    || !isNonemptyString(value.analysisRun.uid) || !isNonemptyString(value.analysisRun.templateName)
    || !shaPattern.test(value.gitopsRevision) || !digestPattern.test(value.image.indexDigest)
    || !Number.isSafeInteger(value.rollout.revision) || value.rollout.revision < 1
    || !isNonemptyString(value.clusterArn) || !supportedRegions.has(value.region)
    || value.rollout.phase !== 'Healthy' || value.rollout.stableHash !== value.rollout.currentPodHash
    || value.rollout.trafficWeight !== 100 || value.analysisRun.phase !== 'Successful') {
    throw new Error('invalid Prod SLO completion');
  }
  parseTimestamp(value.observedAt, 'Prod SLO observedAt');
}

function verifyRollbackCompatibility(source, expectedDigest, record) {
  if (typeof source !== 'string' && !Buffer.isBuffer(source)) {
    throw new Error('rollback compatibility bytes are required');
  }
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== expectedDigest) throw new Error('rollback compatibility digest mismatch');
  const value = parseYaml(bytes.toString('utf8'));
  assertExactKeys(value, [
    'completedRollback', 'inProgressStableReapply', 'releaseLineage',
  ], 'rollback compatibility');
  assertExactKeys(value.completedRollback, [
    'rolloutName', 'rolloutUid', 'stableHash', 'targetHash', 'rollbackWindow',
    'candidates', 'replicaSetList',
  ], 'rollback compatibility.completedRollback');
  assertExactKeys(value.completedRollback.rollbackWindow, ['revisions'], 'rollback compatibility.rollbackWindow');
  assertExactKeys(value.completedRollback.replicaSetList, [
    'apiVersion', 'kind', 'items',
  ], 'rollback compatibility.replicaSetList');
  assertExactKeys(value.inProgressStableReapply, [
    'stableDigest', 'candidateDigest', 'requiresDesiredStateReconcile', 'action',
  ], 'rollback compatibility.inProgressStableReapply');
  assertExactKeys(value.releaseLineage, [
    'v1Compatible', 'v2FaultyOrderTotal', 'v201HotfixOrderTotal', 'v2PrimeContractCompatible',
  ], 'rollback compatibility.releaseLineage');
  for (const [name, release] of Object.entries(value.releaseLineage)) {
    assertExactKeys(release, ['sourceSha', 'indexDigest'], `rollback compatibility.${name}`);
    if (!shaPattern.test(String(release.sourceSha)) || !digestPattern.test(release.indexDigest)) {
      throw new Error('rollback compatibility release lineage is invalid');
    }
  }
  const completed = value.completedRollback;
  if (![completed.rolloutName, completed.rolloutUid, completed.stableHash, completed.targetHash]
    .every(isNonemptyString)
    || completed.stableHash === completed.targetHash
    || !Number.isSafeInteger(completed.rollbackWindow.revisions)
    || completed.rollbackWindow.revisions < 1
    || completed.replicaSetList.apiVersion !== 'apps/v1'
    || completed.replicaSetList.kind !== 'ReplicaSetList'
    || !Array.isArray(completed.replicaSetList.items)
    || !Array.isArray(completed.candidates) || completed.candidates.length === 0) {
    throw new Error('rollback compatibility completed rollback is invalid');
  }
  const inProgress = value.inProgressStableReapply;
  if (!digestPattern.test(inProgress.stableDigest)
    || !digestPattern.test(inProgress.candidateDigest)
    || inProgress.stableDigest === inProgress.candidateDigest
    || inProgress.requiresDesiredStateReconcile !== true
    || inProgress.action !== 'git-reapply-stable-digest') {
    throw new Error('rollback compatibility in-progress contract is invalid');
  }
  const lineage = Object.values(value.releaseLineage);
  if (new Set(lineage.map(({ sourceSha }) => String(sourceSha))).size !== 4
    || new Set(lineage.map(({ indexDigest }) => indexDigest)).size !== 4) {
    throw new Error('rollback compatibility release lineage must be distinct');
  }
  const candidate = value.releaseLineage.v2PrimeContractCompatible;
  for (const item of completed.candidates) {
    assertExactKeys(item, [
      'imageDigest', 'productReadContract', 'rolloutRevision', 'gitRevertSha', 'podTemplateHash',
    ], 'rollback compatibility candidate');
  }
  if (JSON.stringify(record.rollbackCandidates) !== JSON.stringify(completed.candidates)
    || !completed.candidates.some(({ podTemplateHash }) => podTemplateHash === completed.targetHash)
    || new Set(completed.candidates.map(({ podTemplateHash }) => podTemplateHash)).size
      !== completed.candidates.length
    || new Set(completed.candidates.map(({ rolloutRevision }) => rolloutRevision)).size
      !== completed.candidates.length) {
    throw new Error('release rollbackCandidates mismatch canonical rollback compatibility');
  }
  for (const item of completed.candidates) {
    if (item.imageDigest !== candidate.indexDigest
      || item.gitRevertSha !== String(candidate.sourceSha)
      || item.rolloutRevision >= record.rolloutRevision) {
      throw new Error('release rollbackCandidates mismatch canonical rollback compatibility');
    }
    const classification = classifyRollbackBoundary({
      state: 'completed',
      applicationDigest: record.imageDigest,
      stableDigest: record.imageDigest,
      previousMigrationDigest: value.releaseLineage.v2PrimeContractCompatible.indexDigest,
      currentMigrationDigest: value.releaseLineage.v2PrimeContractCompatible.indexDigest,
      gitDesiredStateDigest: record.imageDigest,
      stableHash: completed.stableHash,
      targetHash: item.podTemplateHash,
      replicaSetList: completed.replicaSetList,
      rolloutName: completed.rolloutName,
      rolloutUid: completed.rolloutUid,
      rollbackWindow: completed.rollbackWindow,
    });
    if (classification !== 'completed-window-inside') {
      throw new Error('canonical rollback candidate is outside rollbackWindow');
    }
  }
  return { bytes, value, candidates: completed.candidates.map((item) => ({ ...item })) };
}

function verifyFreeze(value, mode) {
  assertExactKeys(value, [
    'schemaVersion', 'evidenceGrade', 'status', 'gitopsRevision', 'clusters', 'writers', 'observedAt',
  ], 'GitOps freeze');
  assertExactKeys(value.writers, [
    'loadGenerators', 'chaosResources', 'recoveryJobs', 'migrationJobs',
  ], 'GitOps freeze.writers');
  if (value.schemaVersion !== 'course.gitops-freeze/v1'
    || value.evidenceGrade !== (mode === 'runtime' ? 'CLOUD_RUNTIME' : 'STATIC')
    || value.status !== 'FROZEN' || !shaPattern.test(value.gitopsRevision)
    || Object.values(value.writers).some((count) => count !== 0)
    || !Array.isArray(value.clusters) || value.clusters.length !== 2) {
    throw new Error('invalid GitOps freeze evidence');
  }
  for (const cluster of value.clusters) {
    assertExactKeys(cluster, ['environment', 'clusterArn', 'application'], 'GitOps freeze.cluster');
    assertExactKeys(cluster.application, ['name', 'sync', 'health', 'automated'], 'GitOps freeze.application');
    if (!['dev', 'prod'].includes(cluster.environment)
      || cluster.application.name !== `sample-app-${cluster.environment}`
      || cluster.application.sync !== 'Synced' || cluster.application.health !== 'Healthy'
      || cluster.application.automated !== false) throw new Error('GitOps freeze application is not frozen');
    parseClusterArn(cluster.clusterArn, `GitOps freeze ${cluster.environment} cluster ARN`);
  }
  if (JSON.stringify(value.clusters.map(({ environment }) => environment).sort()) !== JSON.stringify(['dev', 'prod'])) {
    throw new Error('GitOps freeze requires Dev and Prod clusters');
  }
  return parseTimestamp(value.observedAt, 'GitOps freeze observedAt');
}

const namespacedRetainedKinds = new Set(['PersistentVolumeClaim', 'VolumeSnapshot']);
const clusterRetainedKinds = new Set(['VolumeSnapshotContent', 'Namespace']);
const kubernetesRetainedKinds = new Set([...namespacedRetainedKinds, ...clusterRetainedKinds]);

function validateKubernetesRetainedItem(item, label) {
  if (!['dev', 'prod'].includes(item.environment) || !kubernetesRetainedKinds.has(item.kind)
    || !isNonemptyString(item.name) || !isNonemptyString(item.uid)
    || !isNonemptyString(item.classification)
    || (namespacedRetainedKinds.has(item.kind) && !isNonemptyString(item.namespace))
    || (clusterRetainedKinds.has(item.kind) && item.namespace !== '')) {
    throw new Error(`${label} is incomplete`);
  }
}

function retainedInventoryId(item) {
  return namespacedRetainedKinds.has(item.kind) ? `${item.namespace}/${item.name}` : item.name;
}

function verifyRemovalRetainedOwnership(removal, ownership) {
  const actual = removal.retained.map((item) => ({
    environment: item.environment,
    kind: item.kind,
    classification: item.classification,
    id: retainedInventoryId(item),
  })).sort((a, b) => (
    compareCodepoints(a.environment, b.environment)
      || compareCodepoints(a.kind, b.kind)
      || compareCodepoints(a.id, b.id)
      || compareCodepoints(a.classification, b.classification)
  ));
  const expected = ownership.resources
    .filter((item) => item.decision === 'RETAIN'
      && ['dev', 'prod'].includes(item.environment)
      && kubernetesRetainedKinds.has(item.kind))
    .map(({ environment, kind, classification, id }) => ({
      environment, kind, classification, id,
    })).sort((a, b) => (
      compareCodepoints(a.environment, b.environment)
        || compareCodepoints(a.kind, b.kind)
        || compareCodepoints(a.id, b.id)
        || compareCodepoints(a.classification, b.classification)
    ));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('GitOps removal retained set does not match ownership inventory');
  }
}

function verifyRemoval(value, mode, freeze, freezeBytes) {
  assertExactKeys(value, [
    'schemaVersion', 'evidenceGrade', 'status', 'gitopsRevision', 'freezeEvidenceSha256',
    'clusters', 'remaining', 'retained', 'providerSecrets', 'observedAt',
  ], 'GitOps removal');
  assertExactKeys(value.remaining, [
    'rollouts', 'deployments', 'statefulSets', 'jobs', 'externalSecrets', 'chaosResources',
  ], 'GitOps removal.remaining');
  assertExactKeys(value.providerSecrets, ['retained', 'inventorySha256'], 'GitOps removal.providerSecrets');
  if (value.schemaVersion !== 'course.gitops-removal/v1'
    || value.evidenceGrade !== (mode === 'runtime' ? 'CLOUD_RUNTIME' : 'STATIC')
    || value.status !== 'REMOVED' || !shaPattern.test(value.gitopsRevision)
    || value.freezeEvidenceSha256 !== crypto.createHash('sha256').update(freezeBytes).digest('hex')
    || Object.values(value.remaining).some((count) => count !== 0)
    || !Array.isArray(value.clusters) || value.clusters.length !== 2
    || !Array.isArray(value.retained) || value.providerSecrets.retained !== true
    || !hexDigestPattern.test(value.providerSecrets.inventorySha256)) {
    throw new Error('invalid GitOps removal evidence');
  }
  for (const cluster of value.clusters) {
    assertExactKeys(cluster, ['environment', 'clusterArn'], 'GitOps removal.cluster');
    parseClusterArn(cluster.clusterArn, `GitOps removal ${cluster.environment} cluster ARN`);
  }
  if (JSON.stringify(value.clusters) !== JSON.stringify(
    freeze.clusters.map(({ environment, clusterArn }) => ({ environment, clusterArn })),
  )) throw new Error('GitOps removal cluster identity mismatch');
  for (const retained of value.retained) assertExactKeys(retained, [
    'environment', 'namespace', 'kind', 'name', 'uid', 'classification', 'requiresExplicitDeletion',
  ], 'GitOps removal.retained');
  for (const retained of value.retained) {
    validateKubernetesRetainedItem(retained, 'GitOps removal retained item');
    if (retained.requiresExplicitDeletion !== true) {
      throw new Error('GitOps removal retained item is incomplete');
    }
  }
  const removalAt = parseTimestamp(value.observedAt, 'GitOps removal observedAt');
  if (removalAt <= parseTimestamp(freeze.observedAt, 'GitOps freeze observedAt')) {
    throw new Error('GitOps removal must follow freeze');
  }
  return removalAt;
}

function verifyOwnership(value, mode, ownershipBytes) {
  assertExactKeys(value, [
    'schemaVersion', 'evidenceGrade', 'courseId', 'accountId', 'region', 'resources', 'observedAt',
  ], 'cleanup ownership');
  if (value.schemaVersion !== 'course.cleanup-ownership/v1'
    || value.evidenceGrade !== (mode === 'runtime' ? 'CLOUD_RUNTIME' : 'STATIC')
    || !isNonemptyString(value.courseId) || !awsAccountPattern.test(value.accountId)
    || !supportedRegions.has(value.region) || !Array.isArray(value.resources)) {
    throw new Error('invalid cleanup ownership evidence');
  }
  const keys = [];
  for (const resource of value.resources) {
    assertExactKeys(resource, [
      'kind', 'id', 'environment', 'classification', 'owner', 'managedBy', 'billable',
      'decision', 'reason', 'followUpAction',
    ], 'cleanup ownership.resource');
    if (![resource.kind, resource.id, resource.environment, resource.classification,
      resource.owner, resource.managedBy].every(isNonemptyString)
      || !['dev', 'prod', 'shared'].includes(resource.environment)
      || resource.managedBy !== 'terraform'
      || typeof resource.billable !== 'boolean'
      || !['DELETE', 'RETAIN', 'EXTERNAL_SHARED'].includes(resource.decision)
      || (resource.decision === 'DELETE' && resource.owner !== 'course')
      || (resource.decision !== 'DELETE'
        && (!isNonemptyString(resource.reason) || !isNonemptyString(resource.followUpAction)))) {
      throw new Error('cleanup ownership resource is invalid');
    }
    keys.push(`${resource.kind}\0${resource.id}`);
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error('cleanup ownership resource identities must be unique');
  }
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort(compareCodepoints))) {
    throw new Error('cleanup ownership resources must be sorted by kind and ID');
  }
  const secretProjection = value.resources
    .filter(({ kind }) => kind === 'SecretsManagerSecret')
    .sort((a, b) => (
      compareCodepoints(a.environment, b.environment) || compareCodepoints(a.id, b.id)
    ))
    .map((resource) => canonicalize(resource));
  return {
    observedAt: parseTimestamp(value.observedAt, 'cleanup ownership observedAt'),
    inventoryDigest: crypto.createHash('sha256').update(ownershipBytes).digest('hex'),
    providerSecretDigest: crypto.createHash('sha256')
      .update(`${JSON.stringify(secretProjection)}\n`).digest('hex'),
  };
}

function verifyRetainDecisions(value, mode, ownership, ownershipResult) {
  assertExactKeys(value, [
    'schemaVersion', 'evidenceGrade', 'status', 'courseId', 'accountId', 'region',
    'inventorySha256', 'decisions', 'approvedAt',
  ], 'cleanup retain decisions');
  if (value.schemaVersion !== 'course.cleanup-retain-decisions/v1'
    // Retain decisions are a human-approved local-runtime artifact even when
    // the surrounding fixture set is static. Runtime mode still requires the
    // same taxonomy; a static marker would erase the approval boundary.
    || value.evidenceGrade !== 'LOCAL_RUNTIME'
    || value.status !== 'APPROVED' || value.courseId !== ownership.courseId
    || value.accountId !== ownership.accountId || value.region !== ownership.region
    || value.inventorySha256 !== ownershipResult.inventoryDigest || !Array.isArray(value.decisions)) {
    throw new Error('invalid cleanup retain decisions');
  }
  const inventoryByKey = new Map(ownership.resources.map((item) => [`${item.kind}\0${item.id}`, item]));
  const keys = [];
  for (const decision of value.decisions) {
    assertExactKeys(decision, [
      'kind', 'id', 'decision', 'reason', 'followUpAction',
    ], 'cleanup retain decision');
    const key = `${decision.kind}\0${decision.id}`;
    const inventory = inventoryByKey.get(key);
    if (!inventory || !['RETAIN', 'EXTERNAL_SHARED'].includes(decision.decision)
      || inventory.decision !== decision.decision || !isNonemptyString(decision.reason)
      || !isNonemptyString(decision.followUpAction)
      || decision.reason !== inventory.reason
      || decision.followUpAction !== inventory.followUpAction) {
      throw new Error('cleanup retain decision does not match ownership inventory');
    }
    keys.push(key);
  }
  const expected = ownership.resources.filter(({ decision }) => decision !== 'DELETE')
    .map(({ kind, id }) => `${kind}\0${id}`).sort(compareCodepoints);
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error('cleanup retain decisions must be sorted and complete');
  }
  return parseTimestamp(value.approvedAt, 'cleanup retain decisions approvedAt');
}

function verifyPreDestroy(value, mode, removal, removalBytes) {
  assertExactKeys(value, [
    'schemaVersion', 'evidenceGrade', 'status', 'courseId', 'accountId', 'region',
    'gitopsRemovalSha256', 'clusters', 'remainingWriters', 'remainingWorkloads',
    'retainedStorage', 'observedAt',
  ], 'Kubernetes pre-destroy');
  assertExactKeys(value.remainingWriters, [
    'loadGenerators', 'chaosResources', 'recoveryJobs', 'migrationJobs',
  ], 'Kubernetes pre-destroy.remainingWriters');
  assertExactKeys(value.remainingWorkloads, [
    'applications', 'rollouts', 'deployments', 'statefulSets', 'jobs', 'externalSecrets',
    'chaosResources', 'volumeAttachments',
  ], 'Kubernetes pre-destroy.remainingWorkloads');
  if (value.schemaVersion !== 'course.kubernetes-pre-destroy/v1'
    || value.evidenceGrade !== (mode === 'runtime' ? 'CLOUD_RUNTIME' : 'STATIC')
    || value.status !== 'PASS'
    || value.gitopsRemovalSha256 !== crypto.createHash('sha256').update(removalBytes).digest('hex')
    || Object.values(value.remainingWriters).some((count) => count !== 0)
    || Object.values(value.remainingWorkloads).some((count) => count !== 0)
    || !Array.isArray(value.clusters) || value.clusters.length !== 2
    || !Array.isArray(value.retainedStorage)) {
    throw new Error('invalid Kubernetes pre-destroy evidence');
  }
  for (const cluster of value.clusters) {
    assertExactKeys(cluster, ['environment', 'clusterArn'], 'Kubernetes pre-destroy.cluster');
    parseClusterArn(cluster.clusterArn, `Kubernetes pre-destroy ${cluster.environment} cluster ARN`);
  }
  if (JSON.stringify(value.clusters) !== JSON.stringify(removal.clusters)) {
    throw new Error('Kubernetes pre-destroy cluster identity mismatch');
  }
  for (const storage of value.retainedStorage) {
    assertExactKeys(storage, [
      'environment', 'namespace', 'kind', 'name', 'uid', 'classification',
    ], 'Kubernetes pre-destroy.retainedStorage');
    validateKubernetesRetainedItem(storage, 'Kubernetes pre-destroy retained storage');
  }
  const expectedRetainedStorage = removal.retained.map(({ requiresExplicitDeletion, ...item }) => item);
  if (JSON.stringify(value.retainedStorage) !== JSON.stringify(expectedRetainedStorage)) {
    throw new Error('Kubernetes pre-destroy retained set does not match GitOps removal');
  }
  return parseTimestamp(value.observedAt, 'Kubernetes pre-destroy observedAt');
}

function verifyResidual(value, mode, {
  removal, removalBytes, ownership, ownershipResult, retain, retainBytes, preDestroy, preDestroyBytes,
}) {
  assertExactKeys(value, [
    'schemaVersion', 'evidenceGrade', 'status', 'courseId', 'accountId', 'region',
    'inventorySha256', 'retainDecisionsSha256', 'kubernetesPreDestroySha256',
    'gitopsRemovalSha256', 'unapprovedCourseOwned',
    'externalShared', 'retained', 'observedAt',
  ], 'cleanup residual');
  assertExactKeys(value.unapprovedCourseOwned, [
    'loadBalancers', 'natGateways', 'eksClusters', 'ebsVolumes', 'ebsSnapshots',
    'ampWorkspaces', 'snsTopics', 'ecrRepositories', 'total',
  ], 'cleanup residual.unapprovedCourseOwned');
  if (value.schemaVersion !== 'course.cleanup-residual/v1'
    || value.evidenceGrade !== (mode === 'runtime' ? 'CLOUD_RUNTIME' : 'STATIC')
    || value.status !== 'PASS' || !isNonemptyString(value.courseId)
    || !awsAccountPattern.test(value.accountId)
    || !['ap-northeast-2', 'us-east-1'].includes(value.region)
    || !hexDigestPattern.test(value.inventorySha256)
    || !hexDigestPattern.test(value.retainDecisionsSha256)
    || !hexDigestPattern.test(value.kubernetesPreDestroySha256)
    || value.gitopsRemovalSha256 !== crypto.createHash('sha256').update(removalBytes).digest('hex')
    || value.inventorySha256 !== ownershipResult.inventoryDigest
    || value.retainDecisionsSha256 !== crypto.createHash('sha256').update(retainBytes).digest('hex')
    || value.kubernetesPreDestroySha256 !== crypto.createHash('sha256').update(preDestroyBytes).digest('hex')
    || Object.values(value.unapprovedCourseOwned).some((count) => count !== 0)) {
    throw new Error('invalid cleanup residual evidence');
  }
  for (const item of value.externalShared) {
    assertExactKeys(item, [
      'kind', 'id', 'owner', 'deletePlanned', 'presentAfterCleanup',
    ], 'cleanup residual.externalShared');
    if (![item.kind, item.id, item.owner].every(isNonemptyString)
      || item.deletePlanned !== false || item.presentAfterCleanup !== true) {
      throw new Error('external/shared deletion is not allowed');
    }
  }
  for (const item of value.retained) {
    assertExactKeys(item, [
      'kind', 'id', 'owner', 'reason', 'followUpAction', 'presentAfterCleanup',
    ], 'cleanup residual.retained');
    if (![item.kind, item.id, item.owner, item.reason, item.followUpAction].every(
      (field) => typeof field === 'string' && field.length > 0,
    ) || item.presentAfterCleanup !== true) throw new Error('retained cleanup item is incomplete');
  }
  if (value.courseId !== ownership.courseId || value.courseId !== retain.courseId
    || value.courseId !== preDestroy.courseId || value.accountId !== ownership.accountId
    || value.accountId !== retain.accountId || value.accountId !== preDestroy.accountId
    || value.region !== ownership.region || value.region !== retain.region
    || value.region !== preDestroy.region) throw new Error('cleanup evidence scope identity mismatch');
  const inventoryByKey = new Map(ownership.resources.map((item) => [`${item.kind}\0${item.id}`, item]));
  for (const item of [...value.externalShared, ...value.retained]) {
    const inventory = inventoryByKey.get(`${item.kind}\0${item.id}`);
    if (!inventory || (item.deletePlanned === false && inventory.decision !== 'EXTERNAL_SHARED')
      || (item.presentAfterCleanup === true && item.deletePlanned === undefined
        && inventory.decision !== 'RETAIN')) {
      throw new Error('cleanup residual does not match ownership decisions');
    }
  }
  const expectedExternalShared = ownership.resources
    .filter(({ decision }) => decision === 'EXTERNAL_SHARED')
    .map(({ kind, id, owner }) => ({
      kind, id, owner, deletePlanned: false, presentAfterCleanup: true,
    }))
    .sort((a, b) => compareCodepoints(a.kind, b.kind) || compareCodepoints(a.id, b.id));
  const expectedRetained = retain.decisions
    .filter(({ decision }) => decision === 'RETAIN')
    .map(({ kind, id, reason, followUpAction }) => ({
      kind,
      id,
      owner: inventoryByKey.get(`${kind}\0${id}`).owner,
      reason,
      followUpAction,
      presentAfterCleanup: true,
    }))
    .sort((a, b) => compareCodepoints(a.kind, b.kind) || compareCodepoints(a.id, b.id));
  if (JSON.stringify(value.externalShared) !== JSON.stringify(expectedExternalShared)
    || JSON.stringify(value.retained) !== JSON.stringify(expectedRetained)) {
    throw new Error('cleanup residual does not exactly match ownership decisions');
  }
  const residualAt = parseTimestamp(value.observedAt, 'cleanup residual observedAt');
  if (residualAt <= parseTimestamp(removal.observedAt, 'GitOps removal observedAt')) {
    throw new Error('cleanup residual must follow GitOps removal');
  }
}

function verifyUpstreamEvidence(record, {
  upstreamSources, mode, expectedGrade, observedAt, now, artifactRoots = {}, incidentCatalog,
}) {
  if (!upstreamSources || typeof upstreamSources !== 'object') {
    throw new Error('all eleven upstream evidence sources are required');
  }
  const sourceContracts = [
    ['devReadySource', 'devReadyDigest', 'DEV_READY', parseYaml],
    ['prodBaselineSource', 'prodBaselineDigest', 'Prod baseline'],
    ['prodSloSource', 'prodSloDigest', 'Prod SLO'],
    ['rollbackCompatibilitySource', 'rollbackCompatibilityDigest', 'rollback compatibility', parseYaml],
    ['incidentIndexSource', 'incidentIndexDigest', 'incident index'],
    ['freezeSource', 'gitopsFreezeDigest', 'GitOps freeze'],
    ['removalSource', 'gitopsRemovalDigest', 'GitOps removal'],
    ['ownershipSource', 'ownershipInventoryDigest', 'cleanup ownership'],
    ['retainSource', 'retainDecisionsDigest', 'cleanup retain decisions'],
    ['preDestroySource', 'kubernetesPreDestroyDigest', 'Kubernetes pre-destroy'],
    ['residualSource', 'residualScanDigest', 'cleanup residual'],
  ];
  // The runtime boundary is deliberately closed: accepting a caller-selected
  // twelfth source would make it possible to grade an alias or fixture while
  // the canonical artifact remains unexamined.
  assertExactKeys(
    upstreamSources,
    sourceContracts.map(([sourceKey]) => sourceKey),
    'upstreamSources',
  );
  const parsed = {};
  for (const [sourceKey, digestKey, label, parser] of sourceContracts) {
    parsed[sourceKey] = parseSource(
      upstreamSources[sourceKey], record.upstreamEvidence[digestKey], label, parser,
    );
  }
  const devReady = parsed.devReadySource.value;
  const baseline = parsed.prodBaselineSource.value;
  const prodSlo = parsed.prodSloSource.value;
  const ownership = parsed.ownershipSource.value;
  const retain = parsed.retainSource.value;
  const preDestroy = parsed.preDestroySource.value;
  const freeze = parsed.freezeSource.value;
  const removal = parsed.removalSource.value;
  const residual = parsed.residualSource.value;
  verifyDevReady(devReady);
  verifyProdBaseline(baseline, mode);
  verifyProdSlo(prodSlo, mode);
  const rollback = verifyRollbackCompatibility(
    parsed.rollbackCompatibilitySource.bytes,
    record.upstreamEvidence.rollbackCompatibilityDigest,
    record,
  );
  verifyIncidentIndex(parsed.incidentIndexSource.bytes, {
    expectedGrade,
    expectedDigest: record.upstreamEvidence.incidentIndexDigest,
    releaseObservedAt: observedAt,
    now,
    artifactRoots,
    incidentCatalog,
    expectedScope: { courseId: record.courseId, accountId: record.accountId, region: record.region },
    releaseLineage: rollback.value.releaseLineage,
  });
  verifyFreeze(freeze, mode);
  verifyRemoval(removal, mode, freeze, parsed.freezeSource.bytes);
  const ownershipResult = verifyOwnership(ownership, mode, parsed.ownershipSource.bytes);
  verifyRemovalRetainedOwnership(removal, ownership);
  const retainAt = verifyRetainDecisions(retain, mode, ownership, ownershipResult);
  const preDestroyAt = verifyPreDestroy(preDestroy, mode, removal, parsed.removalSource.bytes);
  verifyResidual(residual, mode, {
    removal,
    removalBytes: parsed.removalSource.bytes,
    ownership,
    ownershipResult,
    retain,
    retainBytes: parsed.retainSource.bytes,
    preDestroy,
    preDestroyBytes: parsed.preDestroySource.bytes,
  });
  if (removal.providerSecrets.inventorySha256 !== ownershipResult.providerSecretDigest) {
    throw new Error('provider Secret projection digest mismatch');
  }

  const prodCluster = freeze.clusters.find(({ environment }) => environment === 'prod');
  const devCluster = freeze.clusters.find(({ environment }) => environment === 'dev');
  for (const [actual, expected, label] of [
    [record.sourceSha, devReady.sourceSha, 'release sourceSha'],
    [record.sourceSha, prodSlo.source.sha, 'Prod SLO sourceSha'],
    [record.runUrl, devReady.workflow.runUrl, 'release runUrl'],
    [String(record.runId), String(devReady.workflow.runId), 'release runId'],
    [record.imageDigest, devReady.image.indexDigest, 'release imageDigest'],
    [record.imageDigest, prodSlo.image.indexDigest, 'Prod SLO imageDigest'],
    [record.devGitopsSha, devReady.gitops.devRevision, 'Dev GitOps revision'],
    [record.prodGitopsSha, prodSlo.gitopsRevision, 'Prod GitOps revision'],
    [record.argoRevision, prodSlo.gitopsRevision, 'Argo revision'],
    [record.rolloutRevision, prodSlo.rollout.revision, 'Rollout revision'],
    [record.analysisRun.name, prodSlo.analysisRun.name, 'AnalysisRun name'],
    [record.analysisRun.state, prodSlo.analysisRun.phase, 'AnalysisRun phase'],
    [record.slo.evidenceId, prodSlo.evidenceId, 'Prod SLO evidence ID'],
    [record.slo.status, prodSlo.status, 'Prod SLO status'],
    [devReady.cluster.arn, devCluster.clusterArn, 'Dev cluster ARN'],
    [prodSlo.clusterArn, prodCluster.clusterArn, 'Prod cluster ARN'],
    [prodSlo.region, residual.region, 'cleanup region'],
    [record.courseId, residual.courseId, 'release courseId'],
    [record.accountId, residual.accountId, 'release accountId'],
    [record.region, residual.region, 'release region'],
    [record.region, devReady.region, 'DEV_READY region'],
    [record.region, prodSlo.region, 'Prod SLO region'],
    [devReady.image.repository, baseline.image.repository, 'baseline image repository'],
    [devReady.image.repository, prodSlo.image.repository, 'Prod SLO image repository'],
    [baseline.clusterArn, prodSlo.clusterArn, 'Prod baseline cluster ARN'],
    [baseline.region, prodSlo.region, 'Prod baseline region'],
  ]) {
    if (actual !== expected) throw new Error(`${label} mismatch`);
  }
  if (baseline.image.indexDigest === record.imageDigest) {
    throw new Error('release candidate must differ from Prod baseline');
  }
  const runRepository = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\//.exec(record.runUrl)?.[1];
  if (runRepository !== prodSlo.source.repository) throw new Error('GitHub run repository mismatch');
  const devIdentity = parseClusterArn(devReady.cluster.arn, 'Dev cluster ARN');
  const prodIdentity = parseClusterArn(prodSlo.clusterArn, 'Prod cluster ARN');
  if (devReady.cluster.arn === prodSlo.clusterArn) throw new Error('Dev and Prod clusters must differ');
  if (devIdentity.accountId !== prodIdentity.accountId || devIdentity.region !== prodIdentity.region
    || prodIdentity.accountId !== record.accountId || prodIdentity.region !== record.region) {
    throw new Error('cluster scope identity mismatch');
  }
  const ecrIdentity = parseEcrRepository(devReady.image.repository, 'release image repository');
  if (ecrIdentity.accountId !== record.accountId || ecrIdentity.region !== record.region) {
    throw new Error('ECR scope identity mismatch');
  }
  if (record.attestation.githubId !== devReady.attestation.githubId
    || record.attestation.githubUrl !== devReady.attestation.githubUrl
    || record.attestation.ociSbomDigest !== devReady.attestation.ociSbomDigest
    || record.attestation.ociProvenanceDigest !== devReady.attestation.ociProvenanceDigest) {
    throw new Error('release attestation identity mismatch');
  }
  const timeline = [
    parseTimestamp(baseline.observedAt, 'Prod baseline observedAt'),
    parseTimestamp(prodSlo.observedAt, 'Prod SLO observedAt'),
    parseTimestamp(freeze.observedAt, 'GitOps freeze observedAt'),
    parseTimestamp(removal.observedAt, 'GitOps removal observedAt'),
    preDestroyAt,
    parseTimestamp(residual.observedAt, 'cleanup residual observedAt'),
    observedAt,
  ];
  for (let index = 1; index < timeline.length; index += 1) {
    if (timeline[index] < timeline[index - 1]) throw new Error('upstream evidence lifecycle order mismatch');
  }
  if (retainAt < ownershipResult.observedAt || retainAt > preDestroyAt) {
    throw new Error('cleanup approval lifecycle order mismatch');
  }
  return { rollbackCandidates: rollback.candidates };
}

export function exportReleaseEvidence(record, options = {}) {
  const {
    upstreamSources, mode = 'runtime', now = new Date(), artifactRoots, incidentCatalog,
  } = options;
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
  const expectedGrade = mode === 'fixture' ? 'STATIC' : 'INCIDENT_EVIDENCE';
  if (!['fixture', 'runtime'].includes(mode)) throw new Error('unsupported release evidence mode');
  if (record.evidenceGrade !== expectedGrade) {
    throw new Error(mode === 'runtime'
      ? 'runtime release evidence requires INCIDENT_EVIDENCE'
      : 'fixture release evidence requires STATIC');
  }
  if (!isNonemptyString(record.courseId) || !awsAccountPattern.test(record.accountId)
    || !supportedRegions.has(record.region)) throw new Error('invalid release evidence scope');
  const observedAt = parseTimestamp(record.observedAt, 'release evidence observedAt');
  if (observedAt > now) throw new Error('future release evidence is not allowed');
  assertExactKeys(record.upstreamEvidence, [
    'devReadyDigest', 'prodBaselineDigest', 'prodSloDigest', 'rollbackCompatibilityDigest',
    'incidentIndexDigest', 'gitopsFreezeDigest', 'gitopsRemovalDigest',
    'ownershipInventoryDigest', 'retainDecisionsDigest', 'kubernetesPreDestroyDigest',
    'residualScanDigest',
  ], 'upstreamEvidence');
  for (const key of [
    'devReadyDigest', 'prodBaselineDigest', 'prodSloDigest', 'rollbackCompatibilityDigest',
    'incidentIndexDigest', 'gitopsFreezeDigest', 'gitopsRemovalDigest',
    'ownershipInventoryDigest', 'retainDecisionsDigest', 'kubernetesPreDestroyDigest',
    'residualScanDigest',
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
  const derived = verifyUpstreamEvidence(record, {
    upstreamSources, mode, expectedGrade, observedAt, now, artifactRoots, incidentCatalog,
  });
  const canonical = canonicalize(Object.fromEntries(requiredKeys.map((key) => [
    key, key === 'rollbackCandidates' ? derived.rollbackCandidates : record[key],
  ])));
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

const toPath = (value) => (value instanceof URL ? fileURLToPath(value) : value);
const sampleRepositoryRoot = fs.realpathSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..',
));
const finalEvidencePath = path.join(sampleRepositoryRoot, 'evidence/release/final.json');

function prepareFinalEvidenceDirectory() {
  const outputDirectory = path.dirname(finalEvidencePath);
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const outputReal = fs.realpathSync(outputDirectory);
  if (outputReal !== path.resolve(outputDirectory)
    || !isWithinRoot(outputReal, sampleRepositoryRoot)) {
    throw new Error('canonical final evidence directory escapes the sample application repository');
  }
  return outputReal;
}

function isFixturePath(value) {
  const resolved = fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value);
  return new RegExp(`${path.sep}tests?${path.sep}fixtures${path.sep}`).test(resolved);
}

function loadIncidentCatalog(gitopsRoot) {
  const catalog = new Map();
  for (const id of allIncidentIds) {
    const catalogPath = path.join(gitopsRoot, 'incidents/catalog', `${id}.yaml`);
    const resolved = fs.realpathSync(catalogPath);
    if (!isWithinRoot(resolved, gitopsRoot) || isFixturePath(resolved)) {
      throw new Error('incident catalog path is not canonical');
    }
    const value = parseYaml(fs.readFileSync(resolved, 'utf8'));
    const duration = /^(\d+)(s|m)$/.exec(value?.maximumDuration ?? '');
    const maximumDurationMs = duration
      ? Number(duration[1]) * (duration[2] === 'm' ? 60_000 : 1_000) : NaN;
    if (value?.id !== id || value.chapter !== incidentChapters.get(id)
      || !['Core-must', 'Core-should', 'Extended'].includes(value.tier)
      || !Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1
      || maximumDurationMs > 300_000) {
      throw new Error(`invalid canonical incident catalog ${id}`);
    }
    catalog.set(id, { chapter: value.chapter, tier: value.tier, maximumDurationMs });
  }
  return catalog;
}

export function validateReleaseEvidenceFixture(record, upstreamSources, now = new Date()) {
  return {
    marker: '[STATIC]',
    serialized: exportReleaseEvidence(record, { upstreamSources, mode: 'fixture', now }),
  };
}

export function exportReleaseEvidenceFiles({
  inputPath, gitopsRepoRoot, infraRepoRoot,
}, now = new Date()) {
  const input = toPath(inputPath);
  if (!input || isFixturePath(input)) {
    throw new Error('test fixtures cannot be exported as runtime evidence');
  }
  const finalEvidenceDirectory = prepareFinalEvidenceDirectory();
  const gitopsRoot = fs.realpathSync(toPath(gitopsRepoRoot));
  const infraRoot = fs.realpathSync(toPath(infraRepoRoot));
  const inputReal = fs.realpathSync(input);
  if (!isWithinRoot(inputReal, sampleRepositoryRoot)) {
    throw new Error('release input must remain inside the sample application repository');
  }
  const sourcePaths = {
    devReadySource: path.join(gitopsRoot, 'envs/prod/promotion-evidence.yaml'),
    prodBaselineSource: path.join(gitopsRoot, 'evidence/prod/baseline.json'),
    prodSloSource: path.join(gitopsRoot, 'evidence/prod/slo.json'),
    rollbackCompatibilitySource: path.join(gitopsRoot, 'envs/prod/rollback-compatibility.yaml'),
    incidentIndexSource: path.join(gitopsRoot, 'evidence/incidents/index.json'),
    freezeSource: path.join(gitopsRoot, 'evidence/cleanup/freeze.json'),
    removalSource: path.join(gitopsRoot, 'evidence/cleanup/removal.json'),
    ownershipSource: path.join(infraRoot, 'evidence/cleanup/ownership-inventory.json'),
    retainSource: path.join(infraRoot, 'evidence/cleanup/retain-decisions.json'),
    preDestroySource: path.join(infraRoot, 'evidence/cleanup/kubernetes-pre-destroy.json'),
    residualSource: path.join(infraRoot, 'evidence/cleanup/residual.json'),
  };
  const paths = [inputReal, finalEvidencePath, ...Object.values(sourcePaths)];
  if (paths.some(isFixturePath)) {
    throw new Error('test fixtures cannot be exported as runtime evidence');
  }
  const gitopsSourceKeys = new Set([
    'devReadySource', 'prodBaselineSource', 'prodSloSource', 'rollbackCompatibilitySource',
    'incidentIndexSource', 'freezeSource', 'removalSource',
  ]);
  const upstreamSources = Object.fromEntries(Object.entries(sourcePaths).map(([key, value]) => {
    const real = fs.realpathSync(value);
    const root = gitopsSourceKeys.has(key) ? gitopsRoot : infraRoot;
    if (!isWithinRoot(real, root)) {
      throw new Error('canonical upstream evidence escapes its repository root');
    }
    if (isFixturePath(real)) throw new Error('test fixtures cannot be exported as runtime evidence');
    return [key, fs.readFileSync(real)];
  }));
  const serialized = exportReleaseEvidence(JSON.parse(fs.readFileSync(input, 'utf8')), {
    upstreamSources,
    mode: 'runtime',
    now,
    artifactRoots: {
      'cicd-course-sample-app': sampleRepositoryRoot,
      'argocd-gitops': gitopsRoot,
      'EKS-infra': infraRoot,
    },
    incidentCatalog: loadIncidentCatalog(gitopsRoot),
  });
  if (fs.existsSync(finalEvidencePath)) {
    const existing = JSON.parse(fs.readFileSync(finalEvidencePath, 'utf8'));
    const incoming = JSON.parse(serialized);
    for (const key of ['courseId', 'sourceSha', 'runId', 'imageDigest']) {
      if (existing[key] !== incoming[key]) {
        throw new Error('refusing to overwrite a different release identity');
      }
    }
  }
  const temporary = path.join(
    finalEvidenceDirectory, `.${path.basename(finalEvidencePath)}.${process.pid}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, finalEvidencePath);
    fs.chmodSync(finalEvidencePath, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return finalEvidencePath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const allowed = new Set(['--input', '--gitops-repo-root', '--infra-repo-root']);
  const parsed = new Map();
  if (args.length !== 6) throw new Error('usage: export-release-evidence.mjs --input INPUT_JSON --gitops-repo-root DIR --infra-repo-root DIR');
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || parsed.has(flag) || !value || value.startsWith('--')) {
      throw new Error('invalid or duplicate release exporter flag');
    }
    parsed.set(flag, value);
  }
  exportReleaseEvidenceFiles({
    inputPath: parsed.get('--input'),
    gitopsRepoRoot: parsed.get('--gitops-repo-root'),
    infraRepoRoot: parsed.get('--infra-repo-root'),
  });
  console.log('PASS: canonical release evidence exported');
}
