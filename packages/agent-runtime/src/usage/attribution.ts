// ------------------------------------------------------------------------------------------------
//                attribution.ts - Model attribution identity and aggregation - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import type { AgentTokenUsageAttribution, AgentUsageModel } from "@agen-ai/agent-protocol";

import type { AgentTokenUsageAggregateAttribution } from "./types.js";

type Aggregate = AgentTokenUsageAggregateAttribution;

const MIXED: Aggregate = Object.freeze({ kind: "mixed" });
export const UNKNOWN_ATTRIBUTION: Aggregate = Object.freeze({ kind: "unknown" });

export const modelKey = (model: AgentUsageModel): string => `${model.modelProvider ?? ""}\u0000${model.modelId}`;

/** Aggregates collapse rows; they never split counts across models proportionally. */
export const aggregateAttribution = (attribution: AgentTokenUsageAttribution): Aggregate =>
  attribution.kind === "mixed" ? MIXED : attribution;

/** `null` means no measured attribution evidence yet; an unavailable measurement never adds any. */
export function combineAttribution(left: Aggregate | null, right: Aggregate | null): Aggregate | null {
  if (left === null) return right;
  if (right === null) return left;
  if (left.kind === "mixed" || right.kind === "mixed") return MIXED;
  if (left.kind !== "model" || right.kind !== "model") return UNKNOWN_ATTRIBUTION;
  return modelKey(left.model) === modelKey(right.model) ? left : MIXED;
}
