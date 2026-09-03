import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { selectExactRun } from '../scripts/workflow-run-selection.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/workflow-runs/${name}`, import.meta.url),
  'utf8',
));

const selection = {
  workflowName: 'build-and-deploy-dev',
  event: 'push',
  headSha: '1111111111111111111111111111111111111111',
  runName: 'dev-1111111111111111111111111111111111111111-712-1',
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
    runName: selection.runName,
  });
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
