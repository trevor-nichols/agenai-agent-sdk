// ------------------------------------------------------------------------------------------------
//                shutdown.ts - Bounded shutdown retaining unresolved execution ownership
// ------------------------------------------------------------------------------------------------

import { cancelLive } from "../execution/control.js";
import { now, type CoordinatorState } from "../execution/state.js";
import { schedule } from "../execution/scheduler.js";
import { delegationInputDigest, delegationSubordinateId } from "../shared/identity.js";
import { failDelegation } from "../shared/operational-errors.js";
import type { DelegationShutdownReceipt } from "./types.js";

async function cancelQueued(state: CoordinatorState): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await state.options.store.scan({ kind: "queued", at: now(), limit: state.options.limits.maxPageRecords, ...(cursor ? { cursor } : {}) });
    if (page.kind !== "queued") return;
    for (const run of page.page.items) await state.mutate(run.taskId, run.runId, delegationSubordinateId(run.runId, "shutdown_cancel"),
      delegationInputDigest({ runId: run.runId, kind: "shutdown_cancel" }), (fence) => ({ ...fence, kind: "cancel", at: now(), reason: "shutdown" }));
    cursor = page.page.cursor;
  } while (cursor);
}

export async function shutdown(state: CoordinatorState, input: Readonly<{ mode: "drain" | "cancel"; timeoutMs: number }>): Promise<DelegationShutdownReceipt> {
  if (!["drain", "cancel"].includes(input.mode) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
    || input.timeoutMs > state.options.limits.maxWaitMs) failDelegation("capacity_exceeded", "Shutdown exceeds its configured wait bound.");
  if (state.released) return { status: "closed", retainedTaskIds: [] };
  state.closing = true;
  state.stopDelivery?.(input.mode === "cancel");
  state.draining = input.mode === "drain";
  if (!state.draining && state.queueTimer) { clearTimeout(state.queueTimer); state.queueTimer = undefined; }
  const actions = input.mode === "cancel" ? Promise.allSettled([cancelQueued(state), ...[...state.live.values()].map((live) => cancelLive(state, live, "shutdown"))]) : Promise.resolve();
  state.track(Promise.resolve(actions).then(() => undefined));
  if (state.draining) schedule(state);
  const end = Date.now() + input.timeoutMs;
  while ((state.producers.size > 0 || state.live.size > 0) && Date.now() < end) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    await new Promise<void>((resolve) => {
      wake = resolve;
      state.waiters.add(resolve);
      timer = setTimeout(resolve, Math.max(1, end - Date.now()));
    });
    if (timer) clearTimeout(timer);
    if (wake) state.waiters.delete(wake);
  }
  const queuedTaskIds: string[] = [];
  let cursor: string | undefined;
  do {
    const queued = await state.options.store.scan({ kind: "queued", at: now(), limit: state.options.limits.maxPageRecords, ...(cursor ? { cursor } : {}) });
    if (queued.kind !== "queued") failDelegation("store_failed", "The queued scan does not match its query.");
    queuedTaskIds.push(...queued.page.items.map((run) => run.taskId));
    cursor = queued.page.cursor;
  } while (cursor);
  if (state.live.size > 0 || state.producers.size > 0 || state.failed || queuedTaskIds.length > 0) return { status: "recovery_required", retainedTaskIds: [...new Set([...state.live.values()].map((live) => live.taskId).concat(queuedTaskIds, [...state.deliveryCalls.values()].map((call) => call.taskId)))].sort() };
  await state.options.store.releaseOwner(state.owner);
  if (state.queueTimer) { clearTimeout(state.queueTimer); state.queueTimer = undefined; }
  state.released = true;
  state.changed();
  return { status: "closed", retainedTaskIds: [] };
}
