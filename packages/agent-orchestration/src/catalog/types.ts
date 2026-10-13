// ------------------------------------------------------------------------------------------------
//                types.ts - Certified delegation target data - Dependencies: agent protocol
// ------------------------------------------------------------------------------------------------

import type {
  AgentConfigurationSelectionInput,
  AgentInstanceId,
  AgentProviderKey,
  AgentSessionConfiguration,
} from "@agen-ai/agent-protocol";

export interface DelegationTargetReference {
  readonly catalogId: string;
  readonly catalogRevision: number;
  readonly targetId: string;
  readonly targetRevision: number;
  readonly sourceId: string;
  readonly sourceRevision: number;
}

export type DelegationReasoning = string;
export type DelegationExecutionMode = "standard" | "fast";
export type DelegationSemanticFact<Value> =
  | Readonly<{ kind: "certified"; value: Value }>
  | Readonly<{ kind: "unknown" }>;

export interface DelegationTargetOption {
  readonly key: string;
  readonly optionId: string;
}

export interface DelegationTarget {
  readonly reference: DelegationTargetReference;
  readonly instanceId: AgentInstanceId;
  readonly providerKey: AgentProviderKey;
  readonly modelId: string;
  readonly label: string;
  readonly options: readonly DelegationTargetOption[];
  readonly reasoning: DelegationSemanticFact<DelegationReasoning>;
  readonly executionMode: DelegationSemanticFact<DelegationExecutionMode>;
  readonly certification: Readonly<{ mappingId: string; mappingRevision: number }>;
  readonly availability:
    | Readonly<{ kind: "available" }>
    | Readonly<{ kind: "unavailable"; code: string; reason: string }>;
  readonly limitations: readonly string[];
  readonly application: Readonly<{
    configuration: AgentSessionConfiguration;
    beforeFirstTurn: readonly AgentConfigurationSelectionInput[];
  }>;
}

export interface DelegationTargetCatalog {
  readonly catalogId: string;
  readonly revision: number;
  readonly targets: readonly DelegationTarget[];
}
