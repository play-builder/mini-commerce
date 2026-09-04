export function createDatabaseObservability({ pool, metrics, logger, readiness }) {
  const onError = () => {
    metrics?.recordPoolError?.();
    logger?.error?.('database.pool.error');
    readiness?.recordDependencyFailure?.();
  };
  const onConnect = () => readiness?.recordDependencyRecovery?.();
  pool.on('error', onError);
  pool.on('connect', onConnect);
  return {
    snapshot() {
      const snapshot = { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount };
      metrics?.observePool?.(snapshot);
      return snapshot;
    },
    close() { pool.off('error', onError); pool.off('connect', onConnect); },
  };
}
