// ------------------------------------------------------------------------------------------------
//                types.ts - Bounded delegation domain contracts
// ------------------------------------------------------------------------------------------------

import type { AgentTurnInputContent } from "@agen-ai/agent-protocol";
import type { DelegationTargetReference } from "../catalog/types.js";
import type { DelegationLimits } from "../shared/limits.js";
import type {
  DelegationCompletionPolicy, DelegationHistoricalRequest, DelegationNotificationRecord,
  DelegationOwnerToken, DelegationPage, DelegationParentScope, DelegationPersistence,
  DelegationPolicyCeiling, DelegationRunOutcome, DelegationRunRecord,
  DelegationTaskObservation, DelegationTaskView,
} from "../tasks/types.js";

export type DelegationOperationKind = "admit" | "prepare" | "configure" | "turn" | "steer"
  | "request_resolution" | "cancel" | "interrupt" | "session_close" | "binding_cleanup";
export type DelegationCriticalSlot = "cancel" | "interrupt" | "session_close" | "binding_cleanup";
export type DelegationOperationDisposition = "intent" | "delegated" | "delivered" | "rejected"
  | "interruption_requested" | "uncertain" | "completed";

export interface DelegationCommitReceipt {
  readonly duplicate: boolean;
  readonly status: "queued" | "preparing" | "running" | "waiting" | "settled" | "recorded" | "omitted" | "retired";
  readonly taskId: string;
  readonly taskRevision: number;
  readonly runId?: string;
  readonly runRevision?: number;
  readonly operationId?: string;
  readonly notificationId?: string;
}

export interface DelegationOperationRecord {
  readonly operationId: string;
  readonly parent: DelegationParentScope;
  readonly taskId: string;
  readonly runId: string;
  readonly kind: DelegationOperationKind;
  readonly inputDigest: string;
  readonly ownerEpoch: number;
  readonly disposition: DelegationOperationDisposition;
  readonly attempts: number;
  readonly at: string;
  readonly message?: string;
  readonly request?: Readonly<Pick<DelegationHistoricalRequest, "requestId" | "requestKind">>;
  readonly requestState?: "pending" | "unavailable";
  readonly receipt: DelegationCommitReceipt;
}

export interface DelegationStoreCapacity {
  readonly tasks: number;
  readonly runs: number;
  readonly activeRuns: number;
  readonly queuedRuns: number;
  readonly retainedInputBytes: number;
  readonly observationBytes: number;
  readonly ordinaryOperations: number;
  readonly reservedBytes: number;
  readonly criticalSlots: number;
}

export interface DelegationMutationFence {
  readonly owner: DelegationOwnerToken;
  readonly operationId: string;
  readonly inputDigest: string;
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly runId?: string;
  readonly expectedRunRevision?: number;
}

export interface DelegationRunAdmission {
  readonly parent: DelegationParentScope;
  readonly ancestorTaskId?: string;
  readonly depth: number;
  readonly policyCeiling: DelegationPolicyCeiling;
  readonly completionPolicy: DelegationCompletionPolicy;
  readonly runId: string;
  readonly previousRunId?: string;
  readonly continuationMode?: "next_turn" | "follow_up";
  readonly target: DelegationTargetReference;
  readonly policyRevision: number;
  readonly originPolicyRevision: number;
  readonly input: AgentTurnInputContent;
  readonly createdAt: string;
  readonly deadlineAt: string;
  readonly queuedStartDeadlineAt: string;
}

export type DelegationDeliveryResult =
  | Readonly<{ status: "accepted"; inboxId: string; acceptedAt: string }>
  | Readonly<{ status: "blocked"; reason: "busy" | "authority_unavailable" | "capacity"; retryAt: string }>
  | Readonly<{ status: "uncertain"; retryAt: string }>
  | Readonly<{ status: "rejected" | "expired" | "dismissed"; reason: string }>;

export type DelegationStoreCommand = DelegationMutationFence & (
  | Readonly<{ kind: "admit"; admission: DelegationRunAdmission }>
  | Readonly<{ kind: "dispatch_intent"; operationKind: Exclude<DelegationOperationKind, "admit" | "cancel">;
    at: string; appliedTarget?: DelegationTargetReference; attempt?: 1 | 2 }>
  | Readonly<{ kind: "operation_receipt"; disposition: Exclude<DelegationOperationDisposition, "intent">; at: string; message?: string;
    requestState?: "pending" | "unavailable" }>
  | Readonly<{ kind: "observe"; observation: DelegationTaskObservation }>
  | Readonly<{ kind: "request_state"; state: "opened" | "resolution_intended" | "resolved" | "unavailable";
    request: DelegationHistoricalRequest; at: string }>
  | Readonly<{ kind: "cancel"; at: string; reason: string }>
  | Readonly<{ kind: "settle"; outcome: DelegationRunOutcome; at: string }>
  | Readonly<{ kind: "delivery_claim"; notificationId: string; expectedNotificationRevision: number; attemptId: string; at: string }>
  | Readonly<{ kind: "delivery_receipt"; notificationId: string; expectedNotificationRevision: number; attemptId: string;
    result: DelegationDeliveryResult; at: string }>
  | Readonly<{ kind: "retire_recovery"; reason: string; at: string }>
);

interface DelegationPageInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export type DelegationStoreReadInput =
  | (Readonly<{ kind: "task"; taskId: string }> & DelegationPageInput)
  | Readonly<{ kind: "run"; taskId: string; runId: string }>
  | Readonly<{ kind: "operation"; parent: DelegationParentScope; operationId: string }>
  | (Readonly<{ kind: "operations"; taskId: string; runId: string }> & DelegationPageInput)
  | (Readonly<{ kind: "observations"; taskId: string; runId: string }> & DelegationPageInput)
  | Readonly<{ kind: "notification"; notificationId: string }>
  | (Readonly<{ kind: "ceiling"; ceilingId: string }> & DelegationPageInput)
  | Readonly<{ kind: "capacity" }>;

export type DelegationStoreReadPage =
  | Readonly<{ kind: "task"; view?: DelegationTaskView }>
  | Readonly<{ kind: "run"; run?: DelegationRunRecord }>
  | Readonly<{ kind: "operation"; operation?: DelegationOperationRecord }>
  | Readonly<{ kind: "operations"; page: DelegationPage<DelegationOperationRecord> }>
  | Readonly<{ kind: "observations"; page: DelegationPage<DelegationTaskObservation>; latestIndex: number; gap: boolean }>
  | Readonly<{ kind: "notification"; notification?: DelegationNotificationRecord }>
  | Readonly<{ kind: "ceiling"; ceilingId: string; origin?: DelegationParentScope; page: DelegationPage<DelegationTargetReference> }>
  | Readonly<{ kind: "capacity"; capacity: DelegationStoreCapacity }>;

export type DelegationStoreScanInput = DelegationPageInput & Readonly<{
  kind: "queued" | "recoverable_runs" | "eligible_notifications";
  at: string;
}>;

export type DelegationStoreScanPage =
  | Readonly<{ kind: "queued" | "recoverable_runs"; page: DelegationPage<DelegationRunRecord> }>
  | Readonly<{ kind: "eligible_notifications"; page: DelegationPage<DelegationNotificationRecord> }>;

export interface DelegationStore {
  readonly contractVersion: 4;
  readonly persistence: DelegationPersistence;
  readonly storeId: string;
  readonly limits: DelegationLimits;
  acquireOwner(): Promise<DelegationOwnerToken>;
  commit(command: DelegationStoreCommand): Promise<DelegationCommitReceipt>;
  read(input: DelegationStoreReadInput): Promise<DelegationStoreReadPage>;
  scan(input: DelegationStoreScanInput): Promise<DelegationStoreScanPage>;
  releaseOwner(owner: DelegationOwnerToken): Promise<void>;
}
