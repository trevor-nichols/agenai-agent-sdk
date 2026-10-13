// ------------------------------------------------------------------------------------------------
//                context.ts - Command-local store transition helpers
// ------------------------------------------------------------------------------------------------

import { failDelegation } from "../shared/operational-errors.js";
import { delegationCanonicalJson, delegationDataBytes, delegationSubordinateId } from "../shared/identity.js";
import { DELEGATION_CRITICAL_SLOT_BYTES, DELEGATION_FINAL_RESERVATION_BYTES } from "../shared/limits.js";
import { parseDelegationCompletionEnvelope } from "../tasks/parse.js";
import type { DelegationNotificationRecord, DelegationRunOutcome, DelegationRunRecord, DelegationTaskRecord } from "../tasks/types.js";
import type {
  DelegationCommitReceipt, DelegationOperationKind, DelegationOperationRecord, DelegationStoreCapacity, DelegationStoreCommand,
} from "../store/types.js";
import type { DelegationStoreCommitCurrent, DelegationStoreRowMutation } from "./types.js";

export const criticalKinds: ReadonlySet<DelegationOperationKind> = new Set(["cancel", "interrupt", "session_close", "binding_cleanup"]);

export interface CommitContext {
  command: DelegationStoreCommand;
  current: DelegationStoreCommitCurrent;
  task: DelegationTaskRecord;
  run?: DelegationRunRecord;
  capacity: DelegationStoreCapacity;
  mutations: DelegationStoreRowMutation[];
  receipt: DelegationCommitReceipt;
}

export function same(left: unknown, right: unknown): boolean {
  return delegationCanonicalJson(left) === delegationCanonicalJson(right);
}

export function requireRun(context: CommitContext): DelegationRunRecord {
  if (!context.run) return failDelegation("stale_revision", "The exact task run is unavailable.");
  return context.run;
}

export function setRun(context: CommitContext, change: Partial<DelegationRunRecord>): void {
  const prior = requireRun(context);
  const run = { ...prior, ...change };
  if (prior.phase === "queued" && run.phase !== "queued") context.capacity = {
    ...context.capacity, queuedRuns: context.capacity.queuedRuns - 1,
    activeRuns: context.capacity.activeRuns + (run.phase === "settled" ? 0 : 1),
  };
  if (prior.phase !== "queued" && prior.phase !== "settled" && run.phase === "settled") {
    context.capacity = { ...context.capacity, activeRuns: context.capacity.activeRuns - 1 };
  }
  context.run = run;
}

export function addOperation(context: CommitContext, kind: DelegationOperationKind, at: string, attempt = 1,
  request?: DelegationOperationRecord["request"]): void {
  const run = requireRun(context);
  if (!criticalKinds.has(kind)) {
    if (run.ordinaryOperationCount >= context.current.limits.maxOrdinaryOperationsPerRun
      || context.capacity.ordinaryOperations >= context.current.limits.maxOrdinaryOperations) {
      failDelegation("capacity_exceeded", "The ordinary operation ledger is full.");
    }
    setRun(context, { ordinaryOperationCount: run.ordinaryOperationCount + 1 });
    context.capacity = { ...context.capacity, ordinaryOperations: context.capacity.ordinaryOperations + 1 };
  }
  const operation: DelegationOperationRecord = {
    operationId: context.command.operationId, parent: context.task.parent, taskId: context.task.taskId,
    runId: run.runId, kind, inputDigest: context.command.inputDigest, ownerEpoch: context.command.owner.epoch,
    disposition: kind === "admit" || kind === "cancel" ? "completed" : "intent", attempts: attempt, at,
    ...(request ? { request } : {}),
    receipt: { ...context.receipt, operationId: context.command.operationId },
  };
  if (delegationDataBytes(operation) > DELEGATION_CRITICAL_SLOT_BYTES) failDelegation("capacity_exceeded", "Operation exceeds its fixed ledger slot.");
  context.mutations.push({ kind: "operation", value: operation });
}

export function settleRun(context: CommitContext, requested: DelegationRunOutcome, at: string): DelegationNotificationRecord {
  const run = requireRun(context);
  if (run.outcome) failDelegation("operation_conflict", "A settled run outcome is immutable.");
  const outcome: DelegationRunOutcome = run.recoveryReason
    ? { kind: "recovery_required", reason: run.recoveryReason } : requested;
  const notificationId = delegationSubordinateId(run.runId, "notification");
  const envelope = parseDelegationCompletionEnvelope({
    storeId: context.current.storeId, notificationId, taskId: run.taskId, runId: run.runId,
    parent: context.task.parent, policy: context.task.completionPolicy, settledAt: at,
    expiresAt: new Date(Date.parse(at) + context.current.limits.notificationTtlMs).toISOString(), outcome,
  });
  const notification: DelegationNotificationRecord = {
    envelope, revision: 1, state: context.task.completionPolicy === "collect" ? "collectible" : "pending", attempts: 0,
  };
  if (delegationDataBytes({ outcome, notification }) > DELEGATION_FINAL_RESERVATION_BYTES) {
    failDelegation("capacity_exceeded", "Settlement exceeds its reserved final slot.");
  }
  setRun(context, { phase: "settled", outcome, settledAt: at,
    ...(run.pendingRequest ? { pendingRequest: { ...run.pendingRequest, state: "unavailable" as const } } : {}),
    finalization: { operationId: context.command.operationId, inputDigest: context.command.inputDigest,
      taskRevision: context.task.revision, runRevision: run.revision },
  });
  context.receipt = { ...context.receipt, status: "settled", notificationId };
  context.mutations.push({ kind: "notification", value: notification });
  return notification;
}

export function deriveTask(context: CommitContext): void {
  const runs = context.current.runs.map((run) => run.runId === context.run?.runId ? context.run : run);
  if (context.run && !runs.some((run) => run.runId === context.run?.runId)) runs.push(context.run);
  const state = context.task.state === "retired" ? "retired"
    : runs.some((run) => run.outcome?.kind === "recovery_required" || run.recoveryReason) ? "recovery_required"
      : runs.some((run) => run.phase !== "settled") ? "active" : "settled";
  context.task = { ...context.task, state };
}
