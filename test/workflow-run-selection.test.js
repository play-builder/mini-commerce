import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  assertQueueOrderFromWait,
  parseDispatchRunUrl,
  selectExactRun,
} from '../scripts/workflow-run-selection.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/workflow-runs/${name}`, import.meta.url),
  'utf8',
));

const selection = {
  workflowName: 'ci',
  event: 'push',
  headSha: '1111111111111111111111111111111111111111',
  beforeRunId: 700,
};

test('exact workflow identity는 유일한 새 run만 선택한다', () => {
  const selected = selectExactRun({
    runs: fixture('one-exact-run.json').runs,
    ...selection,
  });
  assert.deepEqual(selected, {
    id: 712,
    htmlUrl: 'https://github.com/play-builder/cicd-course-sample-app/actions/runs/712',
    headSha: selection.headSha,
    event: selection.event,
    workflowName: selection.workflowName,
    runName: 'dev-1111111111111111111111111111111111111111-712-1',
  });
});

test('push runName은 candidate ID와 attempt에서 내부 계산한다', () => {
  const selected = selectExactRun({ runs: fixture('one-exact-run.json').runs, ...selection });
  assert.equal(selected.runName, `dev-${selection.headSha}-${selected.id}-1`);
});

test('dispatch 출력의 유일한 run URL과 ID를 보존한다', () => {
  const output = fs.readFileSync(
    new URL('./fixtures/workflow-runs/dispatch-output.txt', import.meta.url),
    'utf8',
  );
  assert.deepEqual(parseDispatchRunUrl(output), {
    runId: 1234567890,
    runUrl: 'https://github.com/play-builder/cicd-course-sample-app/actions/runs/1234567890',
  });
  assert.throws(() => parseDispatchRunUrl('no URL'), /DISPATCH_RUN_URL_NOT_FOUND/);
  assert.throws(
    () => parseDispatchRunUrl(`${output.trim()}\n${output.trim().replace('1234567890', '1234567891')}`),
    /AMBIGUOUS_DISPATCH_RUN_URL/,
  );
});

test('queue order는 dispatch 시각이 아니라 wait 시작 시각으로 확인한다', () => {
  const records = fixture('queued-fifo-from-wait.json').runs;
  assert.deepEqual(assertQueueOrderFromWait(records), [901, 902, 903]);
  assert.throws(() => assertQueueOrderFromWait([...records].reverse()), /WAIT_START_ORDER_VIOLATION/);
  assert.throws(() => assertQueueOrderFromWait(Array.from({ length: 101 }, (_, index) => ({
    id: index,
    waitingStartedAt: new Date(index * 1000).toISOString(),
    dispatchRequestedAt: new Date(0).toISOString(),
  }))), /QUEUE_LIMIT_EXCEEDED/);
});

test('queue fixture는 running 1개와 pending 1개만 포함한다', () => {
  const runs = fixture('running-one-pending-one.json').runs;
  assert.equal(runs.filter((run) => run.status === 'in_progress').length, 1);
  assert.equal(runs.filter((run) => run.status === 'queued').length, 1);
});

test('동일 identity에 둘 이상의 run이 있으면 선택하지 않는다', () => {
  assert.throws(() => selectExactRun({
    runs: fixture('ambiguous-runs.json').runs,
    ...selection,
  }), /AMBIGUOUS_RUN/);
});

test('일치하는 새 run이 없으면 선택하지 않는다', () => {
  assert.throws(() => selectExactRun({
    runs: fixture('one-exact-run.json').runs,
    ...selection,
    beforeRunId: 712,
  }), /EXACT_RUN_NOT_FOUND/);
});
