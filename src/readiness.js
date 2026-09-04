export function createReadiness({ dependencyPolicy = 'startup-only', checkDependency = async () => true } = {}) {
  let ready = false;
  let reason = 'starting';
  return {
    async initialize() {
      if (await checkDependency()) {
        ready = true;
        reason = undefined;
      } else {
        ready = false;
        reason = 'dependency unavailable';
      }
    },
    markReady() { ready = true; reason = undefined; },
    markNotReady(nextReason = 'not ready') { ready = false; reason = nextReason; },
    recordDependencyFailure() {
      if (dependencyPolicy === 'continuous') {
        ready = false;
        reason = 'dependency unavailable';
      }
    },
    snapshot() { return Object.freeze({ ready, phase: ready ? 'ready' : 'not-ready', dependencyPolicy, reason }); },
  };
}
