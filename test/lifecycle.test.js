import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lifecycleModule from '../src/lifecycle.js';

const { createLifecycle } = lifecycleModule;

test('shutdown drains in deterministic order once', async () => {
  const calls = [];
  const close = (name) => (done) => { calls.push(name); done(); };
  const lifecycle = createLifecycle({
    readiness: { markNotReady: () => calls.push('readiness') },
    publicServer: { close: close('public') },
    managementServer: { close: close('management') },
    pool: { end: async () => calls.push('pool') },
    telemetry: { shutdown: async () => calls.push('telemetry') },
    exit: (code) => calls.push(`exit-${code}`),
  });
  await lifecycle.shutdown();
  await lifecycle.shutdown();
  assert.deepEqual(calls, ['readiness', 'public', 'pool', 'telemetry', 'management', 'exit-0']);
});

test('shutdown deadline force-closes listeners and uses injected exit', () => {
  let force;
  const calls = [];
  const lifecycle = createLifecycle({
    readiness: { markNotReady() {} },
    publicServer: { close() {}, closeAllConnections: () => calls.push('public-force') },
    managementServer: { close() {}, closeAllConnections: () => calls.push('management-force') },
    telemetry: { shutdown: async () => {} },
    exit: (code) => calls.push(`exit-${code}`),
    logger: { info() {}, error: (event) => calls.push(event) },
    setTimer: (callback) => { force = callback; return 1; }, clearTimer() {},
  });
  lifecycle.shutdown();
  force();
  assert.deepEqual(calls, ['public-force', 'management-force', 'application.shutdown.forced', 'exit-1']);
});

test('shutdown isolates cleanup failures and closes management last before a failure exit', async () => {
  const calls = [];
  const lifecycle = createLifecycle({
    readiness: { markNotReady: () => calls.push('readiness') },
    publicServer: { close: (done) => { calls.push('public'); done(new Error('public close failed')); } },
    managementServer: { close: (done) => { calls.push('management'); done(); } },
    pool: { end: async () => { calls.push('pool'); throw new Error('password=secret'); } },
    observer: { close: () => { calls.push('observer'); throw new Error('observer failed'); } },
    telemetry: { shutdown: async () => { calls.push('telemetry'); throw new Error('trace secret'); } },
    logger: { info: (event) => calls.push(event), error: (event) => calls.push(event) },
    exit: (code) => calls.push(`exit-${code}`),
    setTimer: () => 7,
    clearTimer: () => calls.push('timer-cleared'),
  });

  await lifecycle.shutdown();

  assert.deepEqual(calls, [
    'readiness', 'application.shutdown.started', 'public', 'application.shutdown.cleanup_failed',
    'pool', 'application.shutdown.cleanup_failed', 'observer', 'application.shutdown.cleanup_failed',
    'telemetry', 'application.shutdown.cleanup_failed', 'management', 'exit-1', 'timer-cleared',
  ]);
});

test('shutdown still exits when management close fails', async () => {
  const calls = [];
  const lifecycle = createLifecycle({
    readiness: { markNotReady() {} },
    publicServer: { close: (done) => done() },
    managementServer: { close: (done) => { calls.push('management'); done(new Error('close failed')); } },
    telemetry: { shutdown: async () => calls.push('telemetry') },
    logger: { info() {}, error: (event) => calls.push(event) },
    exit: (code) => calls.push(`exit-${code}`),
  });

  await lifecycle.shutdown();

  assert.deepEqual(calls, ['telemetry', 'management', 'application.shutdown.cleanup_failed', 'exit-1']);
});

test('shutdown still drains and exits when readiness or lifecycle logging fails', async () => {
  const calls = [];
  const lifecycle = createLifecycle({
    readiness: { markNotReady: () => { calls.push('readiness'); throw new Error('state failed'); } },
    publicServer: { close: (done) => { calls.push('public'); done(); } },
    managementServer: { close: (done) => { calls.push('management'); done(); } },
    telemetry: { shutdown: async () => calls.push('telemetry') },
    logger: {
      info: () => { calls.push('log-info'); throw new Error('log failed'); },
      error: () => { calls.push('log-error'); throw new Error('log failed'); },
    },
    exit: (code) => calls.push(`exit-${code}`),
  });

  await assert.doesNotReject(lifecycle.shutdown());

  assert.deepEqual(calls, [
    'readiness', 'log-error', 'log-info', 'log-error', 'public', 'telemetry', 'management', 'exit-1',
  ]);
});

test('signal handler consumes shutdown and failure-reporting rejections', async () => {
  assert.equal(typeof lifecycleModule.createShutdownSignalHandler, 'function');
  const failures = [];
  const handler = lifecycleModule.createShutdownSignalHandler({
    shutdown: async () => { throw new Error('password=secret'); },
    onFailure: (event) => failures.push(event),
  });

  const completion = handler();
  assert.ok(completion instanceof Promise);
  await assert.doesNotReject(completion);

  assert.deepEqual(failures, ['application.shutdown.failed']);

  const reportingFailure = lifecycleModule.createShutdownSignalHandler({
    shutdown: async () => { throw new Error('shutdown failed'); },
    onFailure: () => { throw new Error('logging failed'); },
  });
  await assert.doesNotReject(reportingFailure());
});
