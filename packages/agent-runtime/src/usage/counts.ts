// ------------------------------------------------------------------------------------------------
//                counts.ts - Checked token-count arithmetic and composition - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import {
  AGENT_TOKEN_USAGE_COUNTERS,
  AGENT_TOKEN_USAGE_COUNTER_SUBSETS,
  AGENT_TOKEN_USAGE_REASONS,
  safeParseAgentTokenCount,
  type AgentProviderKey,
  type AgentTokenCount,
  type AgentTokenUsageCounterName,
  type AgentTokenUsageGapReason,
  type AgentTokenUsageReason,
  type AgentTokenUsageReasons,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import { deepFreeze } from "./canonical.js";
import { rejectUsage, TokenUsageRejection } from "./rejection.js";
import type { AgentTokenUsageAggregateCount, AgentTokenUsageAggregateCounters } from "./types.js";

type Count = AgentTokenUsageAggregateCount;
type Counters = AgentTokenUsageAggregateCounters;
type ReasonList = readonly AgentTokenUsageReason[];

// ------------------------------------------------------------------------------------------------
//                Single Counts
// ------------------------------------------------------------------------------------------------

export function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) rejectUsage("usage_invalid", "Token arithmetic exceeds the safe integer range.");
  return sum;
}

export function unionReasons(...lists: readonly ReasonList[]): ReasonList {
  const present = new Set(lists.flat());
  return AGENT_TOKEN_USAGE_REASONS.filter((reason) => present.has(reason));
}

export const knownValue = (count: Count): number => (count.kind === "unavailable" ? 0 : count.value);
export const reasonsOf = (count: Count): ReasonList => (count.kind === "exact" ? [] : count.reasons);

export const lowerBound = (value: number, ...lists: readonly ReasonList[]): Count => ({
  kind: "at_least",
  value,
  reasons: unionReasons(...lists),
});

export function addCounts(left: Count, right: Count): Count {
  if (left.kind === "unavailable" && right.kind === "unavailable") {
    return { kind: "unavailable", reasons: unionReasons(left.reasons, right.reasons) };
  }
  const value = checkedAdd(knownValue(left), knownValue(right));
  if (left.kind === "exact" && right.kind === "exact") return { kind: "exact", value };
  return lowerBound(value, reasonsOf(left), reasonsOf(right));
}

/** Overlapping intervals may share history, so only their larger known value is certain. */
export function overlapCounts(left: Count, right: Count): Count {
  if (left.kind === "unavailable" && right.kind === "unavailable") {
    return { kind: "unavailable", reasons: unionReasons(left.reasons, right.reasons) };
  }
  return lowerBound(
    Math.max(knownValue(left), knownValue(right)),
    reasonsOf(left),
    reasonsOf(right),
    ["origin_unknown"],
  );
}

export const markDiscontinuous = (count: Count): Count =>
  count.kind === "unavailable" ? count : lowerBound(count.value, reasonsOf(count), ["counter_discontinuity"]);

// ------------------------------------------------------------------------------------------------
//                Counter Records
// ------------------------------------------------------------------------------------------------

export function mapCounters<Value>(
  map: (name: AgentTokenUsageCounterName) => Value,
): Readonly<Record<AgentTokenUsageCounterName, Value>> {
  return Object.fromEntries(AGENT_TOKEN_USAGE_COUNTERS.map((name) => [name, map(name)])) as Readonly<
    Record<AgentTokenUsageCounterName, Value>
  >;
}

export const combineCounters = (
  left: Counters,
  right: Counters,
  combine: (left: Count, right: Count) => Count,
): Counters => mapCounters((name) => combine(left[name], right[name]));

export const unavailableCounters = (reasons: ReasonList): Counters =>
  mapCounters(() => ({ kind: "unavailable", reasons }));

export const ZERO_COUNTERS: Counters = deepFreeze(mapCounters(() => ({ kind: "exact", value: 0 })));

/** Derived values must keep the subset inequalities that native observations satisfy. */
export function assertSubsetsHold(counters: Counters, label: string): void {
  for (const { parent, parts } of AGENT_TOKEN_USAGE_COUNTER_SUBSETS) {
    const total = counters[parent];
    if (total.kind !== "exact") continue;
    const lower = parts.reduce((sum, part) => checkedAdd(sum, knownValue(counters[part])), 0);
    if (lower > total.value) rejectUsage("usage_invalid", `${label}: ${parts.join(" + ")} exceeds exact ${parent}.`);
  }
}

// ------------------------------------------------------------------------------------------------
//                Inclusive Composition
// ------------------------------------------------------------------------------------------------

const isGapReason = (reason: AgentTokenUsageReason): reason is AgentTokenUsageGapReason =>
  reason !== "unsupported";

function gapReasons(reasons: ReasonList): AgentTokenUsageReasons {
  const [first, ...rest] = reasons.filter(isGapReason);
  if (first === undefined) return rejectUsage("usage_invalid", "An inexact count requires a gap reason.");
  return [first, ...rest];
}

function toTokenCount(count: Count): AgentTokenCount {
  if (count.kind === "exact") return count;
  const reasons = gapReasons(count.reasons);
  return count.kind === "at_least" ? { kind: "at_least", value: count.value, reasons } : { kind: "unavailable", reasons };
}

/** Inclusive total of disjoint native buckets; pass only the buckets the pinned source defines. */
export function sumDisjointTokenCounts(
  providerKey: AgentProviderKey,
  ...buckets: readonly [AgentTokenCount, ...AgentTokenCount[]]
): AgentTokenCount {
  try {
    if (buckets.length === 0) rejectUsage("usage_invalid", "At least one native bucket is required.");
    const parsed: readonly Count[] = buckets.map((bucket, index) => {
      const result = safeParseAgentTokenCount(bucket);
      if (!result.success) return rejectUsage("usage_invalid", `Native bucket ${index} is not a token count.`);
      if (reasonsOf(result.data).includes("unsupported")) {
        rejectUsage("usage_invalid", "An unsupported bucket cannot form part of an inclusive total.");
      }
      return result.data;
    });
    return deepFreeze(toTokenCount(parsed.reduce(addCounts)));
  } catch (error) {
    if (error instanceof TokenUsageRejection) throwAgentProviderContractError(providerKey, error.code, error.message);
    throw error;
  }
}
