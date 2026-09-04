import { config } from './config.js';
import { createRuntime } from './runtime.js';

const runtime = createRuntime({ runtimeConfig: config });
await runtime.start();
process.on('SIGTERM', () => runtime.shutdown());
process.on('SIGINT', () => runtime.shutdown());
