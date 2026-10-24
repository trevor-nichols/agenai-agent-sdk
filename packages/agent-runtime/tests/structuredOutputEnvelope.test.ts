import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PROTOCOL_EVENT_BYTES_LIMIT,
  agentProtocolSerializedJsonBytes,
  parseAgentCapabilities,
  parseAgentEvent,
  parseAgentOutputSchema,
} from "@agen-ai/agent-protocol";

import { createAgentEventOutput } from "../src/index.js";
import { validateAgentProviderOutputForContext } from "../src/outputValidation.js";
import { createFakeAgentProvider } from "../src/testing/index.js";

function structuredOutputCapabilities() {
  const defaults = createFakeAgentProvider().capabilities;
  return parseAgentCapabilities({
    ...defaults,
    turns: { ...defaults.turns, structuredOutput: {
      kind: "supported", mechanism: "native", schemaProfile: "agenai.output-schema.v1", scope: "turn",
      maxSchemaBytes: 16_384, maxOutputBytes: 16_384, resume: false, branch: false,
    } },
  });
}

test("schema mismatch drops optional issues when their escaped paths exceed the terminal envelope budget", () => {
  const surrogate = "\ud800";
  const propertyNames = ["a", "b", "c", "d"].map((suffix) => surrogate.repeat(127) + suffix);
  const schema = parseAgentOutputSchema({
    type: "object",
    properties: Object.fromEntries(propertyNames.map((name) => [name, { type: "null" }])),
    required: propertyNames,
    additionalProperties: false,
  });
  const capabilities = structuredOutputCapabilities();
  const reference = surrogate.repeat(512);
  const candidate = createAgentEventOutput({
    protocolVersion: 13,
    type: "turn.completed",
    sessionId: surrogate.repeat(256),
    turnId: surrogate.repeat(256),
    occurredAt: "2026-10-21T00:00:00.000Z",
    providerRefs: { conversationId: reference, historyAnchor: reference, turnId: reference, itemId: reference, requestId: reference },
    payload: { outcome: "completed", reason: "\0".repeat(2_000), structuredOutput: { kind: "json", value: {} } },
  });
  assert.equal(agentProtocolSerializedJsonBytes(candidate.event), 30_732);
  const normalized = validateAgentProviderOutputForContext(candidate, {
    capabilities, providerKey: capabilities.providerKey,
    sessionId: candidate.event.sessionId, turnId: candidate.event.turnId,
    structuredOutputBinding: { request: { kind: "json_schema", schema }, maxOutputBytes: 16_384 },
  });
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "turn.completed") throw new Error("Expected the normalized terminal event.");
  assert.equal(Object.isFrozen(normalized.event), true);
  assert.equal(Object.isFrozen(normalized.event.payload), true);
  assert.equal(Object.isFrozen(normalized.event.payload.structuredOutput), true);
  const emitted = parseAgentEvent(normalized.event);
  assert.equal(emitted.type, "turn.completed");
  assert.ok(agentProtocolSerializedJsonBytes(emitted) <= AGENT_PROTOCOL_EVENT_BYTES_LIMIT);
  assert.deepEqual(emitted, {
    ...candidate.event,
    payload: { outcome: "completed", reason: "\0".repeat(2_000),
      structuredOutput: { kind: "unavailable", reason: "schema_mismatch" } },
  });
});

test("the final envelope check preserves the owned deeply frozen JSON result", () => {
  const schema = parseAgentOutputSchema({
    type: "object", properties: { titles: { type: "array", items: { type: "string" } } },
    required: ["titles"], additionalProperties: false,
  });
  const capabilities = structuredOutputCapabilities();
  const nativeValue = { titles: ["Original title"] };
  const candidate = createAgentEventOutput({
    protocolVersion: 13, type: "turn.completed", sessionId: "envelope-session", turnId: "envelope-turn",
    occurredAt: "2026-10-21T00:00:00.000Z",
    payload: { outcome: "completed", structuredOutput: { kind: "json", value: nativeValue } },
  });
  const normalized = validateAgentProviderOutputForContext(candidate, {
    capabilities, providerKey: capabilities.providerKey,
    sessionId: candidate.event.sessionId, turnId: candidate.event.turnId,
    structuredOutputBinding: { request: { kind: "json_schema", schema }, maxOutputBytes: 16_384 },
  });
  if (normalized.kind !== "event" || normalized.event.type !== "turn.completed"
    || normalized.event.payload.structuredOutput.kind !== "json") throw new Error("Expected the validated JSON result.");
  const result = normalized.event.payload.structuredOutput;
  nativeValue.titles[0] = "Changed native value";
  assert.deepEqual(result, { kind: "json", value: { titles: ["Original title"] } });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.titles), true);
  const titles = result.value.titles;
  if (!Array.isArray(titles)) throw new Error("Expected the validated title array.");
  assert.equal(Reflect.set(titles, "0", "Changed observed value"), false);
  assert.deepEqual(result.value, { titles: ["Original title"] });
  assert.deepEqual(parseAgentEvent(normalized.event), normalized.event);
});
