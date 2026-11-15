// ------------------------------------------------------------------------------------------------
//                tokenUsage.ts - Token-usage observation builders for reducer and session tests
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";

import {
  AGENT_TOKEN_USAGE_COUNTERS,
  parseAgentSessionId,
  parseAgentUsageObservedEvent,
  type AgentUsageObservedEvent,
  type AgentUsageViewId,
} from "@agen-ai/agent-protocol";

import {
  admitTokenUsageEvent,
  createTokenUsageLedger,
  summarizeTokenUsageView,
  type AgentTokenUsageAggregateCounters,
  type AgentTokenUsageAmount,
  type AgentTokenUsageLedger,
} from "../../src/usage/index.js";

type Json = Readonly<Record<string, unknown>>;

export const SESSION = parseAgentSessionId("session-1");
export const exact = (value: number) => ({ kind: "exact", value });
export const atLeast = (value: number, ...reasons: string[]) => ({ kind: "at_least", value, reasons });
export const unavailable = (...reasons: string[]) => ({ kind: "unavailable", reasons });
export const UNSUPPORTED = unavailable("unsupported");
export const COMPLETE = { kind: "complete" };
export const PARTIAL = { kind: "partial", reasons: ["not_reported"] };
export const MODEL_X = { kind: "model", model: { modelProvider: "anthropic", modelId: "model-x" } };
export const MODEL_Y = { kind: "model", model: { modelProvider: "anthropic", modelId: "model-y" } };
export const UNKNOWN = { kind: "unknown" };
export const FRESH = { kind: "fresh_zero", cause: "initial" };
export const HISTORICAL = { kind: "historical", cause: "initial" };
const MAIN_ONLY = { descendants: "excluded", auxiliary: "excluded" };
export const WHOLE_TREE = { descendants: "included", auxiliary: "included" };
const NO_ACTIVITY_COUNTS = { modelCalls: "unsupported", turns: "unsupported" };
export const SESSION_VIEW = {
  viewId: "session-total", authority: "authoritative", accounting: "snapshot", population: WHOLE_TREE, countBasis: NO_ACTIVITY_COUNTS,
};
export const CALL_VIEW = {
  viewId: "turn-work", authority: "authoritative", accounting: "delta", population: MAIN_ONLY, countBasis: NO_ACTIVITY_COUNTS,
};
export const DETAIL_VIEW = {
  viewId: "turn-detail", authority: "detail", accounting: "delta", population: MAIN_ONLY, countBasis: NO_ACTIVITY_COUNTS,
};
export const SESSION_SCOPE = { scopeId: "session", kind: "session" };
export const TURN_A = { scopeId: "turn-a", kind: "turn", turnId: "turn-a" };
export const turnScope = (id: string) => ({ scopeId: id, kind: "turn", turnId: id });

// ------------------------------------------------------------------------------------------------
//                Observations
// ------------------------------------------------------------------------------------------------

export const counters = (values: Json = {}) => Object.fromEntries(AGENT_TOKEN_USAGE_COUNTERS.map((name) => {
  const value = values[name];
  return [name, typeof value === "number" ? exact(value) : value ?? UNSUPPORTED];
}));

const comparison = (overrides: Json = {}) => Object.fromEntries(AGENT_TOKEN_USAGE_COUNTERS.map((name) => [
  name, overrides[name] ?? { kind: "stable", populationId: `population-${name}` },
]));

export const tokens = (inputTokens: unknown, outputTokens: unknown, extra: Json = {}) => ({ inputTokens, outputTokens, ...extra });

export const rows = (x: number, y: number) => ({
  kind: "mixed",
  rowCoverage: "complete",
  rows: [
    { model: MODEL_X.model, counters: counters(tokens(x, 1)) },
    { model: MODEL_Y.model, counters: counters(tokens(y, 1)) },
  ],
});

type Options = Readonly<{
  view?: Json; scope?: Json; coverage?: Json; attribution?: Json; finality?: string;
  epoch?: number; origin?: Json; comparison?: Json;
}>;

export const delta = (observationId: string, values: Json, options: Options = {}) => ({
  observationId,
  view: options.view ?? CALL_VIEW,
  scope: options.scope ?? TURN_A,
  measurement: {
    kind: "delta", coverage: options.coverage ?? COMPLETE, counters: counters(values), attribution: options.attribution ?? MODEL_X,
  },
  finality: options.finality ?? "open",
});

export const snapshot = (observationId: string, revision: number, values: Json, options: Options = {}) => ({
  observationId,
  view: options.view ?? SESSION_VIEW,
  scope: options.scope ?? SESSION_SCOPE,
  measurement: {
    kind: "snapshot",
    epoch: options.epoch ?? 0,
    revision,
    origin: options.origin ?? FRESH,
    comparison: comparison(options.comparison),
    coverage: options.coverage ?? COMPLETE,
    counters: counters(values),
    attribution: options.attribution ?? MODEL_X,
  },
  finality: options.finality ?? "open",
});

export const missing = (observationId: string, reasons: readonly string[], options: Options = {}) => ({
  observationId,
  view: options.view ?? CALL_VIEW,
  scope: options.scope ?? TURN_A,
  measurement: { kind: "unavailable", reasons },
  finality: options.finality ?? "open",
});

// ------------------------------------------------------------------------------------------------
//                Ledger Helpers
// ------------------------------------------------------------------------------------------------

let clock = 0;
/** Untyped envelope, as a JavaScript caller or a malformed producer would supply it. */
export const event = (payload: unknown, overrides: Json = {}): AgentUsageObservedEvent => ({
  protocolVersion: 14,
  type: "usage.observed",
  sessionId: SESSION,
  turnId: "turn-a",
  occurredAt: new Date(Date.UTC(2026, 10, 13, 0, 0, clock++)).toISOString(),
  payload,
  ...overrides,
}) as unknown as AgentUsageObservedEvent;

export const typedEvent = (payload: unknown, overrides: Json = {}): AgentUsageObservedEvent =>
  parseAgentUsageObservedEvent(event(payload, overrides));

export function admitAll(ledger: AgentTokenUsageLedger, ...payloads: readonly unknown[]): AgentTokenUsageLedger {
  return payloads.reduce<AgentTokenUsageLedger>((current, payload) => {
    const result = admitTokenUsageEvent(current, event(payload));
    if (result.status === "rejected") assert.fail(result.message);
    assert.equal(result.status, "recorded");
    return result.ledger;
  }, ledger);
}

export function rejectionCode(ledger: AgentTokenUsageLedger, payload: unknown, overrides?: Json): string {
  const result = admitTokenUsageEvent(ledger, event(payload, overrides));
  assert.equal(result.status, "rejected");
  return result.status === "rejected" ? result.code : "";
}

export const fresh = (...payloads: readonly unknown[]) => admitAll(createTokenUsageLedger({ sessionId: SESSION }), ...payloads);

function amount(ledger: AgentTokenUsageLedger, viewId: string, part: "total" | "newWork"): AgentTokenUsageAmount {
  const summary = summarizeTokenUsageView(ledger, viewId as AgentUsageViewId);
  assert.ok(summary, `missing summary for ${viewId}`);
  return summary[part];
}

export const total = (ledger: AgentTokenUsageLedger, viewId = CALL_VIEW.viewId) => amount(ledger, viewId, "total");
export const newWork = (ledger: AgentTokenUsageLedger, viewId = SESSION_VIEW.viewId) => amount(ledger, viewId, "newWork");
export const pick = (values: AgentTokenUsageAggregateCounters, ...names: readonly (keyof AgentTokenUsageAggregateCounters)[]) =>
  Object.fromEntries(names.map((name) => [name, values[name]]));
