// ------------------------------------------------------------------------------------------------
//                structuredOutputCandidate.test.ts - Authoritative native candidate boundary behavior
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";

import type { AgentOutputSchema } from "@agen-ai/agent-protocol";

import { createAgentStructuredOutputCandidate } from "../src/index.js";

const schema: AgentOutputSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

test("authoritative JSON text respects its raw UTF-8 limit before parsing and never extracts prose", () => {
  const json = '{"title":"Ready"}';
  assert.deepEqual(createAgentStructuredOutputCandidate({
    schema, candidate: { kind: "json_text", text: json.padEnd(65_536, " ") },
  }), { kind: "json", value: { title: "Ready" } });
  for (const text of [json.padEnd(65_537, " "), `${" ".repeat(65_533)}😀`]) {
    assert.deepEqual(createAgentStructuredOutputCandidate({ schema, candidate: { kind: "json_text", text } }),
      { kind: "unavailable", reason: "output_limit_exceeded" });
  }
  for (const text of [`Here is the object: ${json}`, `\`\`\`json\n${json}\n\`\`\``, '{"title":']) {
    assert.deepEqual(createAgentStructuredOutputCandidate({ schema, candidate: { kind: "json_text", text } }),
      { kind: "unavailable", reason: "invalid_json" });
  }
});

test("native parsed data is bounded before serialization and never invokes accessors or toJSON", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "title", {
    enumerable: true, get() { reads += 1; return "Ready"; },
  });
  const withToJSON = { title: "Ready", toJSON() { reads += 1; return { title: "Changed" }; } };
  const cycle: Record<string, unknown> = { title: "Ready" };
  cycle.self = cycle;
  for (const value of [accessor, withToJSON, cycle, new Date(), { title: Number.POSITIVE_INFINITY }]) {
    assert.deepEqual(createAgentStructuredOutputCandidate({ schema, candidate: { kind: "json_value", value } }),
      { kind: "unavailable", reason: "invalid_json" });
  }
  assert.equal(reads, 0);
  assert.deepEqual(createAgentStructuredOutputCandidate({
    schema, candidate: { kind: "json_value", value: { title: "x".repeat(16_384) } },
  }), { kind: "unavailable", reason: "output_limit_exceeded" });
});

test("native candidates must match the actual schema and the lower advertised byte limit", () => {
  assert.deepEqual(createAgentStructuredOutputCandidate({
    schema, candidate: { kind: "json_text", text: '{"title":42}' },
  }), {
    kind: "unavailable", reason: "schema_mismatch",
    issues: [{ code: "schema_mismatch", path: ["title"], message: "Value does not have the declared JSON type." }],
  });
  assert.deepEqual(createAgentStructuredOutputCandidate({
    schema, maxOutputBytes: 17, candidate: { kind: "json_value", value: { title: "Ready" } },
  }), { kind: "json", value: { title: "Ready" } });
  assert.deepEqual(createAgentStructuredOutputCandidate({
    schema, maxOutputBytes: 16, candidate: { kind: "json_value", value: { title: "Ready" } },
  }), { kind: "unavailable", reason: "output_limit_exceeded" });
  for (const candidate of [
    { kind: "json_value", value: { title: 42 } },
    { kind: "json_text", text: '{"title":42}' },
  ] as const) {
    assert.deepEqual(createAgentStructuredOutputCandidate({ schema, maxOutputBytes: 11, candidate }),
      { kind: "unavailable", reason: "output_limit_exceeded" });
  }
});

test("accepted native candidates own immutable JSON independently of native SDK objects", () => {
  const value = { title: "Ready" };
  const result = createAgentStructuredOutputCandidate({ schema, candidate: { kind: "json_value", value } });
  value.title = "Native mutation";
  assert.deepEqual(result, { kind: "json", value: { title: "Ready" } });
  if (result.kind !== "json") assert.fail("Expected a valid structured candidate.");
  assert.equal(Reflect.set(result.value, "title", "Observer mutation"), false);
  assert.deepEqual(result, { kind: "json", value: { title: "Ready" } });
});

test("explicit observed native failures remain unavailable without fabricated diagnostics", () => {
  for (const reason of ["refused", "incomplete", "missing_output", "native_retries_exhausted", "provider_error"] as const) {
    assert.deepEqual(createAgentStructuredOutputCandidate({ schema, candidate: { kind: "unavailable", reason } }),
      { kind: "unavailable", reason });
  }
});
