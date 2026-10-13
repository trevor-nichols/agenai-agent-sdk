// ------------------------------------------------------------------------------------------------
//                recovery.ts - Prior-owner uncertainty without provider replay
// ------------------------------------------------------------------------------------------------

import { settleRun } from "../execution/finish.js";
import { schedule } from "../execution/scheduler.js";
import { now, type CoordinatorState } from "../execution/state.js";
import { failDelegation } from "../shared/operational-errors.js";
import type { DelegationRecoveryPage } from "./types.js";

export async function recoverRuns(state: CoordinatorState, limit: number, cursor?: string, start = true): Promise<DelegationRecoveryPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > state.options.limits.maxPageRecords) failDelegation("capacity_exceeded", "Recovery page size exceeds its bound.");
  const page = await state.options.store.scan({ kind: "recoverable_runs", at: now(), limit, ...(cursor ? { cursor } : {}) });
  if (page.kind !== "recoverable_runs") return { recovered: [] };
  const recovered: { taskId: string; runId: string; disposition: "queued" | "recovery_required" }[] = [];
  for (const run of page.page.items) {
    if (run.ownerEpoch === state.owner.epoch || run.phase === "settled") continue;
    if (run.phase === "queued" && run.preparation === "none" && run.dispatch === "none") {
      recovered.push({ taskId: run.taskId, runId: run.runId, disposition: "queued" });
    } else {
      await settleRun(state, run, { kind: "recovery_required", reason: run.pendingRequest ? "request_executor_lost" : "executor_lost" });
      recovered.push({ taskId: run.taskId, runId: run.runId, disposition: "recovery_required" });
    }
  }
  if (start) schedule(state);
  return { recovered, ...(page.page.cursor ? { cursor: page.page.cursor } : {}) };
}
