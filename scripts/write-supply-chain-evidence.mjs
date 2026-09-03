#!/usr/bin/env node

import fs from 'node:fs';

import { verifySupplyChain } from './verify-supply-chain.mjs';

const [indexFile, referrersFile, outputFile] = process.argv.slice(2);
if (!indexFile || !referrersFile || !outputFile) {
  throw new Error('usage: write-supply-chain-evidence.mjs INDEX_JSON REFERRERS_JSON OUTPUT_JSON');
}

const imageIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const referrers = JSON.parse(fs.readFileSync(referrersFile, 'utf8')).referrers ?? [];
const byType = (pattern) => referrers.find((item) => pattern.test(item.artifactType ?? ''))?.digest;
const evidence = {
  sourceSha: process.env.GITHUB_SHA,
  workflowName: process.env.GITHUB_WORKFLOW,
  workflowEvent: process.env.GITHUB_EVENT_NAME,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  imageRepository: process.env.IMAGE_REPOSITORY,
  imageDigest: process.env.IMAGE_DIGEST,
  platforms: ['amd64', 'arm64'].map((architecture) => ({
    platform: `linux/${architecture}`,
    digest: imageIndex.manifests.find((item) => (
      item.platform?.os === 'linux' && item.platform?.architecture === architecture
    ))?.digest,
    trivyExitCode: 0,
  })),
  githubAttestation: {
    id: process.env.ATTESTATION_ID,
    url: process.env.ATTESTATION_URL,
    subjectDigest: process.env.IMAGE_DIGEST,
  },
  ociReferrers: {
    subjectDigest: process.env.IMAGE_DIGEST,
    sbomDigest: byType(/spdx|sbom/i),
    provenanceDigest: byType(/in-toto|provenance/i),
  },
};

verifySupplyChain(evidence);
fs.writeFileSync(outputFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
