// ------------------------------------------------------------------------------------------------
//                receipts.ts - Output-free request and interruption receipt validation
// ------------------------------------------------------------------------------------------------

import { parseAgentError, type AgentProviderKey } from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "../contractErrors.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";
import { validateAgentProviderOperationResult, type AgentProviderOutputValidationContext } from "../outputValidation.js";
import type { AgentProviderTurnInterruptionResult, AgentRequestResolutionResult } from "../sessions.js";

export function validateAgentProviderTurnInterruptionResult(
  candidate: AgentProviderTurnInterruptionResult,
  context: AgentProviderOutputValidationContext,
): AgentProviderTurnInterruptionResult {
  if (candidate === null || typeof candidate !== "object"
    || !hasExactOwnKeys(candidate, candidate.status === "failed" ? ["status", "error"] : ["status"])) {
    return throwAgentProviderContractError(context.providerKey, "invalid_operation_result",
      "Provider interruption must return an output-free operation receipt.");
  }
  const result = validateAgentProviderOperationResult(candidate, context);
  return Object.freeze({ status: result.status, ...(result.error === undefined ? {} : { error: result.error }) });
}

export function validateAgentRequestResolutionResult(
  candidate: unknown,
  providerKey: AgentProviderKey,
): AgentRequestResolutionResult {
  const invalid = (): never => throwAgentProviderContractError(
    providerKey, "invalid_operation_result", "Provider returned an invalid request delivery receipt.",
  );
  if (candidate === null || typeof candidate !== "object" || !("status" in candidate)) return invalid();
  if (candidate.status === "delivered" && hasExactOwnKeys(candidate, ["status"])) {
    return Object.freeze({ status: "delivered" });
  }
  if (!("error" in candidate)) return invalid();
  const error = parseAgentError(candidate.error);
  if (candidate.status === "delivery_uncertain" && hasExactOwnKeys(candidate, ["status", "error"])) {
    return Object.freeze({ status: "delivery_uncertain", error });
  }
  if (candidate.status === "rejected" && hasExactOwnKeys(candidate, ["status", "requestState", "error"])
    && "requestState" in candidate
    && (candidate.requestState === "pending" || candidate.requestState === "unavailable")) {
    return Object.freeze({ status: "rejected", requestState: candidate.requestState, error });
  }
  return invalid();
}
