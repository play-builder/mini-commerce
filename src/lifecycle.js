import { clearTimeout, setTimeout } from 'node:timers';

function closeServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

export function createShutdownSignalHandler({ shutdown, onFailure }) {
  return () => Promise.resolve()
    .then(() => shutdown())
    .catch(() => {
      try { onFailure('application.shutdown.failed'); } catch {
        // Signal handling must not create a second unhandled rejection.
      }
    });
}

export function createLifecycle({
  readiness, publicServer, managementServer, pool, telemetry, observer, logger,
  deadlineMs = 30000, exit = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let current;
  return {
    shutdown() {
      if (current) return current;
      current = (async () => {
        let forced = false;
        let cleanupFailed = false;
        let exited = false;
        const invokeExit = (code) => {
          if (exited) return;
          exited = true;
          exit(code);
        };
        const attempt = async (cleanup) => {
          try {
            await cleanup();
          } catch {
            cleanupFailed = true;
            try { logger?.error?.('application.shutdown.cleanup_failed'); } catch {
              // Shutdown must continue even when the logging destination is unavailable.
            }
          }
        };
        const timer = setTimer(() => {
          forced = true;
          try { publicServer.closeAllConnections?.(); } catch {
            // The remaining forced-shutdown actions must still run.
          }
          try { managementServer.closeAllConnections?.(); } catch {
            // The process exit is the final deadline enforcement boundary.
          }
          try { logger?.error?.('application.shutdown.forced'); } catch {
            // Logging failure cannot prevent deadline enforcement.
          }
          invokeExit(1);
        }, deadlineMs);
        await attempt(async () => readiness.markNotReady('shutting down'));
        await attempt(async () => logger?.info?.('application.shutdown.started'));
        try {
          await attempt(() => closeServer(publicServer));
          if (pool) await attempt(() => pool.end());
          if (observer) await attempt(() => observer.close());
          await attempt(() => telemetry.shutdown());
          await attempt(() => closeServer(managementServer));
          if (!forced) {
            if (!cleanupFailed) {
              await attempt(async () => logger?.info?.('application.shutdown.completed'));
            }
            invokeExit(cleanupFailed ? 1 : 0);
          }
        } finally { clearTimer(timer); }
      })();
      return current;
    },
  };
}
