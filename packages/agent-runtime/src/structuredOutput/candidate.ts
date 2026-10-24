// ------------------------------------------------------------------------------------------------
//                candidate.ts - Bounded authoritative native final candidates - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import {
  AGENT_OUTPUT_RAW_JSON_BYTES_LIMIT,
  AGENT_OUTPUT_VALUE_BYTES_LIMIT,
  AGENT_STRUCTURED_OUTPUT_UNAVAILABLE_REASONS,
  parseAgentOutputSchema,
  validateAgentOutputValue,
  type AgentJsonValue,
  type AgentOutputSchema,
  type AgentStructuredOutputResult,
  type AgentStructuredOutputUnavailableReason,
} from "@agen-ai/agent-protocol";

export type AgentStructuredOutputCandidate =
  | Readonly<{ kind: "json_text"; text: string }>
  | Readonly<{ kind: "json_value"; value: unknown }>
  | Readonly<{ kind: "unavailable"; reason: AgentStructuredOutputUnavailableReason }>;

export interface CreateAgentStructuredOutputCandidateInput {
  readonly schema: AgentOutputSchema;
  readonly maxOutputBytes?: number;
  readonly candidate: AgentStructuredOutputCandidate;
}

export type AgentStructuredOutputCandidateResult = Exclude<AgentStructuredOutputResult, Readonly<{ kind: "not_requested" }>>;

function freezeJson(value: AgentJsonValue): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

export function validateAgentStructuredOutputCandidate(
  schema: AgentOutputSchema,
  value: unknown,
  maxOutputBytes: number,
): AgentStructuredOutputCandidateResult {
  const parsed = validateAgentOutputValue(schema, value, { maxOutputBytes });
  if (!parsed.success) {
    if (parsed.issues.some((issue) => issue.code === "output_limit_exceeded")) {
      return Object.freeze({ kind: "unavailable", reason: "output_limit_exceeded" });
    }
    if (parsed.issues.some((issue) => issue.code === "invalid_json_data")) {
      return Object.freeze({ kind: "unavailable", reason: "invalid_json" });
    }
    return Object.freeze({ kind: "unavailable", reason: "schema_mismatch", issues: Object.freeze(parsed.issues.map((issue) => Object.freeze({
      ...issue, path: Object.freeze([...issue.path]),
    }))) });
  }
  freezeJson(parsed.data);
  return Object.freeze({ kind: "json", value: parsed.data });
}

export function createAgentStructuredOutputCandidate(
  input: CreateAgentStructuredOutputCandidateInput,
): AgentStructuredOutputCandidateResult {
  const schema = parseAgentOutputSchema(input.schema);
  const maxOutputBytes = input.maxOutputBytes ?? AGENT_OUTPUT_VALUE_BYTES_LIMIT;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > AGENT_OUTPUT_VALUE_BYTES_LIMIT) {
    throw new RangeError("Structured output byte limit must be a positive integer within the portable profile ceiling.");
  }
  const { candidate } = input;
  switch (candidate.kind) {
    case "unavailable":
      if (!AGENT_STRUCTURED_OUTPUT_UNAVAILABLE_REASONS.includes(candidate.reason)) {
        throw new TypeError("Structured output candidate has an unsupported unavailable reason.");
      }
      return Object.freeze({ kind: "unavailable", reason: candidate.reason });
    case "json_text": {
      if (typeof candidate.text !== "string") throw new TypeError("Structured JSON text candidate must contain a string.");
      if (candidate.text.length > AGENT_OUTPUT_RAW_JSON_BYTES_LIMIT
        || Buffer.byteLength(candidate.text, "utf8") > AGENT_OUTPUT_RAW_JSON_BYTES_LIMIT) {
        return Object.freeze({ kind: "unavailable", reason: "output_limit_exceeded" });
      }
      let value: unknown;
      try { value = JSON.parse(candidate.text); }
      catch { return Object.freeze({ kind: "unavailable", reason: "invalid_json" }); }
      return validateAgentStructuredOutputCandidate(schema, value, maxOutputBytes);
    }
    case "json_value":
      return validateAgentStructuredOutputCandidate(schema, candidate.value, maxOutputBytes);
  }
  throw new TypeError("Structured output candidate kind is unsupported.");
}
