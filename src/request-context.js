import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const storage = new AsyncLocalStorage();

export function requestId(value) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value ?? '') ? value : randomUUID().replaceAll('-', '');
}

export function runWithRequestContext(context, callback) {
  return storage.run(Object.freeze(context), callback);
}

export function getRequestContext() {
  return storage.getStore() ?? {};
}
