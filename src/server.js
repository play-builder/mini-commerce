import { config } from './config.js';
import { createShutdownSignalHandler } from './lifecycle.js';
import { createRuntime } from './runtime.js';

const runtime = createRuntime({ runtimeConfig: config });
await runtime.start();
const shutdownOnSignal = createShutdownSignalHandler({
  shutdown: () => runtime.shutdown(),
  onFailure: (event) => {
    runtime.logger.error(event);
    process.exitCode = 1;
  },
});
process.on('SIGTERM', shutdownOnSignal);
process.on('SIGINT', shutdownOnSignal);
