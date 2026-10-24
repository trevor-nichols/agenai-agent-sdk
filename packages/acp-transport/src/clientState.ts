// ------------------------------------------------------------------------------------------------
//                clientState.ts - ACP client state records and bounded timing helpers
// ------------------------------------------------------------------------------------------------

import type { AcpRequestOptions } from './clientContracts.js';
import type { AcpJsonValue } from './json.js';
import { acpRequestIdKey, type AcpRequestId } from './protocol.js';

export interface PendingRequest {
  readonly id: AcpRequestId;
  readonly method: string;
  readonly extension: boolean;
  readonly resolve: (value: AcpJsonValue) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  readonly removeAbortListener: () => void;
  readonly onResponseReceived?: AcpRequestOptions['onResponseReceived'];
}

export interface ActiveReverseRequest {
  readonly controller: AbortController;
  readonly settlement: Promise<void>;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function isCriticalExtensionMethod(method: string): boolean {
  return method.startsWith('_') || method.startsWith('$/');
}

export function resolveRequestTimeout(input: {
  readonly options: AcpRequestOptions;
  readonly now: number;
  readonly defaultMs: number;
  readonly maximumMs: number;
}): number | undefined {
  if (input.options.lifetime === 'until_settled') {
    if (Reflect.has(input.options, 'timeoutMs') || Reflect.has(input.options, 'deadlineAt')) {
      throw new TypeError('Until-settled ACP requests cannot select finite timing.');
    }
    return undefined;
  }
  if (input.options.lifetime !== undefined && input.options.lifetime !== 'bounded') {
    throw new TypeError('ACP request lifetime is invalid.');
  }
  const requested = input.options.timeoutMs ?? input.defaultMs;
  if (!Number.isSafeInteger(requested) || requested <= 0 || requested > input.maximumMs) {
    throw new TypeError('ACP request timeout is outside the supported range.');
  }
  if (input.options.deadlineAt === undefined) return requested;
  const deadline = input.options.deadlineAt instanceof Date
    ? input.options.deadlineAt.getTime()
    : input.options.deadlineAt;
  if (!Number.isFinite(deadline)) throw new TypeError('ACP request deadline is invalid.');
  return Math.min(requested, Math.floor(deadline - input.now));
}

export function cleanupPendingRequest(
  pending: Map<string, PendingRequest>,
  entry: PendingRequest,
): void {
  clearTimeout(entry.timer);
  entry.removeAbortListener();
  pending.delete(acpRequestIdKey(entry.id));
}
