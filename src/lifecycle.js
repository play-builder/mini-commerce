import { clearTimeout, setTimeout } from 'node:timers';

export function createLifecycle({
  readiness, publicServer, managementServer, pool, telemetry, observer, logger,
  deadlineMs = 30000, exit = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let current;
  return {
    shutdown() {
      if (current) return current;
      current = (async () => {
        readiness.markNotReady('shutting down');
        logger?.info?.('application.shutdown.started');
        let forced = false;
        const timer = setTimer(() => {
          forced = true;
          publicServer.closeAllConnections?.();
          managementServer.closeAllConnections?.();
          logger?.error?.('application.shutdown.forced');
          exit(1);
        }, deadlineMs);
        try {
          await new Promise((resolve) => publicServer.close(resolve));
          if (pool) await pool.end();
          observer?.close?.();
          await telemetry.shutdown();
          await new Promise((resolve) => managementServer.close(resolve));
          if (!forced) {
            logger?.info?.('application.shutdown.completed');
            exit(0);
          }
        } finally { clearTimer(timer); }
      })();
      return current;
    },
  };
}
