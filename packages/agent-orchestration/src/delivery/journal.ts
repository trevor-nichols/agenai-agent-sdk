// ------------------------------------------------------------------------------------------------
//                journal.ts - Exact notification claim and receipt commits
// ------------------------------------------------------------------------------------------------

import { now, type CoordinatorState } from "../execution/state.js";
import { delegationInputDigest } from "../shared/identity.js";
import { failDelegation } from "../shared/operational-errors.js";
import { deliveryAttemptIdentity } from "../store-adapter/delivery.js";
import type { DelegationDeliveryResult } from "../store/types.js";
import { parseDelegationNotificationRecord } from "../tasks/parse.js";
import type { DelegationNotificationRecord } from "../tasks/types.js";

export async function readNotification(state: CoordinatorState, notificationId: string): Promise<DelegationNotificationRecord> {
  const page = await state.options.store.read({ kind: "notification", notificationId });
  if (page.kind !== "notification" || !page.notification) return failDelegation("store_failed", "A retained completion notification is unavailable.");
  return parseDelegationNotificationRecord(page.notification);
}

export async function claimNotification(state: CoordinatorState, notification: DelegationNotificationRecord): Promise<DelegationNotificationRecord> {
  const identity = deliveryAttemptIdentity(notification.envelope.notificationId, notification.attempts + 1);
  const command = { kind: "delivery_claim" as const, notificationId: notification.envelope.notificationId,
    expectedNotificationRevision: notification.revision, attemptId: identity.attemptId, at: now() };
  await state.mutate(notification.envelope.taskId, notification.envelope.runId, identity.claimOperationId,
    delegationInputDigest(command), (fence) => ({ ...fence, ...command }));
  return readNotification(state, notification.envelope.notificationId);
}

export async function receiptNotification(state: CoordinatorState, notification: DelegationNotificationRecord, result: DelegationDeliveryResult): Promise<DelegationNotificationRecord> {
  const identity = deliveryAttemptIdentity(notification.envelope.notificationId, notification.attempts);
  const at = now();
  const boundedResult = result.status === "blocked" || result.status === "uncertain" ? { ...result,
    retryAt: new Date(Math.max(Date.parse(at) + 1_000, Math.min(Date.parse(at) + 30_000, Date.parse(result.retryAt)))).toISOString() } : result;
  const command = { kind: "delivery_receipt" as const, notificationId: notification.envelope.notificationId,
    expectedNotificationRevision: notification.revision, attemptId: identity.attemptId, result: boundedResult, at };
  await state.mutate(notification.envelope.taskId, notification.envelope.runId, identity.receiptOperationId,
    delegationInputDigest(command), (fence) => ({ ...fence, ...command }));
  return readNotification(state, notification.envelope.notificationId);
}
