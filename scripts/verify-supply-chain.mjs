import fs from 'node:fs';
import { acceptsLegacyRepositoryIdentity, assertRepositoryIdentity } from './repository-identity.mjs';

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const predicateTypes = Object.freeze({
  provenance: 'https://slsa.dev/provenance/v1',
  sbom: 'https://spdx.dev/Document/v2.3',
});

export function selectReferrerDigests(referrers) {
  const selectOne = (kind, predicateType) => {
    const matches = referrers.filter((referrer) => (
      referrer.annotations?.['dev.sigstore.bundle.predicateType'] === predicateType
    ));
    if (matches.length !== 1 || !digestPattern.test(matches[0].digest)) {
      throw new Error(`exactly one valid OCI ${kind} referrer is required`);
    }
    return matches[0].digest;
  };

  return {
    provenanceDigest: selectOne('provenance', predicateTypes.provenance),
    sbomDigest: selectOne('SBOM', predicateTypes.sbom),
  };
}

export function verifySupplyChain(evidence, { expectedRepositoryId } = {}) {
  if (evidence.repositoryId !== undefined) {
    assertRepositoryIdentity({
      repositoryId: evidence.repositoryId,
      repositoryName: evidence.repositoryName,
      expectedRepositoryId: expectedRepositoryId ?? evidence.repositoryId,
    });
  } else if (expectedRepositoryId && !acceptsLegacyRepositoryIdentity(expectedRepositoryId)) {
    throw new Error('REPOSITORY_ID_REQUIRED');
  }
  if (!digestPattern.test(evidence.imageDigest)) throw new Error('invalid image digest');
  if (evidence.workflowName !== 'ci') throw new Error('workflow identity mismatch');
  if (!/^[0-9a-f]{40}$/.test(evidence.sourceSha)) throw new Error('invalid source SHA');
  if (!evidence.imageRepository || /\s/.test(evidence.imageRepository)) {
    throw new Error('invalid image repository');
  }
  if (evidence.githubAttestation?.subjectDigest !== evidence.imageDigest) {
    throw new Error('GitHub attestation digest mismatch');
  }
  if (evidence.ociReferrers?.subjectDigest !== evidence.imageDigest) {
    throw new Error('OCI referrer digest mismatch');
  }
  if (!digestPattern.test(evidence.ociReferrers?.sbomDigest)) {
    throw new Error('OCI SBOM referrer is required');
  }
  if (!digestPattern.test(evidence.ociReferrers?.provenanceDigest)) {
    throw new Error('OCI provenance referrer is required');
  }
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    const scans = evidence.platforms?.filter((item) => item.platform === platform) ?? [];
    if (scans.length !== 1 || scans[0].trivyExitCode !== 0) {
      throw new Error(`${platform} scan is required`);
    }
    if (!digestPattern.test(scans[0].digest)) {
      throw new Error(`${platform} child digest is invalid`);
    }
  }
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2];
  if (!input) throw new Error('usage: verify-supply-chain.mjs EVIDENCE_JSON');
  verifySupplyChain(JSON.parse(fs.readFileSync(input, 'utf8')));
  console.log('PASS: verified supply-chain evidence');
}
