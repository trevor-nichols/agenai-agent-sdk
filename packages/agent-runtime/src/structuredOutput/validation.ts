// ------------------------------------------------------------------------------------------------
//                validation.ts - Admitted terminal structured-output enforcement - Dependencies: protocol, candidate
// ------------------------------------------------------------------------------------------------

import type { AgentProviderKey, AgentStructuredOutputResult } from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import type { AgentStructuredOutputBinding } from "./admission.js";
import { validateAgentStructuredOutputCandidate } from "./candidate.js";

export function validateAgentStructuredOutputResult(input: Readonly<{
  providerKey: AgentProviderKey;
  binding?: AgentStructuredOutputBinding;
  result: AgentStructuredOutputResult;
}>): AgentStructuredOutputResult {
  const { binding, result } = input;
  if (!binding) {
    if (result.kind !== "not_requested") {
      throwAgentProviderContractError(input.providerKey, "invalid_structured_output",
        "Provider reported structured output for a turn without an admitted schema.");
    }
    return result;
  }
  if (result.kind === "not_requested") {
    throwAgentProviderContractError(input.providerKey, "invalid_structured_output",
      "Provider omitted the admitted structured-output contract.");
  }
  return result.kind === "json"
    ? validateAgentStructuredOutputCandidate(binding.request.schema, result.value, binding.maxOutputBytes)
    : result;
}
