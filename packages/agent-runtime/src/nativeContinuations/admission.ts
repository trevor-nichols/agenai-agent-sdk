// ------------------------------------------------------------------------------------------------
//                admission.ts - Exact prepared response entry and retained execution ownership
// ------------------------------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import { parseAgentTurnId, type AgentSessionResponse } from "@agen-ai/agent-protocol";
import { AgentProviderContractError, AgentProviderSessionCleanupError } from "../contractErrors.js";
import type { AgentRequestResolutionResult } from "../sessions.js";
import type { SessionInteractionOwner } from "../sessionInteractions/lifetime.js";
import type { AgentProviderPreparedSessionInteraction } from "../sessionInteractions/types.js";
import { interactionRecord } from "../sessionInteractions/validation.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";
import { validateAgentRequestResolutionResult } from "../turnExecution/receipts.js";
import type { AdoptedAgentTurnExecution } from "../turnExecution/execution.js";
import type { AgentNativeContinuationOutcome, AgentPreparedSessionResponse, AgentSessionResponseAttemptId } from "./types.js";

export function mintSessionResponseAttemptId(): AgentSessionResponseAttemptId {
  // This is private process-local authority, minted only after response admission.
  return randomUUID() as AgentSessionResponseAttemptId;
}
function continuationError(owner: SessionInteractionOwner, code: "native_continuation_preparation_failed" | "native_continuation_reader_not_ready" | "invalid_native_continuation", message: string, cause?: unknown) {
  return new AgentProviderContractError(owner.providerKey, code, message, ...(cause === undefined ? [] : [{ cause }]));
}
function until<Value>(work: Promise<Value>, deadline: number, failure: () => unknown, signal?: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure()), Math.max(0, deadline - Date.now()));
    const aborted = () => reject(signal?.reason ?? new DOMException("Prepared response was aborted.", "AbortError"));
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    void work.then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); });
  });
}
function capturePrepared(input: unknown): AgentPreparedSessionResponse {
  const value = interactionRecord(input);
  if (typeof value.dispatch !== "function" || typeof value.cancel !== "function") throw new TypeError("Prepared response requires dispatch and cancellation ports.");
  if (value.kind === "no_continuation" && hasExactOwnKeys(value, ["kind", "dispatch", "cancel"])) {
    return Object.freeze({ kind: "no_continuation", dispatch: value.dispatch.bind(input), cancel: value.cancel.bind(input) });
  }
  if (value.kind === "native_continuation" && hasExactOwnKeys(value, ["kind", "dispatch", "cancel", "createExecution", "outcome"])
    && typeof value.createExecution === "function" && value.outcome && typeof interactionRecord(value.outcome).then === "function") {
    return Object.freeze({ kind: "native_continuation", dispatch: value.dispatch.bind(input), cancel: value.cancel.bind(input),
      createExecution: value.createExecution.bind(input), outcome: Promise.resolve(value.outcome) }) as AgentPreparedSessionResponse;
  }
  throw new TypeError("Invalid prepared response.");
}
function outcome(input: unknown): AgentNativeContinuationOutcome {
  const value = interactionRecord(input);
  if (!hasExactOwnKeys(value, ["kind"]) || (value.kind !== "started" && value.kind !== "not_started")) throw new TypeError("Invalid continuation outcome.");
  return Object.freeze({ kind: value.kind });
}

export async function dispatchPreparedSessionResponse(input: Readonly<{
  owner: SessionInteractionOwner; candidate: AgentProviderPreparedSessionInteraction; response: AgentSessionResponse;
  attemptId: AgentSessionResponseAttemptId; signal: AbortSignal; requireCurrent: () => void;
  onDispatch: (deadline: number) => void;
  observeActualReceipt: (work: Promise<AgentRequestResolutionResult>) => void;
}>): Promise<AgentRequestResolutionResult> {
  const { owner } = input;
  const readinessDeadline = Date.now() + 30_000;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal, owner.openingSignal]);
  let prepared: AgentPreparedSessionResponse | undefined;
  let execution: AdoptedAgentTurnExecution | undefined;
  let reservation: object | undefined;
  let entered = false;
  let callback: Promise<void> | undefined;
  let callbackFailure: { readonly cause: unknown } | undefined;
  let cancelAttempt: Promise<void> | undefined;
  let canceled = false;
  let actualOutcome: Promise<AgentNativeContinuationOutcome> | undefined;
  let earlyOutcome: AgentNativeContinuationOutcome | undefined;
  let outcomeFailure: unknown;
  let resolveOutcome!: (outcome: AgentNativeContinuationOutcome) => void;
  let rejectOutcome!: (cause: unknown) => void;
  const publicOutcome = new Promise<AgentNativeContinuationOutcome>((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
  void publicOutcome.catch(() => {});
  const actualPreparation = owner.track(Promise.resolve().then(() => { input.requireCurrent(); owner.requireUsable(); return input.candidate.prepareResponse({
    response: input.response, responseAttemptId: input.attemptId, signal,
  }); }).then((value) => {
    try { return capturePrepared(value); }
    catch (cause) { throw continuationError(owner, "invalid_native_continuation", "Provider returned an invalid prepared response.", cause); }
  }).then((value) => {
    prepared = value;
    if (value.kind === "native_continuation") {
      actualOutcome = owner.track(value.outcome.then((value) => {
        const parsed = outcome(value);
        if (!entered) {
          earlyOutcome = parsed;
          if (parsed.kind === "started") throw continuationError(owner, "invalid_native_continuation", "Provider started native work before dispatch.");
        }
        return parsed;
      }).catch((cause) => {
        throw cause instanceof AgentProviderContractError && cause.code === "invalid_native_continuation" ? cause
          : continuationError(owner, "invalid_native_continuation", "Provider native continuation outcome is invalid.", cause);
      }));
      void actualOutcome.catch((cause) => { outcomeFailure = cause; if (entered) owner.fail(cause); });
    }
    return value;
  }));
  void actualPreparation.catch(() => {});
  const cancel = (): Promise<void> => {
    if (canceled) return Promise.resolve();
    if (cancelAttempt) return cancelAttempt;
    controller.abort(new DOMException("Prepared response admission was canceled.", "AbortError"));
    cancelAttempt = (async () => {
      let value: AgentPreparedSessionResponse;
      try { value = prepared ?? await actualPreparation; }
      catch (cause) {
        cleanup();
        owner.fail(cause);
        throw continuationError(owner, "native_continuation_preparation_failed", "Preparation failed without returning its allocated cancellation owner.", cause);
      }
      execution?.stop(new DOMException("Prepared execution admission was canceled.", "AbortError"));
      await value.cancel();
      execution?.settleNoWork();
      await execution?.join();
      if (value.kind === "native_continuation") {
        const result = await actualOutcome;
        if (result?.kind !== "not_started") throw continuationError(owner, "invalid_native_continuation", "Canceled preparation did not prove no native work.");
      }
      resolveOutcome(Object.freeze({ kind: "not_started" }));
      await callback?.catch(() => {});
      if (reservation) owner.validationOwner.releaseExecution(reservation);
      canceled = true;
    })().finally(() => { cancelAttempt = undefined; });
    void cancelAttempt.catch(() => {});
    return cancelAttempt;
  };
  const cleanup = owner.retainPreparation(async () => { if (!entered) await cancel(); });
  try {
    const value = await until(actualPreparation, readinessDeadline, () => continuationError(owner, "native_continuation_preparation_failed", "Native continuation preparation did not finish before its deadline."), signal);
    input.requireCurrent(); owner.requireUsable();
    if (outcomeFailure) throw outcomeFailure;
    if (earlyOutcome) throw continuationError(owner, "invalid_native_continuation", "Prepared outcome forbids native response dispatch.");
    if (value.kind === "native_continuation") {
      owner.validationOwner.requireNativeContinuationSupport();
      owner.requireContinuation(input.candidate.request.kind);
      reservation = owner.validationOwner.reserveExecution();
      const turnId = parseAgentTurnId(`native-${randomUUID()}`);
      execution = owner.validationOwner.installNativeExecution(reservation, turnId, (executionSignal) => value.createExecution({ turnId, signal: executionSignal }));
      const offered = execution;
      try { callback = Promise.resolve(owner.continuations!.onExecution(Object.freeze({
        sessionId: owner.sessionId, requestId: input.candidate.request.requestId,
        responseAttemptId: input.attemptId, execution: offered.execution, outcome: publicOutcome,
      }))); } catch (cause) { callbackFailure = { cause }; callback = Promise.reject(cause); }
      owner.track(callback);
      const rejection = new Promise<never>((_, reject) => { void callback!.catch(reject); });
      void callback.catch((cause) => { callbackFailure = { cause }; if (entered) owner.fail(cause); });
      await until(Promise.race([offered.readerReady, rejection]), readinessDeadline,
        () => continuationError(owner, "native_continuation_reader_not_ready", "Native continuation requires an outstanding output pull."), signal);
    }
    // No yield between the final authority checks and the only answer-entry boundary.
    input.requireCurrent(); owner.requireUsable();
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= readinessDeadline) throw continuationError(owner, "native_continuation_reader_not_ready", "Native continuation reader admission expired.");
    if (callbackFailure) throw continuationError(owner, "native_continuation_reader_not_ready", "Native continuation host rejected output ownership before dispatch.", callbackFailure.cause);
    if (outcomeFailure || earlyOutcome) throw outcomeFailure ?? continuationError(owner, "invalid_native_continuation", "Prepared outcome arrived before dispatch.");
    if (reservation && !owner.validationOwner.ownsExecution(reservation)) throw continuationError(owner, "invalid_native_continuation", "Native continuation lost its execution reservation.");
    try { execution?.admitDispatch(); }
    catch (cause) { throw continuationError(owner, "native_continuation_reader_not_ready", "Native continuation output ownership ended before dispatch.", cause); }
    const responseDeadline = Date.now() + owner.limits.responseTimeoutMs;
    entered = true;
    input.onDispatch(responseDeadline);
    let actualReceipt: Promise<AgentRequestResolutionResult>;
    try { actualReceipt = Promise.resolve(value.dispatch()).then((result) => validateAgentRequestResolutionResult(result, owner.providerKey)); }
    catch (cause) { actualReceipt = Promise.reject(cause); }
    owner.track(actualReceipt);
    input.observeActualReceipt(actualReceipt);
    if (actualOutcome && execution) {
      const currentExecution = execution;
      const exactReservation = reservation!;
      const observedOutcome = until(actualOutcome, responseDeadline, () => continuationError(owner, "invalid_native_continuation", "Native continuation outcome did not settle before its response deadline."));
      owner.track(observedOutcome.then(async (result) => {
        resolveOutcome(result);
        if (result.kind === "not_started") currentExecution.settleNoWork();
        else currentExecution.markStarted();
        await currentExecution.completed;
        await actualReceipt.catch(() => {});
        await callback?.catch(() => {});
        await currentExecution.join();
        owner.validationOwner.releaseExecution(exactReservation);
      }).catch((cause) => { rejectOutcome(cause); owner.fail(cause); }));
    }
    // Receipt observation is independent: outcome failure cannot rewrite delivered truth.
    return await until(actualReceipt, responseDeadline, () => new Error("Session response delivery observation expired."));
  } catch (cause) {
    if (entered) throw cause;
    let failure = cause;
    if (!(cause instanceof AgentProviderContractError) && !(cause instanceof DOMException && cause.name === "AbortError")) {
      failure = continuationError(owner, prepared ? "native_continuation_reader_not_ready" : "native_continuation_preparation_failed", "Native continuation failed before response entry.", cause);
    }
    try { await until(cancel(), Date.now() + owner.limits.cleanupTimeoutMs, () => new Error("Prepared cancellation did not finish before its deadline.")); }
    catch (cleanupFailure) {
      owner.fail(failure);
      throw new AgentProviderSessionCleanupError({ providerKey: owner.providerKey, errors: [failure, cleanupFailure], retryCleanup: async () => { if (prepared) await cancel(); else await owner.cleanupFailedPreparation(); } });
    }
    if (failure instanceof AgentProviderContractError && failure.code === "invalid_native_continuation") owner.fail(failure);
    throw failure;
  } finally {
    // Entered preparations remain covered by native session quiescence and the tracked work above.
    if (entered || canceled) cleanup();
  }
}
