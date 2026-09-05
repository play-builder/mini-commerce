export function createDatabaseObservability({ pool, metrics, logger, readiness }) {
  const onError = () => {
    metrics?.recordPoolError?.();
    logger?.error?.('database.pool.error', { reason: 'idle_client_error' });
    readiness?.recordDependencyFailure?.();
  };
  pool.on('error', onError);
  return {
    snapshot() {
      const snapshot = { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount };
      metrics?.observePool?.(snapshot);
      return snapshot;
    },
    recordOperationFailure(details) {
      metrics?.recordDatabaseFailure?.(details.operation);
      logger?.error?.('database.operation.failed', details);
      readiness?.recordDependencyFailure?.();
    },
    recordOperationRecovery() { readiness?.recordDependencyRecovery?.(); },
    close() { pool.off('error', onError); },
  };
}
