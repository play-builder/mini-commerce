import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const lock = YAML.parse(fs.readFileSync(new URL('../versions.lock.yaml', import.meta.url), 'utf8'));
const steps = workflow.jobs['attest-and-verify'].steps;

function installer() {
  const step = steps.find((item) => item.id === 'install-trivy');
  assert.ok(step, 'the scanner must be installed from a checksum-verified release archive');
  return step;
}

function executeInstaller(t, corrupt = false) {
  const step = installer();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-install-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const tools = path.join(directory, 'tools');
  const runner = path.join(directory, 'runner');
  for (const value of [source, tools, runner]) fs.mkdirSync(value);
  fs.writeFileSync(path.join(source, 'trivy'), '#!/bin/sh\necho executed > "$TRIVY_EXECUTED"\necho "Version: fixture"\n', { mode: 0o755 });
  const archive = path.join(directory, 'scanner.tar.gz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', source, 'trivy'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (corrupt) fs.appendFileSync(archive, 'tampered');
  // The download is external; extraction, hash checking and PATH publication execute unchanged.
  fs.writeFileSync(path.join(tools, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then cp "$SCANNER_ARCHIVE" "$2"; exit; fi\n  shift\ndone\nexit 2\n', { mode: 0o755 });
  const execution = path.join(directory, 'executed');
  const githubPath = path.join(directory, 'github-path');
  fs.writeFileSync(githubPath, '');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
    encoding: 'utf8',
    env: {
      ...process.env, ...step.env,
      PATH: `${tools}:${process.env.PATH}`,
      RUNNER_TEMP: runner, GITHUB_PATH: githubPath,
      SCANNER_ARCHIVE: archive, TRIVY_EXECUTED: execution,
      TRIVY_ARCHIVE_SHA256: hash,
    },
  });
  return { result, runner, execution, githubPath };
}

test('verified scanner archive is executable and published for both architecture scans', (t) => {
  const { result, runner, execution, githubPath } = executeInstaller(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(execution, 'utf8').trim(), 'executed');
  assert.equal(fs.readFileSync(githubPath, 'utf8').trim(), path.join(runner, 'trivy-bin'));
});

test('corrupted scanner archive is neither executed nor added to PATH', (t) => {
  const { result, runner, execution, githubPath } = executeInstaller(t, true);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(execution), false);
  assert.equal(fs.existsSync(path.join(runner, 'trivy-bin', 'trivy')), false);
  assert.equal(fs.readFileSync(githubPath, 'utf8'), '');
});

test('architecture scans use the locked patched action and preinstalled engine before attestation', () => {
  const setup = installer();
  assert.equal(setup.env.TRIVY_VERSION, lock.delivery.trivy);
  assert.equal(setup.env.TRIVY_ARCHIVE_SHA256, lock.delivery.trivyLinuxAmd64Sha256);
  assert.match(setup.env.TRIVY_ARCHIVE_SHA256, /^[a-f0-9]{64}$/);
  const scans = steps.filter((step) => step.uses?.startsWith('aquasecurity/trivy-action@'));
  assert.equal(scans.length, 2);
  const attestation = steps.findIndex((step) => step.uses?.startsWith('actions/attest@'));
  for (const [index, architecture] of ['amd64', 'arm64'].entries()) {
    const scan = scans[index];
    assert.equal(scan.uses, `aquasecurity/trivy-action@${lock.delivery.trivyActionSha}`);
    assert.equal(scan.with.version, `v${lock.delivery.trivy}`);
    assert.equal(scan.with['skip-setup-trivy'], true);
    assert.equal(scan.with['image-ref'], `\${{ needs.build.outputs.image_repository }}@\${{ steps.platforms.outputs.${architecture} }}`);
    assert.equal(scan.with['exit-code'], 1);
    assert.equal(scan.with.severity, 'CRITICAL,HIGH');
    assert.equal(scan['continue-on-error'], undefined);
    assert.equal(scan.if, undefined);
    assert.ok(steps.indexOf(setup) < steps.indexOf(scan));
    assert.ok(steps.indexOf(scan) < attestation);
  }
});
