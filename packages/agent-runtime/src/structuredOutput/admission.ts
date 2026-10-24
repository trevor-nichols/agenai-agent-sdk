// ------------------------------------------------------------------------------------------------
//                admission.ts - Immutable structured-output request admission - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import {
  AgentProtocolValidationError,
  agentProtocolSerializedJsonBytes,
  parseAgentOutputSchema,
  type AgentCapabilities,
  type AgentStructuredOutputRequest,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";

export interface AgentStructuredOutputBinding {
  readonly request: AgentStructuredOutputRequest;
  readonly maxOutputBytes: number;
}

function parseOutputRequest(input: unknown, maxOutputBytes: number): AgentStructuredOutputRequest {
  const invalid = (): never => {
    throw new AgentProtocolValidationError([{
      code: "invalid_structured_output_request",
      message: "Structured output must be a plain json_schema request with only kind and schema data properties.",
      path: ["output"],
    }]);
  };
  if (input === null || typeof input !== "object") return invalid();
  let kind: unknown;
  let schema: unknown;
  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    if ((prototype !== Object.prototype && prototype !== null)
      || !hasExactOwnKeys(input, ["kind", "schema"])) return invalid();
    const kindDescriptor = Object.getOwnPropertyDescriptor(input, "kind");
    const schemaDescriptor = Object.getOwnPropertyDescriptor(input, "schema");
    if (!kindDescriptor || !("value" in kindDescriptor) || !kindDescriptor.enumerable
      || !schemaDescriptor || !("value" in schemaDescriptor) || !schemaDescriptor.enumerable) return invalid();
    kind = kindDescriptor.value;
    schema = schemaDescriptor.value;
  } catch (error) {
    if (error instanceof AgentProtocolValidationError) throw error;
    return invalid();
  }
  if (kind !== "json_schema") return invalid();
  return Object.freeze({ kind, schema: parseAgentOutputSchema(schema, { maxOutputBytes }) });
}

function admitRequest(capabilities: AgentCapabilities, output: unknown): AgentStructuredOutputBinding {
  const capability = capabilities.turns.structuredOutput;
  if (capability.kind === "unsupported") {
    throwAgentProviderContractError(capabilities.providerKey, "structured_output_unsupported",
      "Provider does not support structured output.");
  }
  const request = parseOutputRequest(output, capability.maxOutputBytes);
  if (agentProtocolSerializedJsonBytes(request.schema) > capability.maxSchemaBytes) {
    throwAgentProviderContractError(capabilities.providerKey, "invalid_structured_output",
      "Structured output schema exceeds the provider's advertised byte limit.");
  }
  return Object.freeze({ request, maxOutputBytes: capability.maxOutputBytes });
}

export function admitAgentStructuredOutputOpening(input: Readonly<{
  capabilities: AgentCapabilities;
  operation: "create" | "resume" | "branch";
  output: unknown;
}>): AgentStructuredOutputBinding | undefined {
  if (input.output === undefined) return undefined;
  const { capabilities } = input;
  if (input.operation !== "create") {
    throwAgentProviderContractError(capabilities.providerKey, "structured_output_unsupported",
      "Structured output cannot be restored through resume or branch.");
  }
  const capability = capabilities.turns.structuredOutput;
  if (capability.kind === "supported" && capability.scope !== "session") {
    throwAgentProviderContractError(capabilities.providerKey, "structured_output_scope_mismatch",
      "Provider accepts structured output only when starting a turn.");
  }
  return admitRequest(capabilities, input.output);
}

export function admitAgentStructuredOutputTurn(input: Readonly<{
  capabilities: AgentCapabilities;
  binding?: AgentStructuredOutputBinding;
  output: unknown;
}>): AgentStructuredOutputBinding | undefined {
  if (input.output === undefined) return input.binding;
  const { capabilities } = input;
  const capability = capabilities.turns.structuredOutput;
  if (input.binding || (capability.kind === "supported" && capability.scope !== "turn")) {
    throwAgentProviderContractError(capabilities.providerKey, "structured_output_scope_mismatch",
      "Session-scoped structured output cannot be overridden or supplied on a turn.");
  }
  return admitRequest(capabilities, input.output);
}
