// ------------------------------------------------------------------------------------------------
//                lifecycle.ts - Observation, settlement and notification transitions
// ------------------------------------------------------------------------------------------------

import { failDelegation } from "../shared/operational-errors.js";
import { delegationDataBytes, delegationInputDigest } from "../shared/identity.js";
import type { DelegationStoreCommand } from "../store/types.js";
import { addOperation, requireRun, setRun, settleRun, type CommitContext } from "./context.js";

export function observeRun(context: CommitContext, command: Extract<DelegationStoreCommand, { kind: "observe" }>): void {
  const run = requireRun(context);
  const observation = command.observation;
  if (run.phase === "queued" || run.phase === "settled" || run.ownerEpoch !== command.owner.epoch || observation.storeId !== context.current.storeId
    || observation.taskId !== run.taskId || observation.runId !== run.runId || observation.index !== run.observationIndex + 1
    || observation.kind === "omitted") failDelegation("stale_revision", "Observation does not follow the live run's canonical index.");
  const bytes = delegationDataBytes(observation);
  const limits = context.current.limits;
  const digest = delegationInputDigest(observation);
  if (bytes > limits.maxObservationBytes || run.observationCount >= limits.maxRunObservations
    || run.observationBytes + bytes > limits.maxRunObservationBytes
    || context.capacity.observationBytes + bytes > limits.maxRetainedObservationBytes) {
    const omitted = run.omittedObservations + 1;
    const marker = context.current.omissionObservation;
    context.mutations.push({ kind: "observation", value: marker
      ? { ...marker, omitted } : { storeId: context.current.storeId, taskId: run.taskId, runId: run.runId,
        index: observation.index, at: observation.at, kind: "omitted", omitted } });
    setRun(context, { observationIndex: observation.index, omittedObservations: omitted, lastObservationDigest: digest });
    context.receipt = { ...context.receipt, status: "omitted" };
  } else {
    context.mutations.push({ kind: "observation", value: observation });
    setRun(context, { observationIndex: observation.index, observationCount: run.observationCount + 1,
      observationBytes: run.observationBytes + bytes, lastObservationDigest: digest });
    context.capacity = { ...context.capacity, observationBytes: context.capacity.observationBytes + bytes };
  }
}

export function cancelRun(context: CommitContext, command: Extract<DelegationStoreCommand, { kind: "cancel" }>): void {
  const run = requireRun(context);
  if (run.phase === "settled") {
    context.receipt = { ...context.receipt, status: "settled" };
    addOperation(context, "cancel", command.at);
    return;
  }
  setRun(context, { cancelRequested: true });
  if (run.phase === "queued" && run.preparation === "none" && run.dispatch === "none") {
    settleRun(context, { kind: "canceled", confirmation: "not_dispatched" }, command.at);
  }
  addOperation(context, "cancel", command.at);
}

export function settle(context: CommitContext, command: Extract<DelegationStoreCommand, { kind: "settle" }>): void {
  const run = requireRun(context);
  if ((command.outcome.kind === "succeeded" || (command.outcome.kind === "canceled" && command.outcome.confirmation === "provider_terminal"))
    && run.phase !== "running" && run.phase !== "waiting") {
    failDelegation("stale_revision", "Provider terminal truth requires a previously running turn.");
  }
  if (command.outcome.kind === "failed" && (run.preparation === "intended" || run.preparation === "uncertain")
    && run.phase === "preparing") failDelegation("recovery_required", "An unresolved preparation intent has no definitive failure receipt.");
  if (command.outcome.kind === "canceled" && command.outcome.confirmation === "not_dispatched"
    && (run.phase !== "queued" || run.preparation !== "none" || run.dispatch !== "none")) {
    failDelegation("stale_revision", "An execution intent cannot be settled as never dispatched.");
  }
  if (run.ownerEpoch !== command.owner.epoch && command.outcome.kind !== "recovery_required"
    && !(run.phase === "queued" && run.preparation === "none" && run.dispatch === "none")) {
    failDelegation("recovery_required", "A new owner cannot reconstruct an old executor's terminal truth.");
  }
  settleRun(context, command.outcome, command.at);
}

export function retireRecovery(context: CommitContext, command: Extract<DelegationStoreCommand, { kind: "retire_recovery" }>): void {
  if (context.task.state !== "recovery_required" || context.current.runs.some((run) => run.phase !== "settled")) {
    failDelegation("recovery_required", "Only a fully settled recovery task can be retired.");
  }
  context.task = { ...context.task, state: "retired", retiredAt: command.at,
    retirement: { operationId: command.operationId, inputDigest: command.inputDigest, reason: command.reason } };
  context.receipt = { ...context.receipt, status: "retired" };
}
