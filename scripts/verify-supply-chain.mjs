import fs from 'node:fs';

const digestPattern = /^sha256:[0-9a-f]{64}$/;

export function verifySupplyChain(evidence) {
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
