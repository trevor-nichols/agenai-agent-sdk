// ------------------------------------------------------------------------------------------------
//                cancel.ts - Parent-authorized task cancellation across bounded run pages
// ------------------------------------------------------------------------------------------------

import { cancelLive } from "../execution/control.js";
import { schedule } from "../execution/scheduler.js";
import { sameScopeIdentity, now, type CoordinatorState, type LiveRun, type ParentBinding } from "../execution/state.js";
import { delegationInputDigest, delegationSubordinateId } from "../shared/identity.js";
import { failDelegation } from "../shared/operational-errors.js";
import type { DelegationOperationRecord } from "../store/types.js";
import type { DelegationRunSummary } from "../tasks/types.js";
import { parseOperationId, parseTaskId } from "./parse.js";
import type { DelegationCancelReceipt } from "./types.js";

async function canonicalCancel(state: CoordinatorState, taskId: string, runId: string): Promise<DelegationOperationRecord | undefined> {
  let cursor: string | undefined;
  do {
    const page = await state.options.store.read({ kind: "operations", taskId, runId, limit: state.options.limits.maxPageRecords, ...(cursor ? { cursor } : {}) });
    if (page.kind !== "operations") failDelegation("store_failed", "The operation page does not match its query.");
    const cancel = page.page.items.find((operation) => operation.kind === "cancel");
    if (cancel) return cancel;
    cursor = page.page.cursor;
  } while (cursor);
  return undefined;
}

async function includesRun(state: CoordinatorState, operation: DelegationOperationRecord, rootOrdinal: number, run: DelegationRunSummary): Promise<boolean> {
  if (run.ordinal < rootOrdinal) return false;
  if (run.ordinal === rootOrdinal) return true;
  const admission = await state.options.store.read({ kind: "operation", parent: operation.parent, operationId: run.admissionOperationId });
  if (admission.kind !== "operation" || !admission.operation || admission.operation.kind !== "admit") failDelegation("store_failed", "The cancellation admission history is unavailable.");
  return admission.operation.receipt.taskRevision <= operation.receipt.taskRevision;
}

async function retainedReceipt(state: CoordinatorState, operation: DelegationOperationRecord, duplicate: boolean): Promise<DelegationCancelReceipt> {
  const root = await state.run(operation.taskId, operation.runId);
  let status: DelegationCancelReceipt["status"] = "confirmed";
  let cursor: string | undefined;
  do {
    const page = await state.options.store.read({ kind: "task", taskId: operation.taskId, limit: state.options.limits.maxPageRecords, ...(cursor ? { cursor } : {}) });
    if (page.kind !== "task" || !page.view) failDelegation("store_failed", "The cancellation task history is unavailable.");
    for (const run of page.view.runs.items) {
      if (!await includesRun(state, operation, root.ordinal, run)) continue;
      if (run.outcome?.kind === "recovery_required") status = "recovery_required";
      else if (run.phase !== "settled" && status !== "recovery_required") status = "requested";
    }
    cursor = page.view.runs.cursor;
  } while (cursor);
  return { status, operationId: operation.operationId, taskId: operation.taskId, duplicate };
}

export function createCancelClient(state: CoordinatorState, binding: ParentBinding) {
  return async (input: Readonly<{ operationId: string; taskId: string }>): Promise<DelegationCancelReceipt> => {
    const operationId = parseOperationId(input.operationId);
    const taskId = parseTaskId(input.taskId);
    const digest = delegationInputDigest({ kind: "cancel", taskId });
    const captured = await state.gate(async () => {
      const first = await state.task(taskId);
      if (!sameScopeIdentity(binding.scope, first.task.parent)) failDelegation("request_unavailable", "The managed task does not belong to this parent scope.");
      state.options.host.assertResultAccess({ scope: binding.scope, task: first.task });
      state.options.host.assertControl({ scope: binding.scope, task: first.task });
      const liveRuns = new Set<LiveRun>();
      const prior = await state.options.store.read({ kind: "operation", parent: binding.scope, operationId });
      let canonical: DelegationOperationRecord | undefined;
      if (prior.kind === "operation" && prior.operation) {
        if (prior.operation.kind !== "cancel" || prior.operation.inputDigest !== digest || prior.operation.taskId !== taskId) failDelegation("operation_conflict", "The operation identity already has different retained input.");
        canonical = prior.operation;
      }
      let rootOrdinal = canonical ? (await state.run(taskId, canonical.runId)).ordinal : 0;
      let duplicate = canonical !== undefined;
      let cursor: string | undefined;
      do {
        const page = cursor === undefined ? first : await state.options.store.read({ kind: "task", taskId, cursor, limit: state.options.limits.maxPageRecords }).then((read) => {
          if (read.kind !== "task" || !read.view) return failDelegation("request_unavailable", "The managed task is unavailable.");
          return read.view;
        });
        state.options.host.assertControl({ scope: binding.scope, task: page.task });
        for (const run of page.runs.items) {
          if (canonical) {
            if (!await includesRun(state, canonical, rootOrdinal, run)) continue;
          } else if (run.phase === "settled" && (page.task.state === "active" || run.runId !== page.task.latestRunId)) continue;
          const existing = await canonicalCancel(state, taskId, run.runId);
          if (existing && !canonical) failDelegation("operation_conflict", `Cancellation is already recorded; retry operationId ${existing.operationId}.`);
          if (!existing) {
            const id = canonical ? delegationSubordinateId(run.runId, `cancel:${canonical.operationId}`) : operationId;
            const [{ task }, current] = await Promise.all([state.task(taskId), state.run(taskId, run.runId)]);
            const receipt = await state.commit({ owner: state.owner, operationId: id, inputDigest: digest, taskId,
              expectedTaskRevision: task.revision, runId: run.runId, expectedRunRevision: current.revision,
              kind: "cancel", at: now(), reason: "user_requested" });
            if (!canonical) {
              const recorded = await state.options.store.read({ kind: "operation", parent: binding.scope, operationId: receipt.operationId ?? id });
              if (recorded.kind !== "operation" || !recorded.operation) failDelegation("store_failed", "The canonical cancellation receipt is unavailable.");
              canonical = recorded.operation;
              rootOrdinal = run.ordinal;
            }
            duplicate ||= receipt.duplicate;
          }
          const live = state.live.get(run.runId);
          if (live) liveRuns.add(live);
        }
        cursor = page.runs.cursor;
      } while (cursor);
      if (!canonical) failDelegation("store_failed", "The canonical cancellation receipt is unavailable.");
      return { operation: canonical, duplicate, liveRuns };
    });
    await Promise.all([...captured.liveRuns].map((live) => cancelLive(state, live, "user_requested")));
    schedule(state);
    return retainedReceipt(state, captured.operation, captured.duplicate);
  };
}
