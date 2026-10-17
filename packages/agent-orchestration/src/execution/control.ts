// ------------------------------------------------------------------------------------------------
//                control.ts - Journaled delivery, exact live requests and interruption
// ------------------------------------------------------------------------------------------------

import { AgentProviderDelegatedOperationError } from "@agen-ai/agent-runtime";
import { parseAgentRequestResolutionFor } from "@agen-ai/agent-protocol";
import type { DelegationRequestReceipt, DelegationResolveHostRequestInput, DelegationSendReceipt, DelegationSendTaskInput } from "../coordinator/types.js";
import { parseOperationId, parseRequestResolution } from "../coordinator/parse.js";
import { delegationInputDigest } from "../shared/identity.js";
import { failDelegation } from "../shared/operational-errors.js";
import { assertRunDispatch, sameTarget } from "./authority.js";
import { finishRun } from "./finish.js";
import { dispatchIntent, operationIdentity, operationReceipt } from "./journal.js";
import { now, type CoordinatorState, type LiveRun } from "./state.js";
import { markRequest } from "./stream.js";

function serializeControl<Value>(live: LiveRun, invoke: () => Promise<Value>): Promise<Value> {
  const control = live.controlTail.then(invoke, invoke);
  live.controlTail = control.then(() => undefined, () => undefined);
  return control;
}

async function boundedControl<Value>(state: CoordinatorState, live: LiveRun, invoke: (signal: AbortSignal) => PromiseLike<Value> | Value,
  cancellable = true): Promise<Value> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = cancellable ? AbortSignal.any([controller.signal, live.controlAbort.signal]) : controller.signal;
  const work = state.track(Promise.resolve().then(() => invoke(signal)), live);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { const error = new DOMException("The managed control deadline expired.", "AbortError"); controller.abort(error); reject(error); }, state.options.limits.controlTimeoutMs);
  });
  try { return await Promise.race([work, timeout]); } finally { if (timer) clearTimeout(timer); }
}

export function cancelLive(state: CoordinatorState, live: LiveRun, reason: string): Promise<unknown> {
  if (live.cancellation) return live.cancellation;
  live.controlAbort.abort(new DOMException("The managed run's controls were canceled.", "AbortError"));
  live.cancellation = serializeControl(live, async () => {
    const run = await state.run(live.taskId, live.runId);
    if (run.phase === "settled") return;
    if (!run.cancelRequested) {
      const identity = operationIdentity(live, "cancel");
      await state.mutate(live.taskId, live.runId, identity.operationId, identity.inputDigest,
        (fence) => ({ ...fence, kind: "cancel", at: now(), reason }));
    }
    if (!live.session || run.phase === "preparing") {
      live.lifetime.abort(new DOMException("Managed execution was canceled during preparation.", "AbortError"));
      return;
    }
    const identity = operationIdentity(live, "interrupt");
    await dispatchIntent(state, live, "interrupt", identity);
    if (live.session.interruption.kind !== "supported") {
      live.uncertain = "cancellation_uncertain";
      await operationReceipt(state, live, "uncertain", identity);
      live.lifetime.abort();
    } else {
      const interruption = live.session.interruption;
      try {
        const result = await boundedControl(state, live, (signal) => interruption.interruptTurn({ turnId: live.turnId,
          reason: reason === "timeout" ? "timeout" : reason === "shutdown" ? "shutdown" : "user_requested", requestedAt: now(), signal }), false);
        await operationReceipt(state, live, ["accepted", "completed"].includes(result.status) ? "interruption_requested" : "uncertain", identity);
        if (!["accepted", "completed"].includes(result.status)) live.uncertain = "cancellation_uncertain";
      } catch {
        live.uncertain = "cancellation_uncertain";
        await operationReceipt(state, live, "uncertain", identity);
      }
    }
    if (!live.stream) {
      if (!live.terminal) {
        live.uncertain = "cancellation_uncertain";
        void finishRun(state, live, { kind: "recovery_required", reason: "cancellation_uncertain" }).catch(() => undefined);
      }
    } else if (!live.finishing) {
      if (live.deadline) clearTimeout(live.deadline);
      live.deadline = setTimeout(() => {
        live.uncertain = "cancellation_uncertain";
        live.lifetime.abort(new DOMException("Interruption did not settle the managed output producer.", "AbortError"));
      }, state.options.limits.controlTimeoutMs);
    }
  });
  return state.track(live.cancellation, live);
}

async function deliverSteering(state: CoordinatorState, live: LiveRun, input: DelegationSendTaskInput, digest: string, originPolicyRevision: number): Promise<DelegationSendReceipt> {
  const run = await state.run(live.taskId, live.runId);
  const { task } = await state.task(live.taskId);
  if (live.uncertain) failDelegation("recovery_required", "An earlier control operation has an uncertain outcome.");
  if (live.cancellation || run.cancelRequested) failDelegation("unsupported_operation", "The managed turn no longer accepts steering after cancellation.");
  if (!live.session || live.session.steering.kind !== "supported" || run.phase !== "running" || !live.stream || live.finishing) {
    failDelegation("unsupported_operation", "This managed child does not have a steerable active turn.");
  }
  if (!run.appliedTarget || !sameTarget(run.appliedTarget, input.target)) failDelegation("stale_target", "Steering must preserve the exact applied target.");
  const identity = { operationId: input.operationId, inputDigest: digest };
  await dispatchIntent(state, live, "steer", identity);
  const steering = live.session.steering;
  let status: "delivered" | "rejected" | "delivery_uncertain";
  try {
    const result = await boundedControl(state, live, (signal) => {
      if (live.uncertain || live.cancellation) failDelegation("recovery_required", "The managed turn no longer accepts new execution input.");
      state.options.host.assertControl({ scope: live.scope, task });
      assertRunDispatch(state, live, input.expectedPolicyRevision, originPolicyRevision);
      return steering.steerTurn({ turnId: live.turnId, ...input.input, signal });
    });
    status = result.status;
  } catch (error) { status = error instanceof AgentProviderDelegatedOperationError || (error instanceof DOMException && error.name === "AbortError") ? "delivery_uncertain" : "rejected"; }
  if (status === "delivery_uncertain") live.uncertain = "steering_uncertain";
  await operationReceipt(state, live, status === "delivery_uncertain" ? "uncertain" : status, identity);
  return { status, taskId: live.taskId, runId: live.runId, operationId: input.operationId, duplicate: false };
}

export function steerRun(state: CoordinatorState, live: LiveRun, input: DelegationSendTaskInput, digest: string, originPolicyRevision: number): Promise<DelegationSendReceipt> {
  const prior = live.pendingOperations.get(input.operationId);
  if (prior) {
    if (prior.digest !== digest) failDelegation("operation_conflict", "The operation identity has different in-flight input.");
    return (prior.promise as Promise<DelegationSendReceipt>).then((receipt) => ({ ...receipt, duplicate: true }));
  }
  const work = state.track(serializeControl(live, () => deliverSteering(state, live, input, digest, originPolicyRevision)), live);
  live.pendingOperations.set(input.operationId, { digest, promise: work });
  void work.finally(() => live.pendingOperations.delete(input.operationId)).catch(() => undefined);
  return work;
}

function requestReceipt(live: LiveRun, operationId: string, disposition: string,
  requestState?: "pending" | "unavailable", duplicate = false): DelegationRequestReceipt {
  const identity = { taskId: live.taskId, runId: live.runId, operationId, duplicate };
  if (disposition === "delivered") return { ...identity, status: "delivered" };
  if (disposition === "rejected" && requestState) return { ...identity, status: "rejected", requestState };
  return { ...identity, status: "delivery_uncertain" };
}

async function continueRequest(state: CoordinatorState, input: DelegationResolveHostRequestInput): Promise<DelegationRequestReceipt> {
  const operationId = parseOperationId(input.operationId);
  const resolution = parseRequestResolution(input.resolution);
  const pending = state.requests.get(input.handle);
  if (!pending) failDelegation("request_unavailable", "The live host request handle is unavailable.");
  const { live, request } = pending;
  parseAgentRequestResolutionFor(request, resolution);
  const identity = { operationId, inputDigest: delegationInputDigest({ kind: "request_resolution", taskId: live.taskId, runId: live.runId, requestId: request.requestId, resolution }) };
  const admission = await serializeControl(live, async () => {
    const [{ task }, run] = await Promise.all([state.task(live.taskId), state.run(live.taskId, live.runId)]);
    state.options.host.assertResultAccess({ scope: live.scope, task });
    state.options.host.assertRequestAccess({ handle: input.handle, task, run, request });
    live.execution?.assertCurrent();
    const existing = await state.options.store.read({ kind: "operation", parent: live.scope, operationId });
    if (existing.kind === "operation" && existing.operation) {
      if (existing.operation.kind !== "request_resolution" || existing.operation.inputDigest !== identity.inputDigest
        || existing.operation.taskId !== live.taskId || existing.operation.runId !== live.runId) {
        failDelegation("operation_conflict", "The operation identity already has different input or ownership.");
      }
      return { kind: "receipt" as const, receipt: requestReceipt(live, operationId, existing.operation.disposition, existing.operation.requestState, true) };
    }
    if (live.request !== pending || pending.eligibility !== "waiting" || !live.stream || live.finishing || !live.turn || live.uncertain || live.cancellation
      || run.phase !== "waiting" || live.execution?.signal.aborted || live.lifetime.signal.aborted) {
      failDelegation("request_unavailable", "The exact waiting request no longer has a live executor.");
    }
    const history = pending.history;
    pending.eligibility = "claimed";
    try { await markRequest(state, live, "resolution_intended", { ...history, state: "resolution_intended" }, identity); }
    catch (error) {
      if (!pending.signal.aborted && live.request === pending) pending.eligibility = "waiting";
      throw error;
    }
    live.requestAttempts.set(operationId, pending);
    const turn = live.turn;
    return { kind: "dispatch" as const, invoke: async (): Promise<DelegationRequestReceipt> => {
      let disposition: "delivered" | "rejected" | "uncertain";
      let requestState: "pending" | "unavailable" | undefined;
      let localFailure: Readonly<{ error: unknown }> | undefined;
      let entered = false;
      try {
        const result = await boundedControl(state, live, (signal) => turn.resolveRequest({ resolution,
          signal: AbortSignal.any([signal, live.lifetime.signal]), onProviderExecutionStarted() {
            state.options.host.assertRequestAccess({ handle: input.handle, task, run, request });
            live.execution?.assertCurrent();
            entered = true;
          } }));
        disposition = result.status === "delivery_uncertain" ? "uncertain" : result.status;
        if (result.status === "rejected") requestState = result.requestState;
      } catch (error) {
        if (error instanceof AgentProviderDelegatedOperationError || (entered && error instanceof DOMException && error.name === "AbortError")) {
          disposition = "uncertain";
        } else {
          disposition = "rejected";
          requestState = live.lifetime.signal.aborted || live.cancellation ? "unavailable" : "pending";
          localFailure = { error };
        }
      }
      if (disposition === "uncertain") live.uncertain = "request_executor_lost";
      try {
        await state.mutate(live.taskId, live.runId, operationId, identity.inputDigest,
          (fence) => ({ ...fence, kind: "operation_receipt", disposition, at: now(), ...(requestState ? { requestState } : {}) }));
      } catch (error) {
        live.uncertain = "storage_failed";
        void finishRun(state, live, { kind: "recovery_required", reason: "storage_failed" }).catch(() => undefined);
        throw error;
      }
      if (pending.eligibility !== "retired") {
        pending.eligibility = requestState === "pending" && live.request === pending && !live.lifetime.signal.aborted && !live.cancellation ? "waiting" : "retired";
      }
      if (live.uncertain) void finishRun(state, live, { kind: "recovery_required", reason: live.uncertain }).catch(() => undefined);
      if (localFailure) throw localFailure.error;
      return requestReceipt(live, operationId, disposition, requestState);
    } };
  });
  return admission.kind === "receipt" ? admission.receipt : admission.invoke();
}

export function resolveLiveRequest(state: CoordinatorState, input: DelegationResolveHostRequestInput): Promise<DelegationRequestReceipt> {
  const pending = state.requests.get(input.handle);
  if (!pending) return state.track(continueRequest(state, input));
  const operationId = parseOperationId(input.operationId);
  const resolution = parseRequestResolution(input.resolution);
  parseAgentRequestResolutionFor(pending.request, resolution);
  const digest = delegationInputDigest({ kind: "request_resolution", taskId: pending.live.taskId, runId: pending.live.runId, requestId: pending.request.requestId, resolution });
  const prior = pending.live.pendingOperations.get(operationId);
  if (prior && prior.digest !== digest) failDelegation("operation_conflict", "The operation identity has different in-flight input.");
  if (prior) return state.track(prior.promise.then((receipt) => ({ ...receipt as DelegationRequestReceipt, duplicate: true })), pending.live);
  const work = state.track(continueRequest(state, input), pending.live);
  pending.live.pendingOperations.set(operationId, { digest, promise: work });
  pending.resolution ??= work;
  void work.finally(() => {
    pending.live.pendingOperations.delete(operationId);
    pending.live.requestAttempts.delete(operationId);
    if (pending.resolution === work) pending.resolution = undefined;
  }).catch(() => undefined);
  return work;
}
