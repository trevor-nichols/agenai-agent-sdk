import { normalizeAgentStructuredOutputIssues, validateAgentOutputValue, type AgentJsonObject, type AgentJsonValue, type AgentOutputDefinition, type AgentOutputSchema, type AgentProtocolParseResult } from "@agen-ai/agent-protocol";

import { AgentGenerationError } from "./errors.js";

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

export function captureGenerationCandidate(schema: AgentOutputSchema, value: unknown, maxOutputBytes: number): AgentJsonObject {
  const parsed = validateAgentOutputValue(schema, value, { maxOutputBytes });
  if (!parsed.success) throw new AgentGenerationError("generation_failed", "Structured generation did not produce a valid object.");
  freezeJson(parsed.data);
  return parsed.data;
}

function isJsonArray(value: AgentJsonValue): value is readonly AgentJsonValue[] { return Array.isArray(value); }

function equalJson(left: AgentJsonValue, right: AgentJsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (isJsonArray(left) || isJsonArray(right)) {
    return isJsonArray(left) && isJsonArray(right) && left.length === right.length
      && left.every((child, index) => equalJson(child, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]));
}

export function decodeGenerationCandidate<T>(
  definition: AgentOutputDefinition<T>, candidate: AgentJsonObject, maxOutputBytes: number,
): T {
  let decoded: AgentProtocolParseResult<T>;
  try { decoded = definition.decode(candidate); }
  catch (cause) { throw new AgentGenerationError("decoding_failed", "Object decoder failed.", { cause }); }
  try {
    if (!decoded.success) throw new AgentGenerationError("decoding_failed", "Object decoder rejected the generated value.", {
      issues: normalizeAgentStructuredOutputIssues(decoded.issues),
    });
    const value = decoded.data;
    const admitted = validateAgentOutputValue(definition.schema, value, { maxOutputBytes });
    if (!admitted.success) {
      throw new AgentGenerationError("decoding_failed", "Object decoder returned invalid JSON data.", {
        issues: normalizeAgentStructuredOutputIssues(admitted.issues),
      });
    }
    if (!equalJson(candidate, admitted.data)) {
      throw new AgentGenerationError("decoding_failed", "Object decoder must preserve the generated JSON value.", {
        issues: normalizeAgentStructuredOutputIssues([{ code: "decoded_value_changed", path: [], message: "Object decoder changed the generated JSON value." }]),
      });
    }
    freezeJson(value);
    return value;
  } catch (cause) {
    if (cause instanceof AgentGenerationError) throw cause;
    throw new AgentGenerationError("decoding_failed", "Object decoder failed.", { cause });
  }
}
