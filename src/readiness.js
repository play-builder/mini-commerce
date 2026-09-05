export function createReadiness({
  dependencyPolicy = 'startup-only', checkDependency = async () => true,
  failureThreshold = 1, recoveryThreshold = 1,
} = {}) {
  let ready = false;
  let reason = 'starting';
  let failures = 0;
  let recoveries = 0;
  return {
    async initialize() {
      let dependencyAvailable = false;
      try {
        dependencyAvailable = await checkDependency();
      } catch {
        dependencyAvailable = false;
      }
      if (dependencyAvailable) {
        ready = true;
        reason = undefined;
      } else {
        ready = false;
        reason = 'dependency unavailable';
      }
    },
    markReady() { ready = true; reason = undefined; failures = 0; recoveries = 0; },
    markNotReady(nextReason = 'not ready') { ready = false; reason = nextReason; },
    recordDependencyFailure() {
      if (dependencyPolicy === 'continuous') {
        failures += 1;
        recoveries = 0;
        if (failures >= failureThreshold) {
          ready = false;
          reason = 'dependency unavailable';
        }
      }
    },
    recordDependencyRecovery() {
      if (dependencyPolicy === 'continuous') {
        recoveries += 1;
        failures = 0;
        if (recoveries >= recoveryThreshold) { ready = true; reason = undefined; }
      }
    },
    snapshot() { return Object.freeze({ ready, phase: ready ? 'ready' : 'not-ready', dependencyPolicy, reason }); },
  };
}
