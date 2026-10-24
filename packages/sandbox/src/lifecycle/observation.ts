// ------------------------------------------------------------------------------------------------
//                observation.ts - Bounded waits retaining actual work - Operation errors and timers
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '../errors.js';
import { scheduleDeadline } from './deadline.js';

/** Limits a caller's wait without replacing or abandoning the actual operation. */
export function observe<T>(actual: Promise<T>, deadlineMs: number | undefined, options: {
  readonly signal?: AbortSignal;
  readonly onInterrupt?: (error: SandboxOperationError) => void;
} = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cancelDeadline?.();
      options.signal?.removeEventListener('abort', abort);
      complete();
    };
    const interrupt = (error: SandboxOperationError) => finish(() => {
      options.onInterrupt?.(error);
      reject(error);
    });
    const abort = () => interrupt(options.signal?.reason instanceof SandboxOperationError
      ? options.signal.reason : new SandboxOperationError('cancelled', 'Sandbox operation was cancelled.'));
    const cancelDeadline = deadlineMs === undefined ? undefined : scheduleDeadline(deadlineMs,
      () => interrupt(new SandboxOperationError('deadline_exceeded', 'Sandbox operation exceeded its observation deadline.')));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    actual.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

export function actualOperation<T>(perform: () => Promise<T>): Promise<T> {
  try { return Promise.resolve(perform()); }
  catch (error) { return Promise.reject(error); }
}

export function settled(actual: Promise<unknown> | undefined): Promise<void> {
  return actual?.then(() => undefined, () => undefined) ?? Promise.resolve();
}
