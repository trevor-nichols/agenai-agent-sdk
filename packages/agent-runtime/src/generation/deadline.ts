import { throwIfAgentOperationAborted } from "../foundation.js";
import { AgentGenerationError } from "./errors.js";

export const AGENT_GENERATION_TIMEOUT_MS = 300_000;
export const AGENT_GENERATION_MAX_TIMEOUT_MS = 3_600_000;
export const AGENT_GENERATION_OBSERVER_TIMEOUT_MS = 30_000;
export const AGENT_GENERATION_REQUEST_TIMEOUT_MS = 300_000;
export const AGENT_GENERATION_RESPONSE_TIMEOUT_MS = 30_000;
export const AGENT_GENERATION_CLEANUP_TIMEOUT_MS = 30_000;
export const AGENT_GENERATION_REQUEST_LIMIT = 8;

export function waitForGenerationWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    try { throwIfAgentOperationAborted(signal); } catch (error) { return Promise.reject(error); }
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      try { throwIfAgentOperationAborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createGenerationDeadline(deadlineAt: number, callerSignal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => {
    try { throwIfAgentOperationAborted(callerSignal); } catch (error) { controller.abort(error); }
  };
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) abort();
  const expire = () => controller.abort(new AgentGenerationError("timeout", "Object generation exceeded its deadline."));
  const timeout = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
  return {
    signal: controller.signal,
    check(): void {
      if (Date.now() >= deadlineAt && !controller.signal.aborted) expire();
      throwIfAgentOperationAborted(controller.signal);
    },
    stop(error: unknown): void { controller.abort(error); },
    dispose(): void { clearTimeout(timeout); callerSignal?.removeEventListener("abort", abort); },
  };
}

export async function waitForBoundedGenerationWork<T>(
  work: Promise<T>, signal: AbortSignal, timeoutMs: number, error: Error,
): Promise<T> {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  const timeout = setTimeout(() => controller.abort(error), timeoutMs);
  try {
    const result = await waitForGenerationWork(work, AbortSignal.any([signal, controller.signal]));
    if (Date.now() >= expiresAt) throw error;
    return result;
  }
  finally { clearTimeout(timeout); }
}
