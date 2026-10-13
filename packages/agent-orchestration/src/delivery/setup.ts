// ------------------------------------------------------------------------------------------------
//                setup.ts - Explicit compatible completion delivery admission
// ------------------------------------------------------------------------------------------------

import type { CreateDelegationCoordinatorOptions } from "../coordinator/types.js";
import type { CoordinatorState } from "../execution/state.js";
import { now } from "../execution/state.js";
import { failDelegation } from "../shared/operational-errors.js";
import type { DelegationCompletionPolicy } from "../tasks/types.js";

export function validateDeliverySetup(options: CreateDelegationCoordinatorOptions): void {
  const port = options.parentDelivery;
  if (port === undefined) return;
  if (!port || typeof port !== "object" || !["volatile", "durable"].includes(port.persistence) || typeof port.accept !== "function" || typeof port.inspect !== "function") {
    failDelegation("unsupported_operation", "Completion delivery requires a declared bounded inbox port.");
  }
  if (options.store.persistence === "durable" && port.persistence !== "durable") {
    failDelegation("unsupported_operation", "A durable task store requires durable parent inbox acceptance.");
  }
}

export function assertCompletionPolicy(state: CoordinatorState, policy: DelegationCompletionPolicy): void {
  if (policy !== "collect" && !state.options.parentDelivery) {
    failDelegation("unsupported_operation", "This completion policy requires an explicit compatible parent inbox port.");
  }
}

export async function assertRetainedDeliverySetup(state: CoordinatorState): Promise<void> {
  if (state.options.parentDelivery) return;
  for (const kind of ["queued", "recoverable_runs", "eligible_notifications"] as const) {
    let cursor: string | undefined;
    do {
      const page = await state.options.store.scan({ kind, at: now(), limit: state.options.limits.maxPageRecords, ...(cursor ? { cursor } : {}) });
      if (page.kind === "eligible_notifications") {
        for (const notification of page.page.items) assertCompletionPolicy(state, notification.envelope.policy);
      } else {
        for (const run of page.page.items) assertCompletionPolicy(state, (await state.task(run.taskId)).task.completionPolicy);
      }
      cursor = page.page.cursor;
    } while (cursor);
  }
}
