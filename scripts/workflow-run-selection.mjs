export function selectExactRun({ runs, workflowName, event, headSha, beforeRunId }) {
  const candidates = runs.filter((run) => (
    run.name === workflowName
    && run.event === event
    && run.head_sha === headSha
    && run.id > beforeRunId
    && run.run_name === `dev-${headSha}-${run.id}-${run.run_attempt ?? 1}`
  ));
  if (candidates.length === 0) throw new Error('EXACT_RUN_NOT_FOUND');
  if (candidates.length !== 1) throw new Error('AMBIGUOUS_RUN');
  const [run] = candidates;
  return {
    id: run.id,
    htmlUrl: run.html_url,
    headSha: run.head_sha,
    event: run.event,
    workflowName: run.name,
    runName: run.run_name,
  };
}

export function parseDispatchRunUrl(output) {
  const matches = output.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/actions\/runs\/\d+/g) ?? [];
  const unique = [...new Set(matches)];
  if (unique.length === 0) throw new Error('DISPATCH_RUN_URL_NOT_FOUND');
  if (unique.length !== 1) throw new Error('AMBIGUOUS_DISPATCH_RUN_URL');
  return { runId: Number(unique[0].split('/').at(-1)), runUrl: unique[0] };
}

export function assertQueueOrderFromWait(queuedRuns) {
  if (queuedRuns.length > 100) throw new Error('QUEUE_LIMIT_EXCEEDED');
  let previous = Number.NEGATIVE_INFINITY;
  for (const run of queuedRuns) {
    const startedAt = Date.parse(run.waitingStartedAt);
    if (!Number.isFinite(startedAt)) throw new Error('INVALID_WAIT_START');
    if (startedAt < previous) throw new Error('WAIT_START_ORDER_VIOLATION');
    previous = startedAt;
  }
  return queuedRuns.map((run) => run.id);
}
