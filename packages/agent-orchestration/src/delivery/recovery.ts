// ------------------------------------------------------------------------------------------------
//                recovery.ts - Current-owner reset of exact abandoned delivery claims
// ------------------------------------------------------------------------------------------------

import { now, type CoordinatorState } from "../execution/state.js";
import { readNotification, receiptNotification } from "./journal.js";

export async function recoverNotificationClaims(state: CoordinatorState): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await state.options.store.scan({ kind: "eligible_notifications", at: now(), limit: state.options.limits.maxPageRecords, ...(cursor ? { cursor } : {}) });
    if (page.kind !== "eligible_notifications") return;
    for (const scanned of page.page.items) {
      const notification = await readNotification(state, scanned.envelope.notificationId);
      if (notification.state !== "claimed" || notification.claim?.ownerEpoch === state.owner.epoch) continue;
      await receiptNotification(state, notification, { status: "uncertain", retryAt: new Date(Date.now() + 1_000).toISOString() });
    }
    cursor = page.page.cursor;
  } while (cursor);
}
