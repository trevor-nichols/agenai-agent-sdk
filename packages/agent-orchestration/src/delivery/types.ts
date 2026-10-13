// ------------------------------------------------------------------------------------------------
//                types.ts - Explicit parent inbox acceptance without parent provider dispatch
// ------------------------------------------------------------------------------------------------

import type { DelegationCompletionEnvelope, DelegationParentScope, DelegationPersistence } from "../tasks/types.js";

export type DelegationInboxAcceptance =
  | Readonly<{ status: "accepted"; inboxId: string; acceptedAt: string }>
  | Readonly<{ status: "blocked"; reason: "busy" | "authority_unavailable" | "capacity"; retryAt: string }>
  | Readonly<{ status: "rejected"; reason: "revoked" | "parent_retired" | "expired" | "dismissed" }>
  | Readonly<{ status: "uncertain" }>;

export type DelegationInboxInspection =
  | Readonly<{ status: "absent" }>
  | Extract<DelegationInboxAcceptance, { status: "accepted" | "rejected" }>;

export interface DelegationParentDeliveryPort {
  readonly persistence: DelegationPersistence;
  accept(input: Readonly<{ envelope: DelegationCompletionEnvelope; signal: AbortSignal; deadlineAt: string }>): Promise<DelegationInboxAcceptance>;
  inspect(input: Readonly<{ storeId: string; notificationId: string; parent: DelegationParentScope; signal: AbortSignal; deadlineAt: string }>): Promise<DelegationInboxInspection>;
}
