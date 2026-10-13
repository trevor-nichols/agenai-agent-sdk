// ------------------------------------------------------------------------------------------------
//                types.ts - Scoped managed-delegation client and host coordinator
// ------------------------------------------------------------------------------------------------

import type { AgentRequestResolution, AgentTurnInputContent } from "@agen-ai/agent-protocol";
import type { DelegationTarget, DelegationTargetReference } from "../catalog/types.js";
import type { DelegationParentDeliveryPort } from "../delivery/types.js";
import type { DelegationHost, DelegationHostRequestHandle } from "../host/types.js";
import type { DelegationLimits } from "../shared/limits.js";
import type { DelegationStore } from "../store/types.js";
import type { DelegationCompletionPolicy, DelegationObservationGap, DelegationObservedTaskObservation, DelegationParentScope, DelegationTaskView } from "../tasks/types.js";

export interface DelegationTargetPage {
  readonly policyRevision: number;
  readonly targets: readonly DelegationTarget[];
  readonly cursor?: string;
  readonly emptyReason?: "delegation_disabled" | "no_permitted_targets";
}

export interface DelegationBindingSnapshot {
  readonly enabled: boolean;
  readonly policyRevision: number;
  readonly completionPolicies: readonly DelegationCompletionPolicy[];
  readonly limits: Readonly<Pick<DelegationLimits,
    "maxInputBytes" | "maxInputTextCharacters" | "maxWaitMs" | "runTimeoutMs" | "maxPageRecords">>;
}

export interface DelegationSpawnTaskInput {
  readonly operationId: string;
  readonly target: DelegationTargetReference;
  readonly expectedPolicyRevision: number;
  readonly input: AgentTurnInputContent;
  readonly completionPolicy?: DelegationCompletionPolicy;
  readonly timeoutMs?: number;
}

export interface DelegationSendTaskInput {
  readonly operationId: string;
  readonly taskId: string;
  readonly mode: "steer" | "next_turn" | "follow_up";
  readonly input: AgentTurnInputContent;
  readonly target: DelegationTargetReference;
  readonly expectedPolicyRevision: number;
}

export interface DelegationAdmissionReceipt {
  readonly storeId: string;
  readonly operationId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly target: DelegationTargetReference;
  readonly revision: number;
  readonly status: "queued" | "preparing";
  readonly duplicate: boolean;
}

export type DelegationSendReceipt =
  | Readonly<{ status: "queued"; admission: DelegationAdmissionReceipt; duplicate: boolean }>
  | Readonly<{ status: "delivered" | "rejected" | "delivery_uncertain"; operationId: string; taskId: string; runId: string; duplicate: boolean }>;

export interface DelegationCancelReceipt {
  readonly status: "requested" | "confirmed" | "recovery_required";
  readonly operationId: string;
  readonly taskId: string;
  readonly duplicate: boolean;
}

export interface DelegationResolveHostRequestInput {
  readonly handle: DelegationHostRequestHandle;
  readonly operationId: string;
  readonly resolution: AgentRequestResolution;
}

interface DelegationRequestReceiptIdentity {
  readonly taskId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly duplicate: boolean;
}

export type DelegationRequestReceipt = DelegationRequestReceiptIdentity & (
  | Readonly<{ status: "delivered" | "delivery_uncertain" }>
  | Readonly<{ status: "rejected"; requestState: "pending" | "unavailable" }>
);

export type DelegationWaitReceipt = Readonly<{ status: "settled" | "timeout"; task: DelegationTaskView }>;
export interface DelegationRecoveryPage {
  readonly recovered: readonly Readonly<{ taskId: string; runId: string; disposition: "queued" | "recovery_required" }>[];
  readonly cursor?: string;
}
export interface DelegationShutdownReceipt {
  readonly status: "closed" | "recovery_required";
  readonly retainedTaskIds: readonly string[];
}

export interface DelegationClient {
  bindingSnapshot(): Promise<DelegationBindingSnapshot>;
  targets(input?: Readonly<{ cursor?: string; limit?: number }>): Promise<DelegationTargetPage>;
  spawn(input: DelegationSpawnTaskInput): Promise<DelegationAdmissionReceipt>;
  inspect(input: Readonly<{ taskId: string; runsCursor?: string; limit?: number }>): Promise<DelegationTaskView>;
  observe(input: Readonly<{ taskId: string; after?: string; signal?: AbortSignal }>): AsyncIterable<DelegationObservedTaskObservation | DelegationObservationGap>;
  wait(input: Readonly<{ taskId: string; timeoutMs: number; signal?: AbortSignal }>): Promise<DelegationWaitReceipt>;
  send(input: DelegationSendTaskInput): Promise<DelegationSendReceipt>;
  cancel(input: Readonly<{ operationId: string; taskId: string }>): Promise<DelegationCancelReceipt>;
}

export interface DelegationCoordinator {
  bindParent(input: Readonly<{ scope: DelegationParentScope; ancestor?: Readonly<{ taskId: string; runId: string }> }>): Promise<DelegationClient>;
  resolveRequest(input: DelegationResolveHostRequestInput): Promise<DelegationRequestReceipt>;
  recover(input: Readonly<{ limit: number; cursor?: string }>): Promise<DelegationRecoveryPage>;
  retireRecoveryTask(input: Readonly<{ operationId: string; taskId: string; reason: string }>): Promise<DelegationTaskView>;
  dispose(input: Readonly<{ mode: "drain" | "cancel"; timeoutMs: number }>): Promise<DelegationShutdownReceipt>;
}

export interface CreateDelegationCoordinatorOptions {
  readonly host: DelegationHost;
  readonly store: DelegationStore;
  readonly limits: DelegationLimits;
  readonly parentDelivery?: DelegationParentDeliveryPort;
}
