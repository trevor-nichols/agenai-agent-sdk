// ------------------------------------------------------------------------------------------------
//                calls.ts - Deadline-bounded inbox calls with retained producer ownership
// ------------------------------------------------------------------------------------------------

import type { CoordinatorState } from "../execution/state.js";
import type { DelegationNotificationRecord } from "../tasks/types.js";

export async function callInbox<Value>(state: CoordinatorState, notification: DelegationNotificationRecord,
  kind: "accept" | "inspect", stopped: () => boolean, invoke: (signal: AbortSignal, deadlineAt: string) => Promise<Value>): Promise<Value | undefined> {
  const unavailable = () => stopped() || state.failed || state.released
    || (kind === "accept" && Date.parse(notification.envelope.expiresAt) <= Date.now());
  if (unavailable()) return undefined;
  const controller = new AbortController();
  const deadline = Math.min(Date.now() + state.options.limits.controlTimeoutMs,
    kind === "accept" ? Date.parse(notification.envelope.expiresAt) : Infinity);
  const id = notification.envelope.notificationId;
  const promise = Promise.resolve().then(() => {
    if (unavailable()) return undefined;
    return invoke(controller.signal, new Date(deadline).toISOString());
  }).finally(() => {
    state.deliveryCalls.delete(id);
    state.changed();
    if (!stopped()) state.wakeDelivery?.();
  });
  state.deliveryCalls.set(id, { controller, taskId: notification.envelope.taskId, promise });
  state.track(promise);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => { controller.abort(new DOMException("Parent inbox deadline expired.", "AbortError")); resolve(undefined); }, Math.max(1, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
