// ------------------------------------------------------------------------------------------------
//                journal.ts - Persist exact provider-affecting intents and bounded receipts
// ------------------------------------------------------------------------------------------------

import type { DelegationTargetReference } from "../catalog/types.js";
import { delegationInputDigest, delegationSubordinateId } from "../shared/identity.js";
import type { DelegationOperationDisposition, DelegationOperationKind } from "../store/types.js";
import { now, type CoordinatorState, type LiveRun } from "./state.js";

export function operationIdentity(live: LiveRun, kind: string) {
  return { operationId: delegationSubordinateId(live.runId, kind), inputDigest: delegationInputDigest({ runId: live.runId, kind }) };
}

export async function dispatchIntent(state: CoordinatorState, live: LiveRun,
  kind: Exclude<DelegationOperationKind, "admit" | "cancel">,
  identity = operationIdentity(live, kind),
  extra: Readonly<{ appliedTarget?: DelegationTargetReference; attempt?: 1 | 2 }> = {}) {
  return state.mutate(live.taskId, live.runId, identity.operationId, identity.inputDigest,
    (fence, _task, run) => kind === "prepare" && run.phase !== "queued" ? undefined
      : ({ ...fence, kind: "dispatch_intent", operationKind: kind, at: now(), ...extra }));
}

export async function operationReceipt(state: CoordinatorState, live: LiveRun,
  disposition: Exclude<DelegationOperationDisposition, "intent">,
  identity: Readonly<{ operationId: string; inputDigest: string }>) {
  return state.mutate(live.taskId, live.runId, identity.operationId, identity.inputDigest,
    (fence) => ({ ...fence, kind: "operation_receipt", disposition, at: now() }));
}
