// ------------------------------------------------------------------------------------------------
//                contractErrors.ts - Stable provider SPI contract failures - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import type { AgentProviderKey } from "@agen-ai/agent-protocol";

// ------------------------------------------------------------------------------------------------
//                Contract Error Taxonomy
// ------------------------------------------------------------------------------------------------

export const AGENT_PROVIDER_CONTRACT_ERROR_CODES = [
  "capability_port_mismatch",
  "invalid_adapter",
  "invalid_session",
  "invalid_binding",
  "binding_callback_missing",
  "binding_callback_repeated",
  "binding_callback_mismatch",
  "resume_binding_mismatch",
  "branch_binding_reused",
  "session_closed",
  "session_unusable",
  "concurrent_turn",
  "active_turn_mismatch",
  "invalid_operation_result",
  "output_session_mismatch",
  "output_turn_mismatch",
  "output_authentication_attempt_mismatch",
  "output_capability_mismatch",
  "input_capability_mismatch",
  "invalid_turn_sequence",
  "request_resolution_mismatch",
  "configuration_key_unsupported",
  "configuration_value_unsupported",
  "request_pending",
] as const;

export type AgentProviderContractErrorCode =
  (typeof AGENT_PROVIDER_CONTRACT_ERROR_CODES)[number];

export type AgentProviderDelegatedOperation = "steer_turn";

export class AgentProviderContractError extends Error {
  constructor(
    readonly providerKey: AgentProviderKey,
    readonly code: AgentProviderContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentProviderContractError";
  }
}

export class AgentProviderDelegatedOperationError extends Error {
  readonly providerExecution = "started" as const;

  constructor(
    readonly providerKey: AgentProviderKey,
    readonly operation: AgentProviderDelegatedOperation,
    cause: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : `Provider ${providerKey} failed after ${operation} delegation.`,
      { cause },
    );
    this.name = "AgentProviderDelegatedOperationError";
  }
}

export function throwAgentProviderContractError(
  providerKey: AgentProviderKey,
  code: AgentProviderContractErrorCode,
  message: string,
): never {
  throw new AgentProviderContractError(providerKey, code, message);
}
