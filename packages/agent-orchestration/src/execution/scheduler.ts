// ------------------------------------------------------------------------------------------------
//                scheduler.ts - Authoritative queued dispatch under aggregate live ownership
// ------------------------------------------------------------------------------------------------

import { parseAgentSessionId, parseAgentTurnId } from "@agen-ai/agent-protocol";
import { resolveDelegationPolicy } from "../policy/resolve.js";
import { assertCompletionPolicy } from "../delivery/setup.js";
import { createDelegationId } from "../shared/identity.js";
import { DelegationOperationError, failDelegation } from "../shared/operational-errors.js";
import { assertRunDispatch, readCeiling, sameTarget } from "./authority.js";
import { cancelLive } from "./control.js";
import { settleQueuedRun } from "./finish.js";
import { dispatchIntent } from "./journal.js";
import { prepareRun } from "./prepare.js";
import { now, type CoordinatorState, type LiveRun } from "./state.js";

async function pump(state: CoordinatorState): Promise<void> {
  if (state.released) return;
  if (state.queueTimer) { clearTimeout(state.queueTimer); state.queueTimer = undefined; }
  let earliest = Infinity;
  let cursor: string | undefined;
  do {
    const page = await state.options.store.scan({ kind: "queued", at: now(), limit: state.options.limits.maxPageRecords,
      ...(cursor ? { cursor } : {}) });
    if (page.kind !== "queued") return;
    for (const run of page.page.items) {
      if ((state.closing && !state.draining) || state.failed || state.released) return;
      const expiry = Math.min(Date.parse(run.queuedStartDeadlineAt), Date.parse(run.deadlineAt));
      if (expiry <= Date.now()) {
        await settleQueuedRun(state, run, { kind: "failed", error: { category: "unknown", code: "queued_deadline_expired", message: "The managed task expired before its execution slot became available.", recovery: { kind: "unknown" } } });
        continue;
      }
      if (run.previousRunId) {
        const predecessor = await state.run(run.taskId, run.previousRunId);
        if (predecessor.phase === "settled" && (predecessor.outcome?.kind === "recovery_required"
          || (run.continuationMode === "next_turn" && (predecessor.cancelRequested || predecessor.outcome?.kind === "canceled")))) {
          await settleQueuedRun(state, run, { kind: "failed", error: { category: "unknown", code: "continuation_rejected", message: "The previous run cannot authorize this queued automatic continuation.", recovery: { kind: "unknown" } } });
          continue;
        }
        if (predecessor.phase !== "settled") { earliest = Math.min(earliest, expiry); continue; }
      }
      if (state.live.size >= state.options.limits.maxActiveRuns || [...state.live.values()].some((live) => live.taskId === run.taskId)) {
        earliest = Math.min(earliest, expiry);
        continue;
      }
      const { task } = await state.task(run.taskId);
      assertCompletionPolicy(state, task.completionPolicy);
      const ceiling = await readCeiling(state, task.policyCeilingRef);
      const snapshot = state.options.host.currentPolicy(task.parent);
      const resolved = resolveDelegationPolicy({ catalog: snapshot.catalog, policy: snapshot.policy });
      const target = resolved.allowedTargets.find((candidate) => sameTarget(candidate.reference, run.admittedTarget));
      if (!target || Date.parse(run.queuedStartDeadlineAt) <= Date.now() || Date.parse(run.deadlineAt) <= Date.now()) {
        await settleQueuedRun(state, run, { kind: "failed", error: { category: "unknown", code: "admission_expired", message: "Current authority or the queued start deadline no longer permits this task.", recovery: { kind: "unknown" } } });
        continue;
      }
      const live: LiveRun = { taskId: run.taskId, runId: run.runId, scope: task.parent, target, ceiling,
        lifetime: new AbortController(), controlAbort: new AbortController(), sessionId: parseAgentSessionId(createDelegationId()), turnId: parseAgentTurnId(createDelegationId()), controls: new Set(), requestAttempts: new Map(), requestPresentations: new Map(), pendingOperations: new Map(),
        observedStart: false, recordedStart: false, controlTail: Promise.resolve(), summary: "", truncated: false, references: [], runtimeCleanupAttempts: 0,
        resourceReleaseAttempts: 0, executionReleaseAttempts: 0, runtimeClosed: false, resourcesReleased: false, executionReleased: false,
        schedule: () => schedule(state) };
      live.lifetime.signal.addEventListener("abort", () => {
        for (const presentation of live.requestPresentations.values()) presentation.abort.abort(live.lifetime.signal.reason);
      }, { once: true });
      try {
        assertRunDispatch(state, live, run.admittedPolicyRevision, run.admittedOriginPolicyRevision);
        if (!await dispatchIntent(state, live, "prepare")) continue;
      } catch (error) {
        await settleQueuedRun(state, run, { kind: "failed", error: { category: "unknown", code: error instanceof DelegationOperationError ? error.code : "admission_rejected", message: "The queued admission is no longer current.", recovery: { kind: "unknown" } } });
        continue;
      }
      state.live.set(live.runId, live);
      const revoke = () => { void cancelLive(state, live, "authority_revoked").catch(() => undefined); };
      live.deadline = setTimeout(() => { void cancelLive(state, live, "timeout").catch(() => undefined); }, Math.max(1, Date.parse(run.deadlineAt) - Date.now()));
      live.ready = prepareRun(state, live, revoke);
      state.track(live.ready);
      void live.ready.catch(() => state.fail());
    }
    cursor = page.page.cursor;
  } while (cursor && (!state.closing || state.draining) && !state.released);
  if (Number.isFinite(earliest) && (!state.closing || state.draining) && !state.failed && !state.released) {
    state.queueTimer = setTimeout(() => { state.queueTimer = undefined; schedule(state); }, Math.max(1, earliest - Date.now()));
  }
}

export function schedule(state: CoordinatorState): void {
  if ((state.closing && !state.draining) || state.failed || state.released) return;
  if (state.pump) { state.schedulePending = true; return; }
  const work = Promise.resolve().then(() => pump(state)).catch(() => state.fail())
    .finally(() => { state.pump = undefined; state.changed(); if (state.schedulePending) { state.schedulePending = false; schedule(state); } });
  state.pump = work;
  state.track(work);
}

export function assertAccepting(state: CoordinatorState): void {
  if (state.closing || state.failed || state.released) failDelegation("owner_lost", "The coordinator no longer admits new managed work.");
}
