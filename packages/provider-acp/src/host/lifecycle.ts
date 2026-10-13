import type { MaybePromise } from '@agen-ai/agent-runtime';
import { AcpProviderConnectionError } from '../connection/errors.js';

export function hostDeadline(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(() => controller.abort(new AcpProviderConnectionError(
    'acp_host_operation_timeout', 'The host operation exceeded its deadline.',
  )), timeoutMs);
  return { signal: controller.signal, close() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
}

export function awaitHost<Value>(operation: PromiseLike<Value> | Value, signal: AbortSignal): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(signal.reason ?? new DOMException('Host operation canceled.', 'AbortError')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(operation).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

/** Explicit retries repeat failed releases only; concurrent releases share one attempt. */
export function ownedRelease(release: () => MaybePromise<void>, timeoutMs = 30_000): () => Promise<void> {
  let released = false;
  let pending: Promise<void> | undefined;
  return () => {
    if (released) return Promise.resolve();
    pending ??= Promise.resolve().then(async () => {
      const deadline = hostDeadline(new AbortController().signal, timeoutMs);
      try { await awaitHost(Promise.resolve().then(release), deadline.signal); } finally { deadline.close(); }
    }).then(() => { released = true; })
      .catch((error) => { pending = undefined; throw error; });
    return pending;
  };
}
