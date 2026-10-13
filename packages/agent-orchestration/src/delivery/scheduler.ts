// ------------------------------------------------------------------------------------------------
//                scheduler.ts - Bounded completion inbox delivery without parent execution
// ------------------------------------------------------------------------------------------------

import { now, type CoordinatorState } from "../execution/state.js";
import { DelegationOperationError } from "../shared/operational-errors.js";
import type { DelegationDeliveryResult } from "../store/types.js";
import type { DelegationNotificationRecord } from "../tasks/types.js";
import { callInbox } from "./calls.js";
import { claimNotification, readNotification, receiptNotification } from "./journal.js";
import { parseDelegationInboxAcceptance, parseDelegationInboxInspection } from "./parse.js";
import type { DelegationInboxAcceptance, DelegationInboxInspection } from "./types.js";

function retryTime(attempt: number): string {
  return new Date(Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(5, Math.max(0, attempt - 1)))).toISOString();
}

function eligibleAt(notification: DelegationNotificationRecord): number {
  const retry = notification.retryAt ? Date.parse(notification.retryAt) : 0;
  return notification.reason === "uncertain" ? retry : Math.min(Date.parse(notification.envelope.expiresAt), retry);
}

function deliveryResult(value: DelegationInboxAcceptance | Exclude<DelegationInboxInspection, { status: "absent" }>, attempt: number): DelegationDeliveryResult {
  if (value.status === "accepted") return value;
  if (value.status === "uncertain") return { status: "uncertain", retryAt: retryTime(attempt) };
  if (value.status === "blocked") return { ...value, retryAt: new Date(Math.max(Date.now() + 1_000, Math.min(Date.now() + 30_000, Date.parse(value.retryAt)))).toISOString() };
  return { status: value.reason === "expired" || value.reason === "dismissed" ? value.reason : "rejected", reason: value.reason };
}

export function installDeliveryScheduler(state: CoordinatorState): void {
  const port = state.options.parentDelivery;
  let stopped = false;
  let pump: Promise<void> | undefined;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isStopped = () => stopped || state.failed || state.released;

  async function deliver(notification: DelegationNotificationRecord): Promise<DelegationNotificationRecord> {
    if (notification.state === "claimed") {
      // A previous process may have accepted into its inbox before losing the acknowledgement.
      return receiptNotification(state, notification, { status: "uncertain", retryAt: retryTime(notification.attempts) });
    }
    const claimed = await claimNotification(state, notification);
    if (claimed.state !== "claimed") return claimed;
    let result: DelegationDeliveryResult = { status: "uncertain", retryAt: retryTime(claimed.attempts) };
    try {
      let inspection: DelegationInboxInspection = { status: "absent" };
      if (claimed.attempts > 1) {
        const raw = await callInbox(state, claimed, "inspect", isStopped, (signal, deadlineAt) => port!.inspect({
          storeId: claimed.envelope.storeId, notificationId: claimed.envelope.notificationId,
          parent: claimed.envelope.parent, signal, deadlineAt,
        }));
        if (raw === undefined) return receiptNotification(state, claimed, { status: "uncertain", retryAt: retryTime(claimed.attempts) });
        inspection = parseDelegationInboxInspection(raw);
      }
      if (inspection.status !== "absent") result = deliveryResult(inspection, claimed.attempts);
      else if (Date.parse(claimed.envelope.expiresAt) <= Date.now()) result = { status: "expired", reason: "expired" };
      else if (!isStopped() && state.deliveryCalls.size === 0) {
        const raw = await callInbox(state, claimed, "accept", isStopped, (signal, deadlineAt) => port!.accept({ envelope: claimed.envelope, signal, deadlineAt }));
        result = raw === undefined ? { status: "uncertain", retryAt: retryTime(claimed.attempts) }
          : deliveryResult(parseDelegationInboxAcceptance(raw), claimed.attempts);
      }
    } catch { result = { status: "uncertain", retryAt: retryTime(claimed.attempts) }; }
    return receiptNotification(state, claimed, result);
  }

  async function run(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    let earliest = Infinity;
    let cursor: string | undefined;
    do {
      const page = await state.options.store.scan({ kind: "eligible_notifications", at: now(), limit: state.options.limits.maxPageRecords, ...(cursor ? { cursor } : {}) });
      if (page.kind !== "eligible_notifications") return;
      for (const scanned of page.page.items) {
        if (isStopped() || state.deliveryCalls.size > 0) return;
        let notification = await readNotification(state, scanned.envelope.notificationId);
        if (notification.envelope.policy === "collect" || !["pending", "claimed"].includes(notification.state)) continue;
        if (notification.state === "claimed" && notification.claim?.ownerEpoch === state.owner.epoch) continue;
        const eligible = eligibleAt(notification);
        if (notification.state === "pending" && eligible > Date.now()) { earliest = Math.min(earliest, eligible); continue; }
        try { notification = await deliver(notification); }
        catch (error) {
          if (!(error instanceof DelegationOperationError) || error.code !== "stale_revision") throw error;
          notification = await readNotification(state, scanned.envelope.notificationId);
        }
        if (notification.state === "pending") earliest = Math.min(earliest, eligibleAt(notification));
      }
      cursor = page.page.cursor;
    } while (cursor && !isStopped());
    if (Number.isFinite(earliest) && !isStopped() && state.deliveryCalls.size === 0) {
      timer = setTimeout(() => { timer = undefined; schedule(); }, Math.max(1, earliest - Date.now()));
    }
  }

  function schedule(): void {
    if (!port || isStopped()) return;
    if (pump) { pending = true; return; }
    const work = Promise.resolve().then(run).catch(() => state.fail()).finally(() => {
      pump = undefined;
      state.changed();
      if (pending) { pending = false; schedule(); }
    });
    pump = work;
    state.track(work);
  }

  state.wakeDelivery = schedule;
  state.stopDelivery = (abort) => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (abort) for (const call of state.deliveryCalls.values()) call.controller.abort(new DOMException("Parent inbox delivery stopped.", "AbortError"));
  };
}
