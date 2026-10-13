// ------------------------------------------------------------------------------------------------
//                execution.ts - Provider intent and request transitions
// ------------------------------------------------------------------------------------------------

import { failDelegation } from "../shared/operational-errors.js";
import { delegationDataBytes } from "../shared/identity.js";
import { DELEGATION_CRITICAL_SLOT_BYTES } from "../shared/limits.js";
import type { DelegationOperationDisposition, DelegationOperationKind, DelegationStoreCommand } from "../store/types.js";
import { addOperation, criticalKinds, requireRun, same, setRun, type CommitContext } from "./context.js";

const receiptDispositions: Readonly<Record<DelegationOperationKind, readonly DelegationOperationDisposition[]>> = {
  admit: [], cancel: [],
  prepare: ["completed", "rejected", "uncertain"],
  configure: ["completed", "rejected", "uncertain"],
  turn: ["delegated", "rejected", "uncertain"],
  steer: ["delivered", "rejected", "uncertain"],
  request_resolution: ["delivered", "rejected", "uncertain"],
  interrupt: ["interruption_requested", "completed", "rejected", "uncertain"],
  session_close: ["completed", "rejected", "uncertain"],
  binding_cleanup: ["completed", "rejected", "uncertain"],
};

export function dispatchIntent(context: CommitContext, command: Extract<DelegationStoreCommand, { kind: "dispatch_intent" }>): void {
  const run = requireRun(context);
  const kind = command.operationKind;
  if (run.ownerEpoch !== command.owner.epoch && kind !== "prepare") {
    failDelegation("recovery_required", "A new executor cannot replay any old provider or cleanup intent.");
  }
  const prior = context.current.criticalOperations.find((operation) => operation.kind === kind);
  if (prior) {
    if ((kind !== "session_close" && kind !== "binding_cleanup") || command.attempt !== 2 || prior.attempts !== 1
      || !["rejected", "uncertain"].includes(prior.disposition)
      || prior.operationId !== command.operationId || prior.inputDigest !== command.inputDigest) {
      failDelegation("operation_conflict", "The reserved control slot is already assigned.");
    }
    context.mutations.push({ kind: "operation", value: { ...prior, attempts: 2, disposition: "intent", at: command.at,
      ownerEpoch: command.owner.epoch, receipt: context.receipt } });
    return;
  }
  if ((command.attempt ?? 1) !== 1) failDelegation("stale_revision", "A cleanup retry requires its retained first attempt.");
  if (kind === "binding_cleanup" && !context.current.criticalOperations.some((operation) => operation.kind === "session_close")) {
    failDelegation("stale_revision", "Combined cleanup must journal session close before binding cleanup.");
  }
  if (!criticalKinds.has(kind) && (context.task.state === "retired" || context.task.state === "recovery_required" || run.cancelRequested)) {
    failDelegation("recovery_required", "This run no longer admits provider execution inputs.");
  }
  if (kind === "prepare") {
    if (run.phase !== "queued" || run.dispatch !== "none") failDelegation("stale_revision", "Only an undispatched queued run can prepare.");
    if (context.current.runs.some((other) => other.runId !== run.runId && ["preparing", "running", "waiting"].includes(other.phase))
      || context.capacity.activeRuns >= context.current.limits.maxActiveRuns) failDelegation("capacity_exceeded", "No active executor slot is available.");
    setRun(context, { phase: "preparing", preparation: "intended", ownerEpoch: command.owner.epoch });
  } else if (kind === "turn") {
    if (run.phase !== "preparing" || run.preparation !== "completed" || run.dispatch !== "none" || !command.appliedTarget || !same(command.appliedTarget, run.admittedTarget)) {
      failDelegation("stale_target", "A first turn requires preparation and the exact applied target.");
    }
    setRun(context, { phase: "running", dispatch: "intended", appliedTarget: command.appliedTarget });
  } else if (kind === "configure" && run.phase !== "preparing") {
    failDelegation("stale_revision", "Configuration belongs to session preparation.");
  } else if (kind === "steer" && run.phase !== "running") {
    failDelegation("stale_revision", "Steering requires the active running turn.");
  } else if (kind === "request_resolution") {
    failDelegation("request_unavailable", "Request continuation must commit its exact historical request intent.");
  } else if (kind === "interrupt" && (run.phase === "queued" || run.phase === "settled" || !run.cancelRequested)) {
    failDelegation("stale_revision", "Interruption requires a live canceled run.");
  }
  addOperation(context, kind, command.at);
  context.receipt = { ...context.receipt, status: requireRun(context).phase };
}

export function operationReceipt(context: CommitContext, command: Extract<DelegationStoreCommand, { kind: "operation_receipt" }>): void {
  const prior = context.current.operation;
  if (!prior || prior.runId !== command.runId || prior.inputDigest !== command.inputDigest) {
    failDelegation("operation_conflict", "The exact provider intent is unavailable.");
  }
  if (!receiptDispositions[prior.kind].includes(command.disposition)) {
    failDelegation("operation_conflict", "The receipt disposition is invalid for this operation kind.");
  }
  const rejectedRequest = prior.kind === "request_resolution" && command.disposition === "rejected";
  if (rejectedRequest !== (command.requestState !== undefined)) {
    failDelegation("operation_conflict", "Only a rejected request receipt requires authoritative request eligibility.");
  }
  if (["delivered", "rejected", "completed"].includes(prior.disposition)
    || (prior.kind === "request_resolution" && prior.disposition === "uncertain")) {
    failDelegation("operation_conflict", "A final operation disposition is immutable.");
  }
  if (prior.ownerEpoch !== command.owner.epoch) failDelegation("recovery_required", "A new owner cannot invent a prior executor receipt.");
  if (prior.kind === "binding_cleanup" && command.disposition === "completed"
    && !context.current.criticalOperations.some((operation) => operation.kind === "session_close" && operation.disposition === "completed")) {
    failDelegation("stale_revision", "Binding cleanup cannot complete before confirmed session close.");
  }
  const operation = { ...prior, disposition: command.disposition, at: command.at,
    ...(command.requestState ? { requestState: command.requestState } : {}),
    ...(command.message ? { message: command.message } : {}), receipt: { ...context.receipt, operationId: command.operationId } };
  if (delegationDataBytes(operation) > DELEGATION_CRITICAL_SLOT_BYTES) failDelegation("capacity_exceeded", "Operation receipt exceeds its fixed slot.");
  context.mutations.push({ kind: "operation", value: operation });
  if (prior.kind === "request_resolution") {
    const run = requireRun(context);
    if (!prior.request) failDelegation("operation_conflict", "Request delivery requires its exact retained request identity.");
    if (run.pendingRequest?.requestId === prior.request.requestId && run.pendingRequest.requestKind === prior.request.requestKind) {
      if (run.pendingRequest.state !== "resolution_intended") failDelegation("request_unavailable", "The exact request has no entered resolution intent.");
      const state = command.disposition === "delivered" ? "resolved" : command.requestState === "pending" ? "waiting" : "unavailable";
      setRun(context, { phase: run.phase === "settled" ? "settled" : state === "waiting" ? "waiting" : "running",
        pendingRequest: { ...run.pendingRequest, state } });
    }
    context.receipt = { ...context.receipt, status: requireRun(context).phase };
  }
  if (prior.kind === "turn" && command.disposition === "delegated") setRun(context, { dispatch: "delegated" });
  if (prior.kind === "prepare") {
    if (command.disposition === "completed") setRun(context, { preparation: "completed" });
    if (command.disposition === "uncertain") setRun(context, { preparation: "uncertain" });
    if (command.disposition === "rejected") setRun(context, { preparation: "none" });
  }
  if (command.disposition === "uncertain" && prior.kind === "steer") setRun(context, { recoveryReason: "steering_uncertain" });
  if (command.disposition === "uncertain" && (prior.kind === "configure" || prior.kind === "request_resolution")) {
    setRun(context, { recoveryReason: prior.kind === "request_resolution" ? "request_executor_lost" : "dispatch_uncertain" });
  }
}

export function requestState(context: CommitContext, command: Extract<DelegationStoreCommand, { kind: "request_state" }>): void {
  const run = requireRun(context);
  if (command.state === "opened") {
    if (run.phase !== "running" || command.request.state !== "waiting" || run.ownerEpoch !== command.owner.epoch) {
      failDelegation("request_unavailable", "Only the current active executor stream can open a waiting request.");
    }
    setRun(context, { phase: "waiting", pendingRequest: command.request });
  } else {
    if (!run.pendingRequest || run.pendingRequest.requestId !== command.request.requestId
      || run.pendingRequest.requestKind !== command.request.requestKind) failDelegation("request_unavailable", "The exact historical request is unavailable.");
    if (command.state === "resolution_intended") {
      if (run.phase !== "waiting" || run.pendingRequest.state !== "waiting" || run.ownerEpoch !== command.owner.epoch || run.cancelRequested
        || (run.pendingRequest.expiresAt && Date.parse(run.pendingRequest.expiresAt) <= Date.parse(command.at))) {
        failDelegation("request_unavailable", "This request cannot accept a continuation intent.");
      }
      addOperation(context, "request_resolution", command.at, 1,
        { requestId: run.pendingRequest.requestId, requestKind: run.pendingRequest.requestKind });
      setRun(context, { phase: "running", pendingRequest: { ...run.pendingRequest, state: "resolution_intended" } });
    } else {
      if (command.state === "resolved" && run.pendingRequest.state !== "resolution_intended") failDelegation("request_unavailable", "Resolution requires its prior intent.");
      setRun(context, { pendingRequest: { ...run.pendingRequest, state: command.state } });
    }
  }
  context.receipt = { ...context.receipt, status: requireRun(context).phase };
}
