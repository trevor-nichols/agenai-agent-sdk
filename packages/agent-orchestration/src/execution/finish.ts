// ------------------------------------------------------------------------------------------------
//                finish.ts - Immutable terminal truth after owned producer cleanup
// ------------------------------------------------------------------------------------------------

import { delegationInputDigest, delegationSubordinateId } from "../shared/identity.js";
import type { DelegationRunOutcome } from "../tasks/types.js";
import { cleanupRun } from "./cleanup.js";
import { now, type CoordinatorState, type LiveRun } from "./state.js";

async function settle(state: CoordinatorState, live: Pick<LiveRun, "taskId" | "runId">, outcome: DelegationRunOutcome, queuedOnly: boolean): Promise<void> {
  const identity = { operationId: delegationSubordinateId(live.runId, "settle"), inputDigest: delegationInputDigest({ runId: live.runId, outcome }) };
  await state.mutate(live.taskId, live.runId, identity.operationId, identity.inputDigest,
    (fence, _task, run) => queuedOnly && run.phase !== "queued" ? undefined : ({ ...fence, kind: "settle", outcome, at: now() }));
}

export function settleRun(state: CoordinatorState, live: Pick<LiveRun, "taskId" | "runId">, outcome: DelegationRunOutcome): Promise<void> {
  return settle(state, live, outcome, false);
}

export function settleQueuedRun(state: CoordinatorState, live: Pick<LiveRun, "taskId" | "runId">, outcome: DelegationRunOutcome): Promise<void> {
  return settle(state, live, outcome, true);
}

export function finishRun(state: CoordinatorState, live: LiveRun, outcome: DelegationRunOutcome): Promise<void> {
  if (live.finishing) return live.finishing;
  live.finishing = (async () => {
    const closed = await cleanupRun(state, live);
    const truth = outcome.kind === "succeeded" ? { kind: "succeeded" as const,
      result: { text: live.summary, truncated: live.truncated, references: [...live.references] } } : outcome;
    const sticky = live.uncertain && !(live.uncertain === "cancellation_uncertain" && (truth.kind === "succeeded" || truth.kind === "canceled"));
    const final = sticky ? { kind: "recovery_required" as const, reason: live.uncertain! }
      : !closed ? { kind: "recovery_required" as const, reason: "cancellation_uncertain" as const } : truth;
    try {
      await settleRun(state, live, final);
      if (closed) {
        if ((final.kind === "succeeded" || final.kind === "failed" || final.kind === "canceled")
          && live.session && live.resources?.continuation?.kind === "resume") {
          state.continuations.set(live.taskId, { runId: live.runId, binding: live.session.binding, target: live.target });
        } else state.continuations.delete(live.taskId);
        state.live.delete(live.runId);
      }
    } finally { state.changed(); live.schedule?.(); }
  })();
  return state.track(live.finishing);
}
