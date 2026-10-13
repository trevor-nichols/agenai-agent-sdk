// ------------------------------------------------------------------------------------------------
//                types.ts - Bounded delegation domain contracts
// ------------------------------------------------------------------------------------------------

import type { AgentFailureCategory, AgentRecoveryHint, AgentTurnInputContent } from "@agen-ai/agent-protocol";
import type { DelegationTargetReference } from "../catalog/types.js";
import type { DelegationCommitReceipt } from "../store/types.js";

export type DelegationPersistence = "volatile" | "durable";
export type DelegationTaskState = "active" | "settled" | "recovery_required" | "retired";
export type DelegationRunPhase = "queued" | "preparing" | "running" | "waiting" | "settled";
export type DelegationCompletionPolicy = "collect" | "next_turn" | "automatic";

export interface DelegationParentScope {
  readonly parentId: string;
  readonly scopeId: string;
  readonly revision: number;
}

export interface DelegationOwnerToken {
  readonly storeId: string;
  readonly epoch: number;
  readonly nonce: string;
}

export interface DelegationPolicyCeiling {
  readonly ceilingId: string;
  readonly origin: DelegationParentScope;
  readonly targets: readonly DelegationTargetReference[];
}

export interface DelegationTaskRecord {
  readonly storeId: string;
  readonly taskId: string;
  readonly parent: DelegationParentScope;
  readonly ancestorTaskId?: string;
  readonly depth: number;
  readonly policyCeilingRef: string;
  readonly completionPolicy: DelegationCompletionPolicy;
  readonly state: DelegationTaskState;
  readonly revision: number;
  readonly latestRunId: string;
  readonly runCount: number;
  readonly createdAt: string;
  readonly retiredAt?: string;
  readonly retirement?: Readonly<{ operationId: string; inputDigest: string; reason: string }>;
}

export interface DelegationHistoricalRequest {
  readonly requestId: string;
  readonly requestKind: "approval" | "elicitation";
  readonly openedAt: string;
  readonly expiresAt?: string;
  readonly state: "waiting" | "resolution_intended" | "resolved" | "unavailable";
}

export interface DelegationResultReference {
  readonly id: string;
  readonly kind: "artifact" | "host_result";
  readonly digest?: string;
}

export interface DelegationResultSummary {
  readonly text: string;
  readonly truncated: boolean;
  readonly references: readonly DelegationResultReference[];
}

export interface DelegationPublicFailure {
  readonly category: AgentFailureCategory;
  readonly code: string;
  readonly message: string;
  readonly recovery: Exclude<AgentRecoveryHint, { kind: "wait_for_quota" }> | Readonly<{ kind: "wait_for_quota" }>;
}

export type DelegationRunOutcome =
  | Readonly<{ kind: "succeeded"; result: DelegationResultSummary }>
  | Readonly<{ kind: "failed"; error: DelegationPublicFailure }>
  | Readonly<{ kind: "canceled"; confirmation: "not_dispatched" | "provider_terminal" }>
  | Readonly<{ kind: "recovery_required"; reason:
    "executor_lost" | "dispatch_uncertain" | "request_executor_lost" | "steering_uncertain"
    | "cancellation_uncertain" | "storage_failed" }>;

export interface DelegationRunRecord {
  readonly taskId: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly previousRunId?: string;
  readonly continuationMode?: "next_turn" | "follow_up";
  readonly admissionOperationId: string;
  readonly admittedTarget: DelegationTargetReference;
  readonly appliedTarget?: DelegationTargetReference;
  readonly admittedPolicyRevision: number;
  readonly admittedOriginPolicyRevision: number;
  readonly input: AgentTurnInputContent;
  readonly ownerEpoch: number;
  readonly phase: DelegationRunPhase;
  readonly revision: number;
  readonly createdAt: string;
  readonly deadlineAt: string;
  readonly queuedStartDeadlineAt: string;
  readonly dispatch: "none" | "intended" | "delegated";
  readonly preparation: "none" | "intended" | "completed" | "uncertain";
  readonly cancelRequested: boolean;
  readonly pendingRequest?: DelegationHistoricalRequest;
  readonly outcome?: DelegationRunOutcome;
  readonly settledAt?: string;
  readonly observationIndex: number;
  readonly observationCount: number;
  readonly observationBytes: number;
  readonly omittedObservations: number;
  readonly lastObservationDigest?: string;
  readonly ordinaryOperationCount: number;
  readonly recoveryReason?: Extract<DelegationRunOutcome, { kind: "recovery_required" }>["reason"];
  readonly finalization?: Readonly<{ operationId: string; inputDigest: string; taskRevision: number; runRevision: number }>;
}

export interface DelegationTaskObservation {
  readonly storeId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly index: number;
  readonly at: string;
  readonly kind: "state" | "text" | "request" | "omitted";
  readonly phase?: DelegationRunPhase;
  readonly text?: string;
  readonly request?: DelegationHistoricalRequest;
  readonly omitted?: number;
}

export interface DelegationObservationGap {
  readonly kind: "gap";
  readonly storeId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly cursor: string;
}

export type DelegationObservedTaskObservation = DelegationTaskObservation & Readonly<{ cursor: string }>;

export interface DelegationCompletionEnvelope {
  readonly storeId: string;
  readonly notificationId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly parent: DelegationParentScope;
  readonly policy: DelegationCompletionPolicy;
  readonly settledAt: string;
  readonly expiresAt: string;
  readonly outcome: DelegationRunOutcome;
}

export interface DelegationDeliveryCommitRecord {
  readonly operationId: string;
  readonly inputDigest: string;
  readonly commandDigest: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly ownerEpoch: number;
  readonly receipt: DelegationCommitReceipt;
}

export interface DelegationNotificationRecord {
  readonly envelope: DelegationCompletionEnvelope;
  readonly revision: number;
  readonly state: "collectible" | "pending" | "claimed" | "accepted" | "rejected" | "expired" | "dismissed";
  readonly claim?: Readonly<{ ownerEpoch: number; attemptId: string }>;
  readonly attempts: number;
  readonly retryAt?: string;
  readonly inboxId?: string;
  readonly acceptedAt?: string;
  readonly reason?: string;
  readonly delivery?: Readonly<{ claim?: DelegationDeliveryCommitRecord; receipt?: DelegationDeliveryCommitRecord }>;
}

export interface DelegationPage<Value> {
  readonly items: readonly Value[];
  readonly cursor?: string;
}

export interface DelegationTaskView {
  readonly task: DelegationTaskRecord;
  readonly runs: DelegationPage<DelegationRunSummary>;
}

export type DelegationRunSummary = Omit<DelegationRunRecord, "input">;
