// ------------------------------------------------------------------------------------------------
//                types.ts - Developer exclusions and end-user selection - Dependencies: catalog
// ------------------------------------------------------------------------------------------------

import type { AgentProviderKey } from "@agen-ai/agent-protocol";
import type {
  DelegationExecutionMode,
  DelegationReasoning,
  DelegationTarget,
  DelegationTargetOption,
  DelegationTargetReference,
} from "../catalog/types.js";

export interface DelegationExclusion {
  readonly exclusionId: string;
  readonly providerKey?: AgentProviderKey;
  readonly modelId?: string;
  readonly targetId?: string;
  readonly catalogId?: string;
  readonly reasoning?: DelegationReasoning;
  readonly executionMode?: DelegationExecutionMode;
  readonly options?: readonly DelegationTargetOption[];
}

export interface DelegationDeveloperPolicy {
  readonly enabled: boolean;
  readonly exclusions: readonly DelegationExclusion[];
}

export type DelegationTargetIdentity = Readonly<{ catalogId: string; targetId: string }>;

export type DelegationUserSelection =
  | Readonly<{
    kind: "all_available";
    includeFast: boolean;
    unknownModeTargets: readonly DelegationTargetIdentity[];
  }>
  | Readonly<{ kind: "explicit"; targets: readonly DelegationTargetIdentity[] }>;

export type DelegationUserPolicy =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; selection?: DelegationUserSelection }>;

export interface DelegationPolicySnapshot {
  readonly revision: number;
  readonly developer: DelegationDeveloperPolicy;
  readonly user: DelegationUserPolicy;
}

export type DelegationPolicyOutcome = "allowed" | "denied" | "unverifiable";

export interface DelegationTargetDecision {
  readonly reference: DelegationTargetReference;
  readonly selected: boolean;
  readonly outcome: DelegationPolicyOutcome;
  readonly reasons: readonly Readonly<{ code: string; exclusionId?: string; message: string }>[];
}

export interface ResolvedDelegationPolicy {
  readonly enabled: boolean;
  readonly policyRevision: number;
  readonly catalogId: string;
  readonly catalogRevision: number;
  readonly decisions: readonly DelegationTargetDecision[];
  readonly allowedTargets: readonly DelegationTarget[];
  readonly missingSelections: readonly DelegationTargetIdentity[];
}
