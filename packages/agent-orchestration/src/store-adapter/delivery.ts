// ------------------------------------------------------------------------------------------------
//                delivery.ts - Fixed latest claim and receipt slots for notification delivery
// ------------------------------------------------------------------------------------------------

import { delegationInputDigest, delegationSubordinateId } from "../shared/identity.js";
import { failDelegation } from "../shared/operational-errors.js";
import { parseDelegationNotificationRecord } from "../tasks/parse.js";
import type { DelegationDeliveryCommitRecord } from "../tasks/types.js";
import type { DelegationCommitReceipt, DelegationStoreCommand } from "../store/types.js";
import type { DelegationStoreCommitCurrent } from "./types.js";
import type { CommitContext } from "./context.js";

type DeliveryCommand = Extract<DelegationStoreCommand, { kind: "delivery_claim" | "delivery_receipt" }>;

export function deliveryAttemptIdentity(notificationId: string, attempt: number) {
  const attemptId = delegationSubordinateId(notificationId, `delivery-attempt:${attempt}`);
  return { attemptId, claimOperationId: delegationSubordinateId(attemptId, "claim"), receiptOperationId: delegationSubordinateId(attemptId, "receipt") };
}

export function duplicateDelivery(command: DeliveryCommand, current: DelegationStoreCommitCurrent): DelegationCommitReceipt | undefined {
  const notification = current.notification;
  if (!notification || notification.envelope.notificationId !== command.notificationId
    || notification.envelope.taskId !== command.taskId || notification.envelope.runId !== command.runId) {
    failDelegation("stale_revision", "The exact notification is unavailable.");
  }
  const kind = command.kind === "delivery_claim" ? "claim" : "receipt";
  const retained = notification.delivery?.[kind];
  const other = notification.delivery?.[kind === "claim" ? "receipt" : "claim"];
  if (other?.operationId === command.operationId) failDelegation("operation_conflict", "Delivery operation identity belongs to the other bookkeeping slot.");
  if (retained?.operationId === command.operationId) {
    if (retained.ownerEpoch !== command.owner.epoch) failDelegation("stale_revision", "The retained delivery command belongs to a previous owner.");
    if (retained.attemptId !== command.attemptId || retained.inputDigest !== command.inputDigest
      || retained.commandDigest !== delegationInputDigest(command)) failDelegation("operation_conflict", "The current delivery identity has different committed input.");
    return { ...retained.receipt, duplicate: true };
  }
  const attempt = notification.attempts + (kind === "claim" ? 1 : 0);
  if (!Number.isSafeInteger(attempt) || attempt < 1) failDelegation("capacity_exceeded", "Delivery attempt ordinal is exhausted.");
  const identity = deliveryAttemptIdentity(command.notificationId, attempt);
  if (command.attemptId !== identity.attemptId || command.operationId !== (kind === "claim" ? identity.claimOperationId : identity.receiptOperationId)) {
    failDelegation("stale_revision", "The delivery attempt has been superseded or is not the next canonical attempt.");
  }
  return undefined;
}

export function delivery(context: CommitContext, command: DeliveryCommand): void {
  const prior = context.current.notification!;
  if (prior.revision !== command.expectedNotificationRevision || prior.envelope.policy === "collect") {
    failDelegation("stale_revision", "The exact eligible notification revision is unavailable.");
  }
  context.receipt = { ...context.receipt, notificationId: command.notificationId };
  const kind = command.kind === "delivery_claim" ? "claim" : "receipt";
  const attempt = prior.attempts + (kind === "claim" ? 1 : 0);
  const bookkeeping: DelegationDeliveryCommitRecord = { operationId: command.operationId, inputDigest: command.inputDigest,
    commandDigest: delegationInputDigest(command), attemptId: command.attemptId, attempt, ownerEpoch: command.owner.epoch, receipt: context.receipt };
  const retained = { ...prior, revision: prior.revision + 1, delivery: { ...prior.delivery, [kind]: bookkeeping } };
  let notification;
  if (command.kind === "delivery_claim") {
    if (prior.state !== "pending") failDelegation("stale_revision", "Only a pending notification can begin a new delivery attempt.");
    if (Date.parse(prior.envelope.expiresAt) <= Date.parse(command.at) && prior.reason !== "uncertain") {
      const { retryAt: _retryAt, reason: _reason, ...expired } = retained;
      notification = { ...expired, attempts: attempt, state: "expired" as const, reason: "expired" };
    }
    else {
      if (prior.retryAt && Date.parse(prior.retryAt) > Date.parse(command.at)) failDelegation("stale_revision", "The notification retry is not yet eligible.");
      notification = { ...retained, attempts: attempt, state: "claimed" as const, claim: { ownerEpoch: command.owner.epoch, attemptId: command.attemptId } };
    }
  } else {
    if (prior.state !== "claimed" || prior.claim?.attemptId !== command.attemptId
      || (prior.claim.ownerEpoch !== command.owner.epoch && command.result.status !== "uncertain")) {
      failDelegation("stale_revision", "The receipt does not match this owner or the exact lost-owner claim.");
    }
    const { claim: _claim, retryAt: _retryAt, reason: _reason, inboxId: _inboxId, acceptedAt: _acceptedAt, ...withoutClaim } = retained;
    const result = command.result;
    if (result.status === "blocked" || result.status === "uncertain") {
      const delay = Date.parse(result.retryAt) - Date.parse(command.at);
      if (delay < 1_000 || delay > 30_000) failDelegation("capacity_exceeded", "Delivery retry must be between one and thirty seconds.");
    }
    const change = result.status === "accepted" ? { state: "accepted" as const, inboxId: result.inboxId, acceptedAt: result.acceptedAt }
      : result.status === "blocked" || result.status === "uncertain" ? { state: "pending" as const, retryAt: result.retryAt,
        reason: result.status === "blocked" ? result.reason : "uncertain" }
        : { state: result.status, reason: result.reason };
    notification = { ...withoutClaim, ...change };
  }
  context.mutations.push({ kind: "notification", value: parseDelegationNotificationRecord(notification) });
}
