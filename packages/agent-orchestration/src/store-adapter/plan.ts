// ------------------------------------------------------------------------------------------------
//                plan.ts - Pure closed delegation store commit planning
// ------------------------------------------------------------------------------------------------

import { failDelegation } from "../shared/operational-errors.js";
import { copyBoundedDelegationData } from "../shared/bounds.js";
import { delegationInputDigest } from "../shared/identity.js";
import { freezeDelegationData } from "../shared/immutable.js";
import { DELEGATION_CRITICAL_SLOTS, DELEGATION_RUN_RESERVATION_BYTES, parseDelegationLimits } from "../shared/limits.js";
import { parseDelegationStoreCommand } from "../store/parse.js";
import type { DelegationCommitReceipt, DelegationOperationKind, DelegationStoreCommand } from "../store/types.js";
import { parseDelegationRunRecord, parseDelegationTaskRecord } from "../tasks/parse.js";
import { admitRun } from "./admission.js";
import { deriveTask, same, type CommitContext } from "./context.js";
import { dispatchIntent, operationReceipt, requestState } from "./execution.js";
import { cancelRun, observeRun, retireRecovery, settle } from "./lifecycle.js";
import { delivery, duplicateDelivery } from "./delivery.js";
import type { DelegationStoreCommitCurrent, DelegationStoreCommitPlan, DelegationStoreRowMutation } from "./types.js";

function operationKind(command: DelegationStoreCommand): DelegationOperationKind | undefined {
  if (command.kind === "admit" || command.kind === "cancel") return command.kind;
  if (command.kind === "dispatch_intent") return command.operationKind;
  if (command.kind === "request_state" && command.state === "resolution_intended") return "request_resolution";
  return undefined;
}

function duplicate(command: DelegationStoreCommand, current: DelegationStoreCommitCurrent): DelegationCommitReceipt | undefined {
  if (command.kind === "delivery_claim" || command.kind === "delivery_receipt") return duplicateDelivery(command, current);
  const prior = current.operation;
  const kind = operationKind(command);
  if (prior && (prior.inputDigest !== command.inputDigest || (kind && prior.kind !== kind)
    || (command.kind !== "admit" && (prior.taskId !== command.taskId || prior.runId !== command.runId)))) {
    failDelegation("operation_conflict", "The operation identity has different retained input or ownership.");
  }
  if (prior && command.kind === "operation_receipt" && prior.disposition === command.disposition) {
    if (prior.requestState !== command.requestState || prior.message !== command.message) {
      failDelegation("operation_conflict", "The final receipt identity has different retained content.");
    }
    return { ...prior.receipt, duplicate: true };
  }
  if (prior && kind && !(command.kind === "dispatch_intent" && command.attempt === 2 && prior.attempts !== 2)) {
    return { ...prior.receipt, duplicate: true };
  }
  if (command.kind === "cancel") {
    const canonical = current.criticalOperations.find((operation) => operation.kind === "cancel");
    if (canonical) failDelegation("operation_conflict", `Cancellation already uses operation ${canonical.operationId}; retry that exact identity.`);
  }
  const run = current.runs.find((entry) => entry.runId === command.runId);
  if (command.kind === "settle" && run?.finalization) {
    if (run.finalization.operationId !== command.operationId || run.finalization.inputDigest !== command.inputDigest) {
      failDelegation("operation_conflict", "A final outcome already has its canonical settlement.");
    }
    return { duplicate: true, status: "settled", taskId: command.taskId, taskRevision: run.finalization.taskRevision,
      runId: run.runId, runRevision: run.finalization.runRevision, operationId: command.operationId,
      ...(current.notification ? { notificationId: current.notification.envelope.notificationId } : {}) };
  }
  if (command.kind === "observe" && run && command.observation.index <= run.observationIndex) {
    if (!(current.observation && same(current.observation, command.observation))
      && !(command.observation.index === run.observationIndex && run.lastObservationDigest === delegationInputDigest(command.observation))) {
      failDelegation("operation_conflict", "An observation index has different or unavailable retained input.");
    }
    return { duplicate: true, status: current.observation?.kind === "omitted" || !current.observation ? "omitted" : "recorded",
      taskId: run.taskId, taskRevision: current.task!.revision, runId: run.runId, runRevision: run.revision };
  }
  if (command.kind === "retire_recovery" && current.task?.retirement) {
    if (current.task.retirement.operationId !== command.operationId || current.task.retirement.inputDigest !== command.inputDigest) {
      failDelegation("operation_conflict", "Retirement already has a different canonical operation.");
    }
    return { duplicate: true, status: "retired", taskId: command.taskId, taskRevision: current.task.revision };
  }
  return undefined;
}

export function planDelegationStoreCommit(input: {
  readonly command: DelegationStoreCommand;
  readonly current: DelegationStoreCommitCurrent;
}): DelegationStoreCommitPlan {
  const command = parseDelegationStoreCommand(input.command);
  const { current } = input;
  if (!current.owner || current.storeId !== command.owner.storeId || !same(current.owner, command.owner)) {
    failDelegation("owner_lost", "The store owner fence is no longer current.");
  }
  parseDelegationLimits(current.limits);
  const { capacity, limits } = current;
  if (Object.values(capacity).some((count) => !Number.isSafeInteger(count) || count < 0)
    || capacity.tasks > limits.maxTasks || capacity.runs > limits.maxRuns || capacity.tasks > capacity.runs
    || capacity.activeRuns > limits.maxActiveRuns || capacity.queuedRuns > limits.maxQueuedRuns
    || capacity.activeRuns + capacity.queuedRuns > capacity.runs
    || capacity.retainedInputBytes > limits.maxRetainedInputBytes
    || capacity.observationBytes > limits.maxRetainedObservationBytes
    || capacity.ordinaryOperations > limits.maxOrdinaryOperations
    || capacity.reservedBytes !== capacity.runs * DELEGATION_RUN_RESERVATION_BYTES
    || capacity.criticalSlots !== capacity.runs * DELEGATION_CRITICAL_SLOTS) {
    failDelegation("store_failed", "The store capacity counters or configured reservations are inconsistent.");
  }
  if (current.runs.length > current.limits.maxRunsPerTask || current.criticalOperations.length > 4
    || current.runs.some((run) => run.taskId !== command.taskId)
    || (current.task && current.task.taskId !== command.taskId)) failDelegation("store_failed", "The command snapshot is inconsistent.");
  const retry = duplicate(command, current);
  if (retry) return freezeDelegationData({ mutations: [], receipt: retry });
  if ((current.task?.revision ?? 0) !== command.expectedTaskRevision) failDelegation("stale_revision", "The task revision changed.");
  const retainedRun = current.runs.find((run) => run.runId === command.runId);
  if (command.kind !== "admit" && command.kind !== "retire_recovery"
    && (!retainedRun || retainedRun.revision !== command.expectedRunRevision)) failDelegation("stale_revision", "The run revision changed.");
  if (!current.task && command.kind !== "admit") failDelegation("stale_revision", "The task is unavailable.");
  const newTask = command.kind === "admit" ? {
    storeId: current.storeId, taskId: command.taskId, parent: command.admission.parent,
    ...(command.admission.ancestorTaskId ? { ancestorTaskId: command.admission.ancestorTaskId } : {}),
    depth: command.admission.depth, policyCeilingRef: command.admission.policyCeiling.ceilingId,
    completionPolicy: command.admission.completionPolicy, state: "active" as const,
    revision: 1, latestRunId: command.admission.runId, runCount: 0, createdAt: command.admission.createdAt,
  } : undefined;
  const task = current.task ? { ...current.task, revision: current.task.revision + 1 } : newTask!;
  const run = retainedRun ? { ...retainedRun, revision: retainedRun.revision + 1 } : undefined;
  const context: CommitContext = {
    command, current, task, run, capacity: { ...current.capacity }, mutations: [],
    receipt: { duplicate: false, status: "recorded", taskId: task.taskId, taskRevision: task.revision,
      ...(run ? { runId: run.runId, runRevision: run.revision } : {}), operationId: command.operationId },
  };
  switch (command.kind) {
    case "admit": admitRun(context, command); break;
    case "dispatch_intent": dispatchIntent(context, command); break;
    case "operation_receipt": operationReceipt(context, command); break;
    case "observe": observeRun(context, command); break;
    case "request_state": requestState(context, command); break;
    case "cancel": cancelRun(context, command); break;
    case "settle": settle(context, command); break;
    case "delivery_claim":
    case "delivery_receipt": delivery(context, command); break;
    case "retire_recovery": retireRecovery(context, command); break;
  }
  deriveTask(context);
  context.mutations.push({ kind: "task", value: parseDelegationTaskRecord(context.task) });
  if (context.run) context.mutations.push({ kind: "run", value: parseDelegationRunRecord(context.run) });
  context.mutations.push({ kind: "capacity", value: context.capacity });
  const mutations = context.mutations.map((mutation) => {
    const finalized = mutation.kind === "operation"
      ? { ...mutation, value: { ...mutation.value, receipt: context.receipt } } : mutation;
    return copyBoundedDelegationData(finalized) as DelegationStoreRowMutation;
  });
  return freezeDelegationData({ mutations, receipt: context.receipt });
}
