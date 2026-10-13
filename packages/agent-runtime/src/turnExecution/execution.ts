// ------------------------------------------------------------------------------------------------
//                execution.ts - One lazy output owner and concurrent exact request delivery
// ------------------------------------------------------------------------------------------------

import {
  parseAgentRequestResolution, parseAgentRequestResolutionFor,
  type AgentProviderKey,
} from "@agen-ai/agent-protocol";

import { AgentProviderDelegatedOperationError, throwAgentProviderContractError } from "../contractErrors.js";
import { throwIfAgentOperationAborted } from "../foundation.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";
import type { AgentProviderOutput } from "../outputs.js";
import type {
  AgentProviderResolveRequestInput, AgentProviderStartTurnInput,
  AgentProviderTurnExecution, AgentRequestResolutionResult,
} from "../sessions.js";
import { validateAgentRequestResolutionResult } from "./receipts.js";
import { createAgentTurnRequestAdmission, type PendingAgentRequest, type SuspendedAgentTurnRequests } from "./requests.js";

type ExecutionState =
  | Readonly<{ kind: "reserved" }>
  | Readonly<{ kind: "entering" }>
  | Readonly<{ kind: "entered"; candidate: AgentProviderTurnExecution; iterator: AsyncIterator<AgentProviderOutput> }>
  | Readonly<{ kind: "settled" }>
  | Readonly<{ kind: "stopped"; reason: Error }>;

export interface ValidatedAgentTurnExecution {
  readonly execution: AgentProviderTurnExecution;
  readonly hasEntered: () => boolean;
  readonly stop: (reason: Error) => void;
  readonly join: () => Promise<void>;
  readonly suspendRequests: () => SuspendedAgentTurnRequests;
}

export function createValidatedAgentTurnExecution(input: Readonly<{
  providerKey: AgentProviderKey;
  turnInput: AgentProviderStartTurnInput;
  pendingRequests: Map<string, PendingAgentRequest>;
  inFlightOperations: Set<Promise<void>>;
  start: (input: AgentProviderStartTurnInput) => AgentProviderTurnExecution;
  requireUsable: () => void;
  isTerminal: () => boolean;
  observe: (output: AgentProviderOutput) => AgentProviderOutput;
  assertCompleted: () => void;
  release: () => void;
  retire: () => void;
  abandon: () => Promise<void>;
}>): ValidatedAgentTurnExecution {
  let state: ExecutionState = { kind: "reserved" };
  let source: AsyncIterator<AgentProviderOutput> | undefined;
  const requests = createAgentTurnRequestAdmission({ pendingRequests: input.pendingRequests,
    canRestore: () => state.kind === "entered" && !input.isTerminal() });
  let acquired = false;
  let pulling = false;
  let returnPromise: Promise<IteratorResult<AgentProviderOutput>> | undefined;
  const lifetime = new AbortController();
  const nativeOperations = new Set<Promise<unknown>>();
  const fail = (code: "concurrent_turn" | "request_resolution_mismatch" | "invalid_operation_result", message: string): never =>
    throwAgentProviderContractError(input.providerKey, code, message);
  const abortError = () => {
    try { throwIfAgentOperationAborted(lifetime.signal); } catch (error) {
      if (error instanceof Error) return error;
    }
    return new DOMException("The turn execution was stopped.", "AbortError");
  };
  const detachAbort = () => input.turnInput.signal?.removeEventListener("abort", abort);
  const stop = (reason: Error): void => {
    if (state.kind === "settled" || state.kind === "stopped") return;
    const entered = state.kind === "entered" || state.kind === "entering";
    state = { kind: "stopped", reason };
    requests.withdraw();
    lifetime.abort(reason);
    detachAbort();
    if (entered) input.retire();
    else input.release();
  };
  const abort = () => {
    let reason: Error = new DOMException("The turn execution was aborted.", "AbortError");
    try { throwIfAgentOperationAborted(input.turnInput.signal); } catch (error) {
      if (error instanceof Error) reason = error;
    }
    stop(reason);
  };
  input.turnInput.signal?.addEventListener("abort", abort, { once: true });

  const track = <Value>(operation: Promise<Value>): Promise<Value> => {
    nativeOperations.add(operation);
    void operation.then(() => nativeOperations.delete(operation), () => nativeOperations.delete(operation));
    return operation;
  };
  const join = async (): Promise<void> => {
    while (nativeOperations.size > 0 || input.inFlightOperations.size > 0) {
      await Promise.allSettled([...nativeOperations, ...input.inFlightOperations]);
    }
    if (source?.return) await source.return();
  };
  const requireAnswerable = (): void => {
    input.requireUsable();
    if (state.kind !== "entered" || input.isTerminal()) {
      fail("request_resolution_mismatch", "Request no longer belongs to an answerable turn execution.");
    }
  };
  const resolveRequest = async (requestInput: AgentProviderResolveRequestInput): Promise<AgentRequestResolutionResult> => {
    requireAnswerable();
    throwIfAgentOperationAborted(requestInput.signal);
    const resolution = parseAgentRequestResolution(requestInput.resolution);
    const pending = input.pendingRequests.get(resolution.requestId);
    if (!pending || pending.turnId !== input.turnInput.turnId) {
      return fail("request_resolution_mismatch", "Resolution does not identify an answerable request in this execution.");
    }
    try { parseAgentRequestResolutionFor(pending.request, resolution); } catch {
      return fail("request_resolution_mismatch", "Resolution does not match the opened request.");
    }
    if (pending.request.expiresAt !== undefined && Date.parse(pending.request.expiresAt) <= Date.now()
      && resolution.disposition !== "canceled") {
      return fail("request_resolution_mismatch", "Resolution identifies an expired request.");
    }
    if (state.kind !== "entered") return fail("request_resolution_mismatch", "Turn execution is no longer live.");
    const candidate = state.candidate;
    const restore = requests.claim(resolution.requestId, pending);
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => { settle = resolve; });
    input.inFlightOperations.add(settlement);
    try {
      try {
        requestInput.onProviderExecutionStarted?.();
        throwIfAgentOperationAborted(requestInput.signal);
        throwIfAgentOperationAborted(lifetime.signal);
        requireAnswerable();
      } catch (error) { restore(); throw error; }
      let result: AgentRequestResolutionResult;
      try {
        const signal = requestInput.signal === undefined ? lifetime.signal
          : AbortSignal.any([lifetime.signal, requestInput.signal]);
        result = validateAgentRequestResolutionResult(await candidate.resolveRequest({ resolution, signal }), input.providerKey);
      } catch (error) {
        input.retire();
        throw new AgentProviderDelegatedOperationError(input.providerKey, "resolve_request", error);
      }
      if (result.status === "rejected" && result.requestState === "pending") restore();
      if (result.status === "delivery_uncertain") input.retire();
      return result;
    } finally {
      input.inFlightOperations.delete(settlement);
      settle();
    }
  };

  const next = async (): Promise<IteratorResult<AgentProviderOutput>> => {
    if (state.kind === "stopped") throw state.reason;
    if (state.kind === "settled") return { done: true, value: undefined };
    if (pulling) return fail("concurrent_turn", "Turn output permits only one outstanding pull.");
    pulling = true;
    let removeAbort = () => {};
    try {
      if (state.kind === "reserved") input.requireUsable();
      throwIfAgentOperationAborted(lifetime.signal);
      if (state.kind === "reserved") {
        try { input.turnInput.onProviderExecutionStarted?.(); } catch (error) {
          state = { kind: "settled" };
          detachAbort();
          input.release();
          throw error;
        }
        throwIfAgentOperationAborted(lifetime.signal);
        input.requireUsable();
        const { onProviderExecutionStarted: _observer, ...turnInput } = input.turnInput;
        // The observer has returned successfully; candidate entry is now owned even if it throws.
        state = { kind: "entering" };
        try {
          const candidate = input.start({ ...turnInput, signal: lifetime.signal });
          if (candidate === null || typeof candidate !== "object" || candidate.turnId !== turnInput.turnId
            || !hasExactOwnKeys(candidate, ["turnId", "outputs", "resolveRequest"]) || typeof candidate.resolveRequest !== "function"
            || !candidate.outputs || typeof candidate.outputs[Symbol.asyncIterator] !== "function") {
            return fail("invalid_operation_result", "Provider returned an invalid turn execution.");
          }
          source = candidate.outputs[Symbol.asyncIterator]();
          throwIfAgentOperationAborted(lifetime.signal);
          state = { kind: "entered", candidate, iterator: source };
        } catch (error) {
          stop(error instanceof Error ? error : new Error("Provider turn entry failed.", { cause: error }));
          throw error;
        }
      }
      if (state.kind !== "entered") throw abortError();
      const nativePull = track(Promise.resolve().then(() => state.kind === "entered"
        ? state.iterator.next() : Promise.reject(abortError())));
      const stopped = new Promise<never>((_, reject) => {
        const onAbort = () => reject(abortError());
        lifetime.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => lifetime.signal.removeEventListener("abort", onAbort);
      });
      const result = await Promise.race([nativePull, stopped]);
      throwIfAgentOperationAborted(lifetime.signal);
      if (!result.done) {
        const output = input.observe(result.value);
        if (output.kind === "event" && output.event.type === "request.opened") requests.observeRequest();
        return { done: false, value: output };
      }
      while (input.inFlightOperations.size > 0) {
        await Promise.race([Promise.all(input.inFlightOperations), stopped]);
      }
      throwIfAgentOperationAborted(lifetime.signal);
      input.assertCompleted();
      state = { kind: "settled" };
      detachAbort();
      input.release();
      return { done: true, value: undefined };
    } catch (error) {
      if (state.kind === "entered" || state.kind === "entering") stop(error instanceof Error ? error : new Error("Provider output failed.", { cause: error }));
      throw error;
    } finally { removeAbort(); pulling = false; }
  };
  const iterator: AsyncIterator<AgentProviderOutput> = {
    next,
    return() {
      if (returnPromise) return returnPromise;
      if (state.kind === "settled") return Promise.resolve({ done: true, value: undefined });
      const entered = state.kind === "entered" || source !== undefined;
      stop(new DOMException("The turn output consumer returned.", "AbortError"));
      returnPromise = (entered ? input.abandon() : Promise.resolve()).then(() => ({ done: true, value: undefined }));
      return returnPromise;
    },
  };
  const outputs: AsyncIterable<AgentProviderOutput> = Object.freeze({
    [Symbol.asyncIterator]() {
      if (acquired) return fail("concurrent_turn", "Turn output has exactly one consumer.");
      acquired = true;
      return iterator;
    },
  });
  return {
    execution: Object.freeze({ turnId: input.turnInput.turnId, outputs, resolveRequest }),
    hasEntered: () => state.kind === "entering" || state.kind === "entered",
    stop, join, suspendRequests: requests.suspend,
  };
}
