import { DockerDesktopCoordinatorError } from './contracts.js';
import type { DockerDesktopCoordinator, DockerDesktopCoordinatorOperationOptions } from './contracts.js';

export interface CoordinatorOperation {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export function parseCoordinatorOperation(input: DockerDesktopCoordinatorOperationOptions | undefined): CoordinatorOperation {
  if (input === undefined) return Object.freeze({ timeoutMs: 30_000 });
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new TypeError('Coordinator operation requires a plain options object.');
  }
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if ((key !== 'signal' && key !== 'timeoutMs') || !property?.enumerable || !('value' in property)) {
      throw new TypeError('Coordinator operation rejects unknown fields and accessors.');
    }
  }
  const { signal, timeoutMs = 30_000 } = input;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Coordinator operation requires an original AbortSignal.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Coordinator observation timeout must be an integer from 1 through 60000 milliseconds.');
  }
  return Object.freeze({ ...(signal === undefined ? {} : { signal }), timeoutMs });
}

export function observeCoordinatorOperation<Value>(
  actual: Promise<Value>, operation: CoordinatorOperation, owner: DockerDesktopCoordinator,
  interrupt?: () => void,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation.signal?.removeEventListener('abort', cancelled);
      complete();
    };
    const interrupted = (by: 'signal' | 'deadline') => finish(() => {
      interrupt?.();
      reject(new DockerDesktopCoordinatorError({ kind: 'interrupted', by, effect: 'owned' }, owner));
    });
    const cancelled = () => interrupted('signal');
    const timer = setTimeout(() => interrupted('deadline'), operation.timeoutMs);
    operation.signal?.addEventListener('abort', cancelled, { once: true });
    if (operation.signal?.aborted) cancelled();
    actual.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}
