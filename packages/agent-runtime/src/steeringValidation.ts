// ------------------------------------------------------------------------------------------------
//                steeringValidation.ts - Steering receipt validation - Dependencies: agent protocol
// ------------------------------------------------------------------------------------------------

import {
  parseAgentError,
  type AgentProviderKey,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "./contractErrors.js";
import type { AgentTurnSteeringResult } from "./sessions.js";

// ------------------------------------------------------------------------------------------------
//                Receipt Validation
// ------------------------------------------------------------------------------------------------

export function validateAgentTurnSteeringResult(
  candidate: AgentTurnSteeringResult,
  providerKey: AgentProviderKey,
): AgentTurnSteeringResult {
  if (candidate === null || typeof candidate !== "object") {
    return invalidSteeringResult(providerKey);
  }

  if (candidate.status === "delivered") {
    if (Reflect.ownKeys(candidate).length !== 1) {
      return invalidSteeringResult(providerKey);
    }
    return Object.freeze({ status: "delivered" });
  }

  if (
    !["rejected", "delivery_uncertain"].includes(candidate.status) ||
    Reflect.ownKeys(candidate).length !== 2 ||
    !("error" in candidate)
  ) {
    return invalidSteeringResult(providerKey);
  }

  try {
    return Object.freeze({
      status: candidate.status,
      error: parseAgentError(candidate.error),
    });
  } catch {
    return invalidSteeringResult(providerKey);
  }
}

function invalidSteeringResult(providerKey: AgentProviderKey): never {
  return throwAgentProviderContractError(
    providerKey,
    "invalid_operation_result",
    `Provider ${providerKey} returned an invalid steering result.`,
  );
}
