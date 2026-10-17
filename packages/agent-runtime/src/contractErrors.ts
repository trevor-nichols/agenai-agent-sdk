// ------------------------------------------------------------------------------------------------
//                contractErrors.ts - Stable provider SPI contract failures - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import type { AgentProviderKey } from "@agen-ai/agent-protocol";
import type { MaybePromise } from "./foundation.js";

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
  "invalid_inventory",
  "invalid_collaboration_transition",
  "input_operation_mismatch",
  "output_session_mismatch",
  "output_turn_mismatch",
  "output_authentication_attempt_mismatch",
  "output_operation_mismatch",
  "output_collaboration_mismatch",
  "output_resource_mismatch",
  "output_capability_mismatch",
  "input_capability_mismatch",
  "invalid_turn_sequence",
  "request_resolution_mismatch",
  "request_identity_limit_exceeded",
  "configuration_key_unsupported",
  "configuration_value_unsupported",
  "request_pending",
  "invalid_host_binding",
  "host_binding_unsupported",
  "host_binding_reused",
  "host_binding_closed",
  "host_tool_name_conflict",
  "host_tool_input_invalid",
  "host_tool_result_invalid",
  "host_tool_capacity_exhausted",
  "invalid_session_interaction",
  "session_interactions_unsupported",
  "native_continuations_unsupported",
  "native_continuation_preparation_failed",
  "native_continuation_reader_not_ready",
  "native_continuation_limit_exceeded",
  "invalid_native_continuation",
] as const;

export type AgentProviderContractErrorCode =
  (typeof AGENT_PROVIDER_CONTRACT_ERROR_CODES)[number];

export type AgentProviderDelegatedOperation =
  | "resolve_request"
  | "steer_turn"
  | "invoke_operation"
  | "apply_configuration"
  | "spawn_collaboration"
  | "control_collaboration";

export class AgentProviderContractError extends Error {
  constructor(
    readonly providerKey: AgentProviderKey,
    readonly code: AgentProviderContractErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentProviderContractError";
  }
}

export class AgentProviderSessionCleanupError extends AggregateError {
  readonly providerKey: AgentProviderKey;
  readonly retryCleanup: () => Promise<void>;

  constructor(input: Readonly<{
    providerKey: AgentProviderKey;
    errors: readonly unknown[];
    retryCleanup: () => MaybePromise<void>;
  }>) {
    super(input.errors, "Provider session cleanup remains incomplete.");
    this.name = "AgentProviderSessionCleanupError";
    this.providerKey = input.providerKey;
    let completed = false;
    let pending: Promise<void> | null = null;
    this.retryCleanup = () => {
      if (completed) return Promise.resolve();
      if (pending) return pending;
      pending = Promise.resolve().then(() => input.retryCleanup()).then(() => {
        completed = true;
      }).finally(() => { pending = null; });
      return pending;
    };
  }
}

export class AgentProviderHostBindingCleanupError extends AgentProviderSessionCleanupError {
  constructor(input: ConstructorParameters<typeof AgentProviderSessionCleanupError>[0]) {
    super(input);
    this.name = "AgentProviderHostBindingCleanupError";
    this.message = "Provider session host binding cleanup remains incomplete.";
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
