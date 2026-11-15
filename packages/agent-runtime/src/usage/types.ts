// ------------------------------------------------------------------------------------------------
//                types.ts - Token-usage accounting results and bounds - Dependencies: agent-protocol
// ------------------------------------------------------------------------------------------------

import type {
  AgentExactTokenCount,
  AgentTokenUsageAuthority,
  AgentTokenUsageCounterName,
  AgentTokenUsageReason,
  AgentTokenUsageScopeKind,
  AgentUsageModel,
  AgentUsageViewId,
} from "@agen-ai/agent-protocol";

import type { AgentProviderContractErrorCode } from "../contractErrors.js";

// ------------------------------------------------------------------------------------------------
//                Bounds
// ------------------------------------------------------------------------------------------------

/** Session-ledger bounds; exhaustion rejects as capacity and never evicts an identity. */
export const AGENT_TOKEN_USAGE_LEDGER_LIMITS = Object.freeze({
  observationBytes: 16_384,
  scopes: 1_024,
  retainedObservations: 4_096,
  retainedBytes: 4_194_304,
});

/** Undelivered observations retained until the next owned output path. */
export const AGENT_TOKEN_USAGE_PENDING_LIMITS = Object.freeze({
  observations: 64,
  bytes: 262_144,
});

// ------------------------------------------------------------------------------------------------
//                Ledger and Summaries
// ------------------------------------------------------------------------------------------------

export type AgentTokenUsageErrorCode = Extract<AgentProviderContractErrorCode, `usage_${string}`>;

declare const ledgerBrand: unique symbol;
export type AgentTokenUsageLedger = Readonly<{ readonly [ledgerBrand]: "AgentTokenUsageLedger" }>;

export type AgentTokenUsageAdmission =
  | Readonly<{ status: "recorded" | "duplicate"; ledger: AgentTokenUsageLedger }>
  | Readonly<{ status: "rejected"; code: AgentTokenUsageErrorCode; message: string }>;

/** Aggregates retain unique reasons from the same finite vocabulary. */
export type AgentTokenUsageAggregateCount =
  | AgentExactTokenCount
  | Readonly<{ kind: "at_least"; value: number; reasons: readonly AgentTokenUsageReason[] }>
  | Readonly<{ kind: "unavailable"; reasons: readonly AgentTokenUsageReason[] }>;

export type AgentTokenUsageAggregateCounters = Readonly<
  Record<AgentTokenUsageCounterName, AgentTokenUsageAggregateCount>
>;

export type AgentTokenUsageAggregateAttribution =
  | Readonly<{ kind: "model"; model: AgentUsageModel }>
  | Readonly<{ kind: "mixed" | "unknown" }>;

export type AgentTokenUsageAmount = Readonly<{
  counters: AgentTokenUsageAggregateCounters;
  attribution: AgentTokenUsageAggregateAttribution;
}>;

export interface AgentTokenUsageViewSummary {
  readonly viewId: AgentUsageViewId;
  readonly authority: AgentTokenUsageAuthority;
  readonly scopeKind: AgentTokenUsageScopeKind;
  readonly scopeCount: number;
  readonly total: AgentTokenUsageAmount;
  readonly newWork: AgentTokenUsageAmount;
}
