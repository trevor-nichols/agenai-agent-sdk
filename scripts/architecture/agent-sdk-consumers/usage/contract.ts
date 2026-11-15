// ------------------------------------------------------------------------------------------------
//                contract.ts - Installed token-usage surface, schema and wire retention checks
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";

import {
  AGENT_PROTOCOL_VERSION,
  AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS as root_AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS,
  AGENT_TOKEN_USAGE_COUNTERS as root_AGENT_TOKEN_USAGE_COUNTERS,
  AGENT_TOKEN_USAGE_COUNTER_SUBSETS as root_AGENT_TOKEN_USAGE_COUNTER_SUBSETS,
  AGENT_TOKEN_USAGE_GAP_REASONS as root_AGENT_TOKEN_USAGE_GAP_REASONS,
  AGENT_TOKEN_USAGE_LIMITS as root_AGENT_TOKEN_USAGE_LIMITS,
  AGENT_TOKEN_USAGE_REASONS as root_AGENT_TOKEN_USAGE_REASONS,
  AGENT_TOKEN_USAGE_SCOPE_KINDS as root_AGENT_TOKEN_USAGE_SCOPE_KINDS,
  parseAgentTokenCount as root_parseAgentTokenCount,
  parseAgentTokenUsageCapability as root_parseAgentTokenUsageCapability,
  parseAgentTokenUsageObservation as root_parseAgentTokenUsageObservation,
  parseAgentUsageObservedEvent as root_parseAgentUsageObservedEvent,
  safeParseAgentTokenCount as root_safeParseAgentTokenCount,
  safeParseAgentTokenUsageCapability as root_safeParseAgentTokenUsageCapability,
  safeParseAgentTokenUsageObservation as root_safeParseAgentTokenUsageObservation,
  safeParseAgentUsageObservedEvent as root_safeParseAgentUsageObservedEvent,
} from "@agen-ai/agent-protocol";
import { parseAgentProviderKey, parseAgentSessionId, parseAgentTurnId } from "@agen-ai/agent-protocol";
import {
  AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY,
  AGENT_TOKEN_USAGE_CAPABILITY_JSON_SCHEMA,
  AGENT_TOKEN_USAGE_OBSERVATION_JSON_SCHEMA,
} from "@agen-ai/agent-protocol/json-schema";
import * as protocolUsage from "@agen-ai/agent-protocol/usage";
import {
  AGENT_TOKEN_USAGE_COUNTERS,
  parseAgentTokenCount,
  parseAgentTokenUsageCapability,
  parseAgentTokenUsageObservation,
  parseAgentUsageObservedEvent,
  safeParseAgentTokenCount,
  safeParseAgentTokenUsageObservation,
  type AgentTokenUsageObservation,
} from "@agen-ai/agent-protocol/usage";
import {
  AgentTokenCountSchema,
  AgentTokenUsageCapabilityPortableSchema,
  AgentTokenUsageCapabilitySchema,
  AgentTokenUsageObservationPortableSchema,
  AgentTokenUsageObservationSchema,
} from "@agen-ai/agent-protocol/zod";
import * as runtimeRoot from "@agen-ai/agent-runtime";
import { AgentProviderContractError } from "@agen-ai/agent-runtime";
import * as runtimeUsage from "@agen-ai/agent-runtime/usage";
import {
  admitTokenUsageEvent,
  createTokenUsageLedger,
  createTokenUsagePendingBuffer,
  sumDisjointTokenCounts,
  summarizeTokenUsageView,
  type AgentTokenUsageViewSummary,
} from "@agen-ai/agent-runtime/usage";

type Expect<Condition extends true> = Condition;
export type SummaryMayBeAbsent = Expect<undefined extends ReturnType<typeof summarizeTokenUsageView> ? true : false>;
export type SummaryIsPlainData = Expect<AgentTokenUsageViewSummary["total"]["counters"]["inputTokens"] extends
  { readonly kind: "exact" | "at_least" | "unavailable" } ? true : false>;

const PROTOCOL_USAGE_EXPORTS = [
  "AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS", "AGENT_TOKEN_USAGE_COUNTERS", "AGENT_TOKEN_USAGE_COUNTER_SUBSETS",
  "AGENT_TOKEN_USAGE_GAP_REASONS", "AGENT_TOKEN_USAGE_LIMITS", "AGENT_TOKEN_USAGE_REASONS", "AGENT_TOKEN_USAGE_SCOPE_KINDS",
  "parseAgentTokenCount", "parseAgentTokenUsageCapability", "parseAgentTokenUsageObservation", "parseAgentUsageObservedEvent",
  "safeParseAgentTokenCount", "safeParseAgentTokenUsageCapability", "safeParseAgentTokenUsageObservation",
  "safeParseAgentUsageObservedEvent",
];
const RUNTIME_USAGE_EXPORTS = [
  "AGENT_TOKEN_USAGE_LEDGER_LIMITS", "AGENT_TOKEN_USAGE_PENDING_LIMITS", "admitTokenUsageEvent", "createTokenUsageLedger",
  "createTokenUsagePendingBuffer", "sumDisjointTokenCounts", "summarizeTokenUsageView",
];
const COUNTERS = ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "cacheCreationFiveMinuteInputTokens",
  "cacheCreationOneHourInputTokens", "outputTokens", "reasoningOutputTokens", "modelCalls", "turns"];

// ------------------------------------------------------------------------------------------------
//                Entrypoints
// ------------------------------------------------------------------------------------------------

assert.deepEqual(Object.keys(protocolUsage).sort(), PROTOCOL_USAGE_EXPORTS);
assert.deepEqual(Object.keys(runtimeUsage).sort(), RUNTIME_USAGE_EXPORTS);
const rootProtocol: Readonly<Record<string, unknown>> = {
  AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS: root_AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS,
  AGENT_TOKEN_USAGE_COUNTERS: root_AGENT_TOKEN_USAGE_COUNTERS,
  AGENT_TOKEN_USAGE_COUNTER_SUBSETS: root_AGENT_TOKEN_USAGE_COUNTER_SUBSETS,
  AGENT_TOKEN_USAGE_GAP_REASONS: root_AGENT_TOKEN_USAGE_GAP_REASONS,
  AGENT_TOKEN_USAGE_LIMITS: root_AGENT_TOKEN_USAGE_LIMITS,
  AGENT_TOKEN_USAGE_REASONS: root_AGENT_TOKEN_USAGE_REASONS,
  AGENT_TOKEN_USAGE_SCOPE_KINDS: root_AGENT_TOKEN_USAGE_SCOPE_KINDS,
  parseAgentTokenCount: root_parseAgentTokenCount,
  parseAgentTokenUsageCapability: root_parseAgentTokenUsageCapability,
  parseAgentTokenUsageObservation: root_parseAgentTokenUsageObservation,
  parseAgentUsageObservedEvent: root_parseAgentUsageObservedEvent,
  safeParseAgentTokenCount: root_safeParseAgentTokenCount,
  safeParseAgentTokenUsageCapability: root_safeParseAgentTokenUsageCapability,
  safeParseAgentTokenUsageObservation: root_safeParseAgentTokenUsageObservation,
  safeParseAgentUsageObservedEvent: root_safeParseAgentUsageObservedEvent,
};
const usageProtocol: Readonly<Record<string, unknown>> = protocolUsage;
const rootRuntime: Readonly<Record<string, unknown>> = runtimeRoot;
const usageRuntime: Readonly<Record<string, unknown>> = runtimeUsage;
for (const name of PROTOCOL_USAGE_EXPORTS) assert.equal(rootProtocol[name], usageProtocol[name], `protocol root re-exports ${name}`);
for (const name of RUNTIME_USAGE_EXPORTS) assert.equal(rootRuntime[name], usageRuntime[name], `runtime root re-exports ${name}`);
assert.equal(AGENT_PROTOCOL_VERSION, 14);
assert.deepEqual(AGENT_TOKEN_USAGE_COUNTERS, COUNTERS);
assert.deepEqual(protocolUsage.AGENT_TOKEN_USAGE_LIMITS, { identifierLength: 128, modelProviderLength: 64, modelRows: 8, epochsPerScope: 16, views: 4 });
assert.deepEqual(runtimeUsage.AGENT_TOKEN_USAGE_LEDGER_LIMITS, { observationBytes: 16_384, scopes: 1_024, retainedObservations: 4_096, retainedBytes: 4_194_304 });
assert.deepEqual(runtimeUsage.AGENT_TOKEN_USAGE_PENDING_LIMITS, { observations: 64, bytes: 262_144 });
for (const [artifact, contractId] of [[AGENT_TOKEN_USAGE_OBSERVATION_JSON_SCHEMA, "agenai.agent-protocol.token-usage-observation"],
  [AGENT_TOKEN_USAGE_CAPABILITY_JSON_SCHEMA, "agenai.agent-protocol.token-usage-capability"]] as const) {
  assert.deepEqual([artifact.contractId, artifact.protocolVersion, artifact.direction], [contractId, 14, "output"]);
  assert.ok(AGENT_PROTOCOL_JSON_SCHEMA_REGISTRY.includes(artifact));
}

// ------------------------------------------------------------------------------------------------
//                Wire Retention
// ------------------------------------------------------------------------------------------------

const unsupported = { kind: "unavailable", reasons: ["unsupported"] };
const view = { viewId: "installed-session", authority: "authoritative", accounting: "snapshot",
  countBasis: { modelCalls: "unsupported", turns: "unsupported" }, population: { descendants: "included", auxiliary: "unknown" } };
const counters = { ...Object.fromEntries(COUNTERS.map((name) => [name, unsupported])),
  inputTokens: { kind: "exact", value: 600 }, cacheReadInputTokens: { kind: "unavailable", reasons: ["not_reported"] },
  outputTokens: { kind: "exact", value: 60 }, reasoningOutputTokens: { kind: "at_least", value: 7, reasons: ["native_result_incomplete"] } };
const comparison = { ...Object.fromEntries(COUNTERS.map((name) => [name, { kind: "stable", populationId: `installed:${name}` }])),
  reasoningOutputTokens: { kind: "unknown" } };
const wire = { observationId: "installed:resumed", view, scope: { scopeId: "installed-session", kind: "session" },
  measurement: { kind: "snapshot", epoch: 1, revision: 3, origin: { kind: "historical", cause: "native_new_origin" }, comparison,
    coverage: { kind: "complete" }, counters, attribution: { kind: "model", model: { modelProvider: "installed", modelId: "model-a" } } },
  finality: "open" };

const parsed = parseAgentTokenUsageObservation(wire);
assert.deepEqual(parsed, wire);
assert.deepEqual(parseAgentTokenUsageObservation(JSON.parse(JSON.stringify(parsed))), parsed);
assert.deepEqual(AgentTokenUsageObservationSchema.parse(wire), parsed);
assert.deepEqual(AgentTokenUsageObservationPortableSchema.parse(wire), parsed);
const exactUnderPartial = { ...wire, measurement: { ...wire.measurement, coverage: { kind: "partial", reasons: ["not_reported"] } } };
assert.equal(safeParseAgentTokenUsageObservation(exactUnderPartial).success, false);
assert.equal(AgentTokenUsageObservationSchema.safeParse(exactUnderPartial).success, false);

const capability = { kind: "supported", views: [{ view, scopeKind: "session",
  reportedCounters: ["inputTokens", "outputTokens", "reasoningOutputTokens"], attribution: ["model"] }] };
assert.deepEqual(parseAgentTokenUsageCapability(JSON.parse(JSON.stringify(capability))), capability);
assert.deepEqual(AgentTokenUsageCapabilitySchema.parse(capability), capability);
assert.deepEqual(AgentTokenUsageCapabilityPortableSchema.parse(capability), capability);

const unsupportedLowerBound = { kind: "at_least", value: 1, reasons: ["unsupported"] };
assert.equal(safeParseAgentTokenCount(unsupportedLowerBound).success, false);
assert.equal(AgentTokenCountSchema.safeParse(unsupportedLowerBound).success, false);
assert.deepEqual(parseAgentTokenCount({ kind: "exact", value: 0 }), { kind: "exact", value: 0 });

// ------------------------------------------------------------------------------------------------
//                Ledger Values
// ------------------------------------------------------------------------------------------------

const sessionId = parseAgentSessionId("installed-usage");
const event = (payload: unknown, turnId = "installed-turn") => parseAgentUsageObservedEvent({
  protocolVersion: 14, type: "usage.observed", sessionId, turnId, occurredAt: "2026-11-13T12:00:00.000Z", payload });
const empty = createTokenUsageLedger({ sessionId });

// Epoch 1 cannot open a series; the rejection is inert data and leaves the caller's ledger usable.
const rejected = admitTokenUsageEvent(empty, event(parsed));
if (rejected.status !== "rejected") throw new Error("An epoch-1 snapshot must not open a usage series.");
assert.deepEqual(Object.keys(rejected), ["status", "code", "message"]);
assert.equal(rejected.code, "usage_sequence_invalid");
assert.equal(typeof rejected.message, "string");
assert.ok(Object.isFrozen(rejected));
assert.throws(() => { Object.assign(rejected, { code: "usage_invalid" }); }, TypeError);
assert.equal(summarizeTokenUsageView(empty, parsed.view.viewId), undefined);

const turnView = { ...view, viewId: "installed-turn", accounting: "delta", population: { descendants: "excluded", auxiliary: "excluded" } };
const deltaPayload = (observationId: string, inputTokens: unknown): AgentTokenUsageObservation => parseAgentTokenUsageObservation({
  observationId, view: turnView, scope: { scopeId: "installed-turn", kind: "turn", turnId: "installed-turn" }, finality: "open",
  measurement: { kind: "delta", coverage: { kind: "complete" }, attribution: { kind: "unknown" },
    counters: { ...counters, inputTokens, cacheReadInputTokens: unsupported } } });
const zero = deltaPayload("installed:zero", { kind: "exact", value: 0 });
const first = admitTokenUsageEvent(empty, event(zero));
if (first.status !== "recorded") throw new Error("A measured zero delta must open the turn scope.");
assert.equal(admitTokenUsageEvent(first.ledger, event(zero, "installed-later-turn")).status, "duplicate");
const second = admitTokenUsageEvent(first.ledger, event(deltaPayload("installed:unmeasured", { kind: "unavailable", reasons: ["not_reported"] })));
if (second.status === "rejected") throw new Error(second.message);
const summary = summarizeTokenUsageView(second.ledger, zero.view.viewId);
assert.ok(summary);
// A measured zero plus an unmeasured interval is a lower bound, never a known zero.
assert.deepEqual(summary.total.counters.inputTokens, { kind: "at_least", value: 0, reasons: ["not_reported"] });
assert.deepEqual(summary.total.counters.reasoningOutputTokens, { kind: "at_least", value: 14, reasons: ["native_result_incomplete"] });
assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
for (const value of [summary, summary.total, summary.total.counters, summary.total.counters.inputTokens,
  summary.newWork.counters.reasoningOutputTokens]) assert.ok(Object.isFrozen(value));
assert.throws(() => { Object.assign(summary, { scopeCount: 0 }); }, TypeError);

// ------------------------------------------------------------------------------------------------
//                Pending Delivery and Native Bucket Composition
// ------------------------------------------------------------------------------------------------

const providerKey = parseAgentProviderKey("installed-usage");
const pending = createTokenUsagePendingBuffer({ providerKey });
pending.retain(zero);
pending.retain(parsed);
const drained = pending.drain({ sessionId, turnId: parseAgentTurnId("installed-delivery"), occurredAt: "2026-11-13T12:00:01.000Z" });
assert.deepEqual(drained.map((delivered) => [delivered.turnId, delivered.payload.observationId]),
  [["installed-delivery", "installed:zero"], ["installed-delivery", "installed:resumed"]]);
assert.deepEqual(drained[1]?.payload, parsed);
assert.ok(drained.every((delivered) => Object.isFrozen(delivered) && Object.isFrozen(delivered.payload)));
assert.equal(pending.size, 0);

assert.deepEqual(sumDisjointTokenCounts(providerKey, { kind: "exact", value: 200 }, { kind: "unavailable", reasons: ["not_reported"] }),
  { kind: "at_least", value: 200, reasons: ["not_reported"] });
assert.throws(() => sumDisjointTokenCounts(providerKey, { kind: "exact", value: 1 }, { kind: "unavailable", reasons: ["unsupported"] }),
  (error) => error instanceof AgentProviderContractError && error.code === "usage_invalid");

process.stdout.write(`${JSON.stringify({ proof: "packed-token-usage-contract", evidence: "synthetic",
  protocolExports: PROTOCOL_USAGE_EXPORTS.length, runtimeExports: RUNTIME_USAGE_EXPORTS.length,
  schemaEntrypoints: ["plain", "zod", "zod-portable", "json-schema"], rejection: "frozen", pendingDeliveries: drained.length })}\n`);
