// ------------------------------------------------------------------------------------------------
//                cleanup.ts - Bounded exact-handle shutdown before host-resource release
// ------------------------------------------------------------------------------------------------

import { dispatchIntent, operationIdentity, operationReceipt } from "./journal.js";
import type { CoordinatorState, LiveRun } from "./state.js";

async function record(state: CoordinatorState, action: () => Promise<unknown>): Promise<void> {
  try { await action(); } catch { state.fail(); }
}

async function runtimeCleanup(state: CoordinatorState, live: LiveRun): Promise<boolean> {
  const close = operationIdentity(live, "session_close");
  const binding = operationIdentity(live, "binding_cleanup");
  if (live.rejectedOpening && live.runtimeCleanupAttempts === 0) {
    live.runtimeCleanupAttempts = 1;
    await record(state, () => dispatchIntent(state, live, "session_close", close, { attempt: 1 }));
    await record(state, () => dispatchIntent(state, live, "binding_cleanup", binding, { attempt: 1 }));
    await record(state, () => operationReceipt(state, live, "uncertain", close));
    await record(state, () => operationReceipt(state, live, "uncertain", binding));
  }
  while (!live.runtimeClosed && live.runtimeCleanupAttempts < 2) {
    live.runtimeCleanupAttempts += 1;
    const attempt = live.runtimeCleanupAttempts as 1 | 2;
    await record(state, () => dispatchIntent(state, live, "session_close", close, { attempt }));
    await record(state, () => dispatchIntent(state, live, "binding_cleanup", binding, { attempt }));
    try {
      if (live.rejectedOpening) await live.rejectedOpening.retryCleanup();
      else if (live.session) await live.session.close({ reason: state.closing ? "shutdown" : "idle" });
      live.runtimeClosed = true;
    } catch {
      await record(state, () => operationReceipt(state, live, "uncertain", close));
      await record(state, () => operationReceipt(state, live, "uncertain", binding));
    }
  }
  return live.runtimeClosed;
}

export function cleanupRun(state: CoordinatorState, live: LiveRun): Promise<boolean> {
  if (live.cleanup) return live.cleanup;
  live.cleanup = (async () => {
    live.removeRevocation?.();
    if (live.deadline) clearTimeout(live.deadline);
    if (live.request) {
      state.requests.delete(live.request.handle);
      live.request = undefined;
    }
    const reason = new DOMException("The managed run is closing.", "AbortError");
    for (const presentation of live.requestPresentations.values()) presentation.abort.abort(reason);
    live.requestPresentations.clear();
    live.controlAbort.abort(reason);
    const runtimeClosing = runtimeCleanup(state, live);
    live.lifetime.abort(reason);
    while (live.controls.size > 0) await Promise.allSettled(live.controls);
    if (!await runtimeClosing) return false;
    await live.outputDrained;
    while (!live.resourcesReleased && live.resourceReleaseAttempts < 2) {
      live.resourceReleaseAttempts += 1;
      try { await live.resources?.release(); live.resourcesReleased = true; } catch { /* Retain this exact resource lease for the bounded second attempt. */ }
    }
    if (!live.resourcesReleased) return false;
    await record(state, () => operationReceipt(state, live, "completed", operationIdentity(live, "session_close")));
    await record(state, () => operationReceipt(state, live, "completed", operationIdentity(live, "binding_cleanup")));
    while (!live.executionReleased && live.executionReleaseAttempts < 2) {
      live.executionReleaseAttempts += 1;
      try { await live.execution?.release(); live.executionReleased = true; } catch { /* Ownership remains with this exact live grant until release succeeds. */ }
    }
    return live.executionReleased;
  })();
  return live.cleanup;
}
