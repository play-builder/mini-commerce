export function createDatabaseObservability({ pool, metrics, logger }) {
  const onError = () => {
    metrics?.recordPoolError?.();
    logger?.error?.('database.pool.error');
  };
  pool.on('error', onError);
  return {
    snapshot() {
      const snapshot = { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount };
      metrics?.observePool?.(snapshot);
      return snapshot;
    },
    close() { pool.off('error', onError); },
  };
}
