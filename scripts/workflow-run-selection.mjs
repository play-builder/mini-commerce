export function selectExactRun({ runs, workflowName, event, headSha, runName, beforeRunId }) {
  const candidates = runs.filter((run) => (
    run.name === workflowName
    && run.event === event
    && run.head_sha === headSha
    && run.run_name === runName
    && run.id > beforeRunId
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
