export function createLifecycle({ readiness, publicServer, managementServer, pool, telemetry, exit = () => {} }) {
  let current;
  return {
    shutdown() {
      if (current) return current;
      current = (async () => {
        readiness.markNotReady('shutting down');
        await new Promise((resolve) => publicServer.close(resolve));
        if (pool) await pool.end();
        await telemetry.shutdown();
        await new Promise((resolve) => managementServer.close(resolve));
        exit(0);
      })();
      return current;
    },
  };
}
