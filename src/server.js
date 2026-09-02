import { config } from './config.js';
import { state, markReady, markShuttingDown } from './state.js';
import { createApp } from './routes.js';
import { createCommerceService } from './commerce-service.js';
import { createDatabasePool, createPostgresCommerceRepository } from './database.js';

const pool = config.databaseEnabled ? createDatabasePool(config.database) : null;
const commerceService = pool ? createCommerceService(createPostgresCommerceRepository(pool)) : null;
const app = createApp({ databaseEnabled: config.databaseEnabled, commerceService });
const server = app.listen(config.port, () => {
  console.log(`listening on ${config.port}, version ${config.version}, pod ${config.podName}`);
});

if (config.readyDelayMs > 0) {
  console.log(`readiness 를 ${config.readyDelayMs}ms 뒤에 켭니다`);
  setTimeout(markReady, config.readyDelayMs);
} else {
  markReady();
}

function shutdown(signal) {
  if (state.shuttingDown) {
    return;
  }

  markShuttingDown();
  console.log(`${signal} 수신, readiness 해제. ${config.shutdownDelayMs}ms 뒤에 종료합니다`);

  setTimeout(() => {
    server.close(async () => {
      if (pool) await pool.end();
      console.log('연결을 모두 닫았습니다');
      process.exit(0);
    });
  }, config.shutdownDelayMs);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
