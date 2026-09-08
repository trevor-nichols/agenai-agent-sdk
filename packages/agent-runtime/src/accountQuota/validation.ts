// ------------------------------------------------------------------------------------------------
//                validation.ts - Account quota port validation and cancellation
// ------------------------------------------------------------------------------------------------

import {
  parseAgentAccountQuotaSnapshot,
  type AgentAccountQuotaSnapshot,
  type AgentProviderKey,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import { throwIfAgentOperationAborted } from "../foundation.js";
import type {
  AgentAccountQuotaObserve,
  AgentAccountQuotaPort,
  AgentAccountQuotaQuery,
  AgentAccountQuotaQueryInput,
  ValidateAgentAccountQuotaPortInput,
} from "./types.js";

/** Maximum time the runtime waits for a provider's native iterator cleanup. */
export const AGENT_ACCOUNT_QUOTA_ITERATOR_CLEANUP_TIMEOUT_MS = 1_000;

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSignal(value: unknown, field: string): asserts value is AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw new TypeError(`Account quota ${field} must be an AbortSignal.`);
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && actual.every((key) => typeof key === "string" && expected.includes(key))
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function contractError(providerKey: AgentProviderKey, detail: string): never {
  return throwAgentProviderContractError(
    providerKey,
    "capability_port_mismatch",
    `Provider ${providerKey} returned an invalid account quota ${detail}.`,
  );
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The agent operation was aborted.", "AbortError");
}

function awaitCancellable(candidate: unknown, signal: AbortSignal): Promise<unknown> {
  const providerResult = Promise.resolve(candidate);
  return new Promise((resolve, reject) => {
    let settled = false;
    const remove = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      remove();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    providerResult.then(
      (value) => {
        if (settled) return;
        settled = true;
        remove();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        remove();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function operationSignal(input: AgentAccountQuotaQueryInput): AbortSignal {
  if (!isObject(input)) {
    throw new TypeError("Account quota operation input must be an object.");
  }
  assertSignal(input.signal, "operation signal");
  return input.signal;
}

interface ProviderIterator {
  readonly iterator: object;
  readonly next: (...args: never[]) => unknown;
  readonly returnMethod?: (...args: never[]) => unknown;
}

function providerIterator(providerKey: AgentProviderKey, iterable: unknown): ProviderIterator {
  if (!isObject(iterable)) return contractError(providerKey, "observation");
  const factory = (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  if (typeof factory !== "function") return contractError(providerKey, "observation");
  const iterator = factory.call(iterable);
  if (!isObject(iterator)) return contractError(providerKey, "observation iterator");
  const next = (iterator as { next?: unknown }).next;
  if (typeof next !== "function") return contractError(providerKey, "observation iterator");
  const returnMethod = (iterator as { return?: unknown }).return;
  if (returnMethod !== undefined && typeof returnMethod !== "function") {
    return contractError(providerKey, "observation iterator");
  }
  return {
    iterator,
    next: next as (...args: never[]) => unknown,
    returnMethod: returnMethod as ((...args: never[]) => unknown) | undefined,
  };
}

function iteratorResult(value: unknown): value is IteratorResult<unknown> {
  if (!isObject(value)) return false;
  const done = (value as { done?: unknown }).done;
  return done === undefined || typeof done === "boolean";
}

function boundedCleanup(result: unknown, providerKey: AgentProviderKey): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `Provider ${providerKey} account quota iterator cleanup exceeded `
      + `${AGENT_ACCOUNT_QUOTA_ITERATOR_CLEANUP_TIMEOUT_MS}ms.`,
    )), AGENT_ACCOUNT_QUOTA_ITERATOR_CLEANUP_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve(result), timeout])
    .then(() => undefined)
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
}

interface IteratorState {
  readonly providerKey: AgentProviderKey;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  source?: ProviderIterator;
  cleanupPromise?: Promise<void>;
  closed: boolean;
  closedNormally: boolean;
  pendingNext: boolean;
}

function beginCleanup(state: IteratorState): Promise<void> {
  if (state.cleanupPromise !== undefined) return state.cleanupPromise;
  const source = state.source;
  if (source === undefined) return Promise.resolve();
  if (source.returnMethod === undefined) {
    state.cleanupPromise = Promise.resolve();
  } else {
    try {
      state.cleanupPromise = boundedCleanup(
        source.returnMethod.call(source.iterator),
        state.providerKey,
      );
    } catch (error) {
      state.cleanupPromise = Promise.reject(error);
    }
  }
  state.cleanupPromise.catch(() => undefined);
  return state.cleanupPromise;
}

function closeState(state: IteratorState): void {
  if (state.closed) {
    void beginCleanup(state);
    return;
  }
  state.closed = true;
  state.signal.removeEventListener("abort", state.onAbort);
  if (!state.controller.signal.aborted) state.controller.abort();
  void beginCleanup(state);
}

function createIterator(
  providerKey: AgentProviderKey,
  declaredObserve: AgentAccountQuotaObserve,
  receiver: object,
  lifetimeSignal: AbortSignal,
  operationSignalValue: AbortSignal,
): AsyncIterator<AgentAccountQuotaSnapshot> {
  const controller = new AbortController();
  const signal = AbortSignal.any([
    lifetimeSignal,
    operationSignalValue,
    controller.signal,
  ]);
  const state: IteratorState = {
    providerKey,
    controller,
    signal,
    onAbort: () => closeState(state),
    closed: false,
    closedNormally: false,
    pendingNext: false,
  };
  if (signal.aborted) closeState(state);
  else signal.addEventListener("abort", state.onAbort, { once: true });

  const source = (): ProviderIterator => {
    if (state.source !== undefined) return state.source;
    throwIfAgentOperationAborted(signal);
    const iterable = declaredObserve.call(receiver, { signal });
    state.source = providerIterator(providerKey, iterable);
    if (signal.aborted) closeState(state);
    return state.source;
  };

  const next = async (): Promise<IteratorResult<AgentAccountQuotaSnapshot>> => {
    if (state.pendingNext) {
      throw new TypeError("Concurrent account quota observation next calls are not supported.");
    }
    if (state.closed) {
      if (state.closedNormally || !signal.aborted) return { done: true, value: undefined };
      throwIfAgentOperationAborted(signal);
    }
    throwIfAgentOperationAborted(signal);
    state.pendingNext = true;
    try {
      const iterator = source();
      throwIfAgentOperationAborted(signal);
      const result = await awaitCancellable(iterator.next.call(iterator.iterator), signal);
      throwIfAgentOperationAborted(signal);
      if (!iteratorResult(result)) return contractError(providerKey, "observation");
      if (result.done === true) {
        state.closedNormally = true;
        closeState(state);
        await beginCleanup(state);
        return { done: true, value: undefined };
      }
      return { done: false, value: parseAgentAccountQuotaSnapshot(result.value) };
    } catch (error) {
      closeState(state);
      throw error;
    } finally {
      state.pendingNext = false;
    }
  };

  const returnIterator = async (
    value?: unknown,
  ): Promise<IteratorResult<AgentAccountQuotaSnapshot>> => {
    state.closedNormally = true;
    state.controller.abort();
    closeState(state);
    await beginCleanup(state);
    return { done: true, value: value as AgentAccountQuotaSnapshot };
  };

  return { next, return: returnIterator };
}

function wrapQuery(
  declaredQuery: AgentAccountQuotaQuery,
  receiver: object,
  lifetimeSignal: AbortSignal,
): AgentAccountQuotaQuery {
  return async (input: AgentAccountQuotaQueryInput) => {
    const signal = AbortSignal.any([lifetimeSignal, operationSignal(input)]);
    throwIfAgentOperationAborted(signal);
    const candidate = declaredQuery.call(receiver, { signal });
    const snapshot = await awaitCancellable(candidate, signal);
    throwIfAgentOperationAborted(signal);
    return parseAgentAccountQuotaSnapshot(snapshot);
  };
}

function wrapObserve(
  providerKey: AgentProviderKey,
  declaredObserve: AgentAccountQuotaObserve,
  receiver: object,
  lifetimeSignal: AbortSignal,
): AgentAccountQuotaObserve {
  return (input: AgentAccountQuotaQueryInput) => {
    const operationSignalValue = operationSignal(input);
    return {
      [Symbol.asyncIterator]() {
        return createIterator(
          providerKey,
          declaredObserve,
          receiver,
          lifetimeSignal,
          operationSignalValue,
        );
      },
    };
  };
}

function validateShape(providerKey: AgentProviderKey, candidate: unknown): AgentAccountQuotaPort {
  if (!isObject(candidate)) return contractError(providerKey, "port");
  const kind = (candidate as { kind?: unknown }).kind;
  const query = (candidate as { query?: unknown }).query;
  const observe = (candidate as { observe?: unknown }).observe;
  if (kind === "unsupported") {
    if (!exactKeys(candidate, ["kind"]) || "query" in candidate || "observe" in candidate) {
      return contractError(providerKey, "port");
    }
    return Object.freeze({ kind: "unsupported" });
  }
  if (kind === "query") {
    if (!exactKeys(candidate, ["kind", "query"]) || typeof query !== "function" || "observe" in candidate) {
      return contractError(providerKey, "port");
    }
    return candidate as AgentAccountQuotaPort;
  }
  if (kind === "observe") {
    if (!exactKeys(candidate, ["kind", "observe"]) || typeof observe !== "function" || "query" in candidate) {
      return contractError(providerKey, "port");
    }
    return candidate as AgentAccountQuotaPort;
  }
  if (kind === "query_and_observe") {
    if (!exactKeys(candidate, ["kind", "query", "observe"])
      || typeof query !== "function" || typeof observe !== "function") {
      return contractError(providerKey, "port");
    }
    return candidate as AgentAccountQuotaPort;
  }
  return contractError(providerKey, "port");
}

export function validateAgentAccountQuotaPort(
  input: ValidateAgentAccountQuotaPortInput,
): AgentAccountQuotaPort {
  if (!isObject(input)) {
    throw new TypeError("Account quota port validation input must be an object.");
  }
  assertSignal(input.signal, "instance signal");
  const declared = validateShape(input.providerKey, input.port);
  if (declared.kind === "unsupported") return declared;
  if (declared.kind === "query") {
    return Object.freeze({
      kind: "query" as const,
      query: wrapQuery(declared.query, declared, input.signal),
    });
  }
  if (declared.kind === "observe") {
    return Object.freeze({
      kind: "observe" as const,
      observe: wrapObserve(input.providerKey, declared.observe, declared, input.signal),
    });
  }
  return Object.freeze({
    kind: "query_and_observe" as const,
    query: wrapQuery(declared.query, declared, input.signal),
    observe: wrapObserve(input.providerKey, declared.observe, declared, input.signal),
  });
}
