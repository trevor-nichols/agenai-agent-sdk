// ------------------------------------------------------------------------------------------------
//                execution.ts - One lazy output owner and concurrent exact request delivery
// ------------------------------------------------------------------------------------------------

import {
  parseAgentRequestResolution, parseAgentRequestResolutionFor,
  type AgentProviderKey, type AgentTurnId,
} from "@agen-ai/agent-protocol";

import { AgentProviderContractError, AgentProviderDelegatedOperationError, throwAgentProviderContractError } from "../contractErrors.js";
import { throwIfAgentOperationAborted } from "../foundation.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";
import type { AgentExecutionInputSupport } from "../executionInput/types.js";
import { validateAgentExecutionInputPort } from "../executionInput/validation.js";
import { createExecutionInputOwner, type createExecutionInputCensus } from "../executionInput/lifetime.js";
import type { AgentProviderOutput } from "../outputs.js";
import type { AgentSessionAdmission } from "../sessionAdmission.js";
import type {
  AgentProviderResolveRequestInput, AgentProviderStartTurnInput,
  AgentProviderTurnExecution, AgentRequestResolutionResult,
} from "../sessions.js";
import { validateAgentRequestResolutionResult } from "./receipts.js";
import { createAgentTurnRequestAdmission, type AgentTurnRequestAdmission, type PendingAgentRequest, type SuspendedAgentTurnRequests } from "./requests.js";
import { createAgentTurnTerminalBuffer } from "./terminalBuffer.js";

type ExecutionState =
  | Readonly<{ kind: "reserved" }>
  | Readonly<{ kind: "parked"; candidate: AgentProviderTurnExecution }>
  | Readonly<{ kind: "entering" }>
  | Readonly<{ kind: "entered"; candidate: AgentProviderTurnExecution; iterator: AsyncIterator<AgentProviderOutput> }>
  | Readonly<{ kind: "settled" }>
  | Readonly<{ kind: "stopped"; reason: Error }>;

export interface ValidatedAgentTurnExecution {
  readonly execution: AgentProviderTurnExecution;
  readonly hasEntered: () => boolean;
  readonly stop: (reason: Error, inputReason?: "closed" | "interrupted" | "native_failed") => void;
  readonly closeInputAdmission: () => void;
  readonly join: () => Promise<void>;
  readonly suspendRequests: () => SuspendedAgentTurnRequests;
  readonly completed: Promise<void>;
}

type ExecutionOptions = Readonly<{
  providerKey: AgentProviderKey;
  executionInputSupport?: AgentExecutionInputSupport;
  executionInputCensus: ReturnType<typeof createExecutionInputCensus>;
  ownsExecution: () => boolean;
  requireInputContext: () => void;
  structuredOutputBound: boolean;
  pendingRequests: Map<string, PendingAgentRequest>;
  sessionAdmission: AgentSessionAdmission;
  inFlightOperations: Set<Promise<void>>;
  requireUsable: () => void;
  isTerminal: () => boolean;
  canRestoreRequest: (pending: PendingAgentRequest) => boolean;
  observe: (output: AgentProviderOutput, requests: AgentTurnRequestAdmission) => AgentProviderOutput;
  assertCompleted: () => void;
  release: () => void;
  retire: () => void;
  abandon: () => Promise<void>;
}>;
export function createValidatedAgentTurnExecution(input: ExecutionOptions & Readonly<{
  turnInput: AgentProviderStartTurnInput;
  start: (input: AgentProviderStartTurnInput) => AgentProviderTurnExecution;
}>): ValidatedAgentTurnExecution {
  return createExecution(input, { kind: "caller", input: input.turnInput, start: input.start });
}
export interface AdoptedAgentTurnExecution extends ValidatedAgentTurnExecution {
  readonly readerReady: Promise<void>;
  readonly admitDispatch: () => void;
  readonly settleNoWork: () => void;
  readonly markStarted: () => void;
}
export function adoptValidatedAgentTurnExecution(input: ExecutionOptions & Readonly<{
  turnId: AgentTurnId; createCandidate: (signal: AbortSignal) => AgentProviderTurnExecution;
}>): AdoptedAgentTurnExecution {
  return createExecution(input, { kind: "native", turnId: input.turnId, createCandidate: input.createCandidate });
}
function createExecution(input: ExecutionOptions, origin:
  | Readonly<{ kind: "caller"; input: AgentProviderStartTurnInput; start: (input: AgentProviderStartTurnInput) => AgentProviderTurnExecution }>
  | Readonly<{ kind: "native"; turnId: AgentTurnId; createCandidate: (signal: AbortSignal) => AgentProviderTurnExecution }>): AdoptedAgentTurnExecution {
  const turnId = origin.kind === "caller" ? origin.input.turnId : origin.turnId;
  const callerSignal = origin.kind === "caller" ? origin.input.signal : undefined;
  const lifetime = new AbortController();
  let inputOwner: ReturnType<typeof createExecutionInputOwner> | undefined;
  const validateCandidate = (candidate: AgentProviderTurnExecution) => {
    if (candidate === null || typeof candidate !== "object" || candidate.turnId !== turnId
      || !hasExactOwnKeys(candidate, ["turnId", "outputs", "resolveRequest", ...(Object.hasOwn(candidate, "input") ? ["input"] : [])])
      || typeof candidate.resolveRequest !== "function"
      || !candidate.outputs || typeof candidate.outputs[Symbol.asyncIterator] !== "function") {
      throwAgentProviderContractError(input.providerKey, origin.kind === "native" ? "invalid_native_continuation" : "invalid_operation_result",
        "Provider returned an invalid turn execution.");
    }
    const port = validateAgentExecutionInputPort(candidate.input, input.executionInputSupport, input.providerKey);
    if (port?.kind === "supported") inputOwner?.attach(port);
    return candidate;
  };
  let state: ExecutionState;
  try {
    state = origin.kind === "native"
      ? { kind: "parked", candidate: validateCandidate(origin.createCandidate(lifetime.signal)) }
      : { kind: "reserved" };
  } catch (cause) {
    lifetime.abort(cause);
    throw cause;
  }
  let ready!: () => void;
  const readerReady = new Promise<void>((resolve) => { ready = resolve; });
  let allowDispatch!: () => void;
  const dispatch = new Promise<void>((resolve) => { allowDispatch = resolve; });
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => { complete = resolve; });

  const currentState = (): ExecutionState => state;
  let dispatched = false;
  let observedOutput = false;
  let resolveDisposition!: (kind: "started" | "not_started") => void;
  const disposition = new Promise<"started" | "not_started">((resolve) => { resolveDisposition = resolve; });
  let source: AsyncIterator<AgentProviderOutput> | undefined;
  let sourceExhausted = false;
  let terminalTail: ReturnType<typeof createAgentTurnTerminalBuffer> | undefined;
  const requests = createAgentTurnRequestAdmission({ providerKey: input.providerKey,
    sessionAdmission: input.sessionAdmission, pendingRequests: input.pendingRequests,
    canRestore: () => state.kind === "entered" && !input.isTerminal(), canRestoreRequest: input.canRestoreRequest });
  let resolvingRequests = 0;
  if (origin.kind === "caller" && input.executionInputSupport?.kind === "supported") {
    inputOwner = createExecutionInputOwner({ providerKey: input.providerKey, turnId,
      support: input.executionInputSupport, census: input.executionInputCensus, signal: lifetime.signal,
      fence: input.retire,
      requireAdmission() {
        input.requireUsable();
        if (state.kind !== "entered" || !input.ownsExecution() || input.isTerminal()) {
          throwAgentProviderContractError(input.providerKey, "active_turn_mismatch",
            "Execution input does not identify the exact active entered execution.");
        }
        if (input.structuredOutputBound) throwAgentProviderContractError(input.providerKey, "structured_output_unsupported",
          "Schema-bound execution cannot admit additional input.");
        input.requireInputContext();
        if (requests.hasUnclaimedRequest() || resolvingRequests > 0) {
          throwAgentProviderContractError(input.providerKey, "request_pending",
            "Execution input cannot enter while a human request or its response remains unsettled.");
        }
      },
    });
  }
  let acquired = false;
  let pulling = false;
  let returnPromise: Promise<IteratorResult<AgentProviderOutput>> | undefined;
  const nativeOperations = new Set<Promise<unknown>>();
  const fail = (code: "concurrent_turn" | "request_resolution_mismatch" | "invalid_operation_result", message: string): never =>
    throwAgentProviderContractError(input.providerKey, code, message);
  const abortError = () => {
    try { throwIfAgentOperationAborted(lifetime.signal); } catch (error) {
      if (error instanceof Error) return error;
    }
    return new DOMException("The turn execution was stopped.", "AbortError");
  };
  const detachAbort = () => callerSignal?.removeEventListener("abort", abort);
  const stop = (reason: Error, inputReason: "closed" | "interrupted" | "native_failed" = "native_failed"): void => {
    if (state.kind === "settled" || state.kind === "stopped") return;
    inputOwner?.closeAdmission(inputReason);
    terminalTail?.clear();
    terminalTail = undefined;
    const entered = dispatched || state.kind === "entered" || state.kind === "entering";
    state = { kind: "stopped", reason };
    requests.withdraw();
    lifetime.abort(reason);
    detachAbort();
    if (entered) input.retire();
    else if (origin.kind === "caller") { input.release(); complete(); }
    allowDispatch(); complete();
  };
  const abort = () => {
    let reason: Error = new DOMException("The turn execution was aborted.", "AbortError");
    try { throwIfAgentOperationAborted(callerSignal); } catch (error) {
      if (error instanceof Error) reason = error;
    }
    stop(reason, "interrupted");
  };
  callerSignal?.addEventListener("abort", abort, { once: true });

  const track = <Value>(operation: Promise<Value>): Promise<Value> => {
    nativeOperations.add(operation);
    void operation.then(() => nativeOperations.delete(operation), () => nativeOperations.delete(operation));
    return operation;
  };
  const pullNative = () => track(Promise.resolve().then(() => state.kind === "entered"
    ? sourceExhausted ? { done: true as const, value: undefined } : state.iterator.next()
    : origin.kind === "native" && state.kind === "settled"
      ? { done: true as const, value: undefined } : Promise.reject(abortError())));
  let joinPromise: Promise<void> | undefined;
  const join = (): Promise<void> => {
    if (joinPromise) return joinPromise;
    const attempt = (async () => {
    while (nativeOperations.size > 0 || input.inFlightOperations.size > 0) {
      await Promise.allSettled([...nativeOperations, ...input.inFlightOperations]);
    }
    if (source?.return) await source.return();
    await inputOwner?.join();
    })();
    joinPromise = attempt;
    void attempt.catch(() => { if (joinPromise === attempt) joinPromise = undefined; });
    return attempt;
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
    if (!pending || pending.turnId !== turnId) {
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
    const attempt = requests.claim(resolution.requestId, pending);
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => { settle = resolve; });
    input.inFlightOperations.add(settlement);
    resolvingRequests += 1;
    try {
      try {
        requestInput.onProviderExecutionStarted?.();
        throwIfAgentOperationAborted(requestInput.signal);
        throwIfAgentOperationAborted(lifetime.signal);
        requireAnswerable();
      } catch (error) { attempt.restore(); throw error; }
      let result: AgentRequestResolutionResult;
      try {
        const signal = requestInput.signal === undefined ? lifetime.signal
          : AbortSignal.any([lifetime.signal, requestInput.signal]);
        result = validateAgentRequestResolutionResult(await candidate.resolveRequest({ resolution, signal }), input.providerKey);
      } catch (error) {
        attempt.retire();
        input.retire();
        throw new AgentProviderDelegatedOperationError(input.providerKey, "resolve_request", error);
      }
      if (result.status === "rejected" && result.requestState === "pending") attempt.restore();
      else attempt.retire();
      if (result.status === "delivery_uncertain") input.retire();
      return result;
    } finally {
      resolvingRequests -= 1;
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
      if (terminalTail) {
        throwIfAgentOperationAborted(lifetime.signal);
        const trailing = terminalTail.take();
        if (trailing !== undefined) return { done: false, value: trailing };
        terminalTail = undefined;
      }
      if (state.kind === "parked") {
        ready();
        await dispatch;
        if (currentState().kind === "settled") return { done: true, value: undefined };
        throwIfAgentOperationAborted(lifetime.signal);
        if (state.kind !== "parked") throw abortError();
        const candidate = state.candidate;
        source = candidate.outputs[Symbol.asyncIterator]();
        state = { kind: "entered", candidate, iterator: source };
      }
      if (state.kind === "reserved") input.requireUsable();
      throwIfAgentOperationAborted(lifetime.signal);
      if (state.kind === "reserved") {
        try { if (origin.kind === "caller") origin.input.onProviderExecutionStarted?.(); } catch (error) {
          state = { kind: "settled" };
          detachAbort();
          input.release(); complete();
          throw error;
        }
        throwIfAgentOperationAborted(lifetime.signal);
        input.requireUsable();
        if (origin.kind !== "caller") throw new Error("Only caller executions enter through startTurn.");
        const { onProviderExecutionStarted: _observer, ...turnInput } = origin.input;
        // The observer has returned successfully; candidate entry is now owned even if it throws.
        state = { kind: "entering" };
        try {
          const candidate = validateCandidate(origin.start({ ...turnInput, signal: lifetime.signal }));
          source = candidate.outputs[Symbol.asyncIterator]();
          throwIfAgentOperationAborted(lifetime.signal);
          state = { kind: "entered", candidate, iterator: source };
        } catch (error) {
          stop(error instanceof Error ? error : new Error("Provider turn entry failed.", { cause: error }));
          throw error;
        }
      }
      if (state.kind !== "entered") throw abortError();
      const nativePull = pullNative();
      const stopped = new Promise<never>((_, reject) => {
        const onAbort = () => reject(abortError());
        lifetime.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => lifetime.signal.removeEventListener("abort", onAbort);
      });
      const result = await Promise.race([nativePull, stopped]);
      throwIfAgentOperationAborted(lifetime.signal);
      if (!result.done) {
        if (origin.kind === "native" && currentState().kind === "settled") throwAgentProviderContractError(input.providerKey, "invalid_native_continuation", "A no-work execution emitted native output.");
        observedOutput = true;
        const output = input.observe(result.value, requests);
        if (inputOwner && output.kind === "event" && output.event.type === "turn.completed") {
          inputOwner.closeAdmission();
          const buffer = createAgentTurnTerminalBuffer(input.providerKey, output);
          const exhaustSource = (async () => {
            for (;;) {
              const trailing = await Promise.race([pullNative(), stopped]);
              throwIfAgentOperationAborted(lifetime.signal);
              if (trailing.done) { sourceExhausted = true; return; }
              buffer.append(input.observe(trailing.value, requests));
            }
          })();
          await Promise.race([inputOwner.drain(exhaustSource), stopped]);
          throwIfAgentOperationAborted(lifetime.signal);
          terminalTail = buffer;
        }
        return { done: false, value: output };
      }
      while (input.inFlightOperations.size > 0) {
        await Promise.race([Promise.all(input.inFlightOperations), stopped]);
      }
      throwIfAgentOperationAborted(lifetime.signal);
      if (origin.kind === "native" && await Promise.race([disposition, stopped]) === "not_started") return { done: true, value: undefined };
      input.assertCompleted();
      requests.withdraw();
      state = { kind: "settled" };
      detachAbort();
      if (!inputOwner?.retainsOwnership) input.release();
      complete();
      return { done: true, value: undefined };
    } catch (error) {
      if (state.kind === "entered" || state.kind === "entering") stop(error instanceof Error ? error : new Error("Provider output failed.", { cause: error }));
      if (error instanceof AgentProviderContractError && error.code === "request_identity_limit_exceeded") {
        void input.abandon().catch(() => {});
      }
      if (inputOwner?.failed) void input.abandon().catch(() => {});
      throw error;
    } finally { removeAbort(); pulling = false; }
  };
  const iterator: AsyncIterator<AgentProviderOutput> = {
    next,
    return() {
      if (returnPromise) return returnPromise;
      if (state.kind === "settled") return Promise.resolve({ done: true, value: undefined });
      const entered = dispatched || state.kind === "entered" || source !== undefined;
      stop(new DOMException("The turn output consumer returned.", "AbortError"), "closed");
      if (entered && origin.kind === "native") {
        // The host callback may await return(). Its own completion is joined by close.
        void input.abandon().catch(() => {});
        returnPromise = Promise.resolve({ done: true, value: undefined });
      } else returnPromise = (entered ? input.abandon() : Promise.resolve()).then(() => ({ done: true, value: undefined }));
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
    execution: Object.freeze({ turnId: turnId, outputs, resolveRequest,
      ...(inputOwner === undefined ? (origin.kind === "native" && input.executionInputSupport?.kind === "supported"
        ? { input: Object.freeze({ kind: "unsupported" as const }) } : {}) : { input: inputOwner.port }) }),
    hasEntered: () => (dispatched && state.kind === "parked") || state.kind === "entering" || state.kind === "entered",
    stop, join, closeInputAdmission: () => inputOwner?.closeAdmission(),
    suspendRequests: requests.suspend, completed, readerReady,
    admitDispatch() {
      if (state.kind !== "parked") throwAgentProviderContractError(input.providerKey, "invalid_native_continuation", "Prepared execution is no longer dispatchable.");
      dispatched = true; allowDispatch();
    },
    markStarted() { resolveDisposition("started"); },
    settleNoWork() {
      if (observedOutput) {
        throwAgentProviderContractError(input.providerKey, "invalid_native_continuation", "No-work outcome conflicts with entered output.");
      }
      state = { kind: "settled" }; resolveDisposition("not_started"); detachAbort(); allowDispatch(); complete();
    },
  };
}
