// ------------------------------------------------------------------------------------------------
//                admission.ts - Atomic run admission and capacity reservation
// ------------------------------------------------------------------------------------------------

import { failDelegation } from "../shared/operational-errors.js";
import { delegationDataBytes } from "../shared/identity.js";
import { DELEGATION_CRITICAL_SLOTS, DELEGATION_RUN_RESERVATION_BYTES } from "../shared/limits.js";
import type { DelegationStoreCommand } from "../store/types.js";
import { addOperation, same, type CommitContext } from "./context.js";

export function admitRun(context: CommitContext, command: Extract<DelegationStoreCommand, { kind: "admit" }>): void {
  const { admission } = command;
  const { current } = context;
  const { limits } = current;
  if (current.runIdExists || current.runs.some((run) => run.runId === admission.runId)) {
    failDelegation("operation_conflict", "The run identity is already retained.");
  }
  if (admission.depth > limits.maxDepth || delegationDataBytes(admission.input) > limits.maxInputBytes
    || admission.input.parts.reduce((count, part) => count + (part.type === "text" ? part.text.length : 0), 0) > limits.maxInputTextCharacters) {
    failDelegation("capacity_exceeded", "The admitted depth or input exceeds its configured limit.");
  }
  if (!admission.policyCeiling.targets.some((target) => same(target, admission.target))) {
    failDelegation("policy_denied", "The exact admitted target is outside the retained policy ceiling.");
  }
  if (Date.parse(admission.deadlineAt) <= Date.parse(admission.createdAt)
    || Date.parse(admission.queuedStartDeadlineAt) <= Date.parse(admission.createdAt)
    || Date.parse(admission.deadlineAt) - Date.parse(admission.createdAt) > limits.runTimeoutMs
    || Date.parse(admission.queuedStartDeadlineAt) - Date.parse(admission.createdAt) > limits.queuedStartTimeoutMs) {
    failDelegation("capacity_exceeded", "Admission deadlines exceed their configured bounds.");
  }
  if (current.task) {
    const previous = current.runs.find((run) => run.runId === admission.previousRunId);
    if (!previous || command.runId !== previous.runId || command.expectedRunRevision !== previous.revision) {
      failDelegation("stale_revision", "A continuation requires its exact previous run revision.");
    }
    if ((admission.continuationMode === "next_turn" && (previous.phase !== "running" || previous.cancelRequested))
      || (admission.continuationMode === "follow_up" && (previous.phase !== "settled" || previous.outcome?.kind === "recovery_required"))) {
      failDelegation("stale_revision", "The continuation mode does not match its previous run boundary.");
    }
    if (current.task.state === "retired" || current.task.state === "recovery_required"
      || !same(current.task.parent, admission.parent) || current.task.depth !== admission.depth
      || current.task.policyCeilingRef !== admission.policyCeiling.ceilingId
      || current.task.completionPolicy !== admission.completionPolicy
      || current.task.ancestorTaskId !== admission.ancestorTaskId
      || admission.previousRunId !== current.task.latestRunId
      || current.runs.some((run) => run.phase === "queued")) {
      failDelegation("stale_revision", "A continuation must preserve its task and follow the latest safe run.");
    }
    if (current.runs.some((run) => run.phase === "waiting") || current.task.runCount >= limits.maxRunsPerTask) {
      failDelegation("capacity_exceeded", "This task cannot admit another queued continuation.");
    }
  } else if (admission.previousRunId || command.expectedTaskRevision !== 0) {
    failDelegation("stale_revision", "A new task cannot refer to an earlier run.");
  }
  const ceilingBytes = current.ceiling ? 0 : delegationDataBytes(admission.policyCeiling);
  if (current.ceiling && !same(current.ceiling, admission.policyCeiling)) {
    failDelegation("operation_conflict", "A retained ceiling digest has conflicting facts.");
  }
  const inputBytes = delegationDataBytes(admission.input) + ceilingBytes;
  if ((!current.task && context.capacity.tasks >= limits.maxTasks) || context.capacity.runs >= limits.maxRuns
    || context.capacity.queuedRuns >= limits.maxQueuedRuns
    || context.capacity.retainedInputBytes + inputBytes > limits.maxRetainedInputBytes) {
    failDelegation("capacity_exceeded", "The retained admission or queue capacity is full.");
  }
  context.capacity = { ...context.capacity,
    tasks: context.capacity.tasks + (current.task ? 0 : 1), runs: context.capacity.runs + 1,
    queuedRuns: context.capacity.queuedRuns + 1, retainedInputBytes: context.capacity.retainedInputBytes + inputBytes,
    reservedBytes: context.capacity.reservedBytes + DELEGATION_RUN_RESERVATION_BYTES,
    criticalSlots: context.capacity.criticalSlots + DELEGATION_CRITICAL_SLOTS,
  };
  context.task = { ...context.task, latestRunId: admission.runId, runCount: (current.task?.runCount ?? 0) + 1 };
  context.run = {
    taskId: command.taskId, runId: admission.runId, ordinal: context.task.runCount,
    ...(admission.previousRunId && admission.continuationMode ? {
      previousRunId: admission.previousRunId, continuationMode: admission.continuationMode,
    } : {}),
    admissionOperationId: command.operationId, admittedTarget: admission.target, admittedPolicyRevision: admission.policyRevision,
    admittedOriginPolicyRevision: admission.originPolicyRevision,
    input: admission.input, ownerEpoch: command.owner.epoch, phase: "queued", revision: 1,
    createdAt: admission.createdAt, deadlineAt: admission.deadlineAt, queuedStartDeadlineAt: admission.queuedStartDeadlineAt,
    dispatch: "none", preparation: "none", cancelRequested: false, observationIndex: 0, observationCount: 0,
    observationBytes: 0, omittedObservations: 0, ordinaryOperationCount: 0,
  };
  context.receipt = { ...context.receipt, status: "queued", runId: admission.runId, runRevision: 1, operationId: command.operationId };
  addOperation(context, "admit", admission.createdAt);
  if (!current.ceiling) context.mutations.push({ kind: "ceiling", value: admission.policyCeiling });
}
