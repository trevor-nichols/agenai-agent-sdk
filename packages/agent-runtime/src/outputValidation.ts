// ------------------------------------------------------------------------------------------------
//                outputValidation.ts - Capability-scoped provider output validation - Dependencies: protocol, outputs
// ------------------------------------------------------------------------------------------------

import {
  parseAgentError,
  type AgentCapabilities,
  type AgentContentStreamKind,
  type AgentEvent,
  type AgentItemKind,
  type AgentProviderKey,
  type AgentSessionId,
  type AgentTurnId,
} from "@agen-ai/agent-protocol";

import { throwAgentProviderContractError } from "./contractErrors.js";
import {
  validateAgentProviderOutput,
  type AgentProviderOutput,
} from "./outputs.js";
import type { AgentProviderOperationResult } from "./sessions.js";

// ------------------------------------------------------------------------------------------------
//                Validation Context
// ------------------------------------------------------------------------------------------------

export interface AgentProviderOutputValidationContext {
  readonly capabilities: AgentCapabilities;
  readonly providerKey: AgentProviderKey;
  readonly sessionId?: AgentSessionId;
  readonly turnId?: AgentTurnId;
  readonly authenticationAttemptId?: string;
}

function unsupportedCapabilitySemantic(value: never): never {
  throw new TypeError(
    `Unsupported Agent Protocol capability semantic: ${String(value)}.`,
  );
}

function isItemKindCapabilitySupported(
  capabilities: AgentCapabilities,
  itemKind: AgentItemKind,
): boolean {
  switch (itemKind) {
    case "plan":
      return capabilities.output.plans;
    case "file_change":
      return capabilities.output.fileChanges === "structured";
    case "mcp_tool_call":
      return capabilities.interactionExtensions.mcp;
    case "collaboration_tool_call":
      return capabilities.interactionExtensions.subagents;
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "command_execution":
    case "dynamic_tool_call":
    case "web_search":
    case "browser_action":
    case "computer_action":
    case "image_view":
    case "review":
    case "context_compaction":
    case "unknown":
      return true;
  }
  return unsupportedCapabilitySemantic(itemKind);
}

function isContentStreamCapabilitySupported(
  capabilities: AgentCapabilities,
  streamKind: AgentContentStreamKind,
): boolean {
  switch (streamKind) {
    case "plan_text":
      return capabilities.output.plans;
    case "file_change_output":
      return capabilities.output.fileChanges === "structured";
    case "assistant_text":
    case "reasoning_text":
    case "reasoning_summary":
    case "command_output":
    case "unknown":
      return true;
  }
  return unsupportedCapabilitySemantic(streamKind);
}

function isEventCapabilitySupported(
  capabilities: AgentCapabilities,
  event: AgentEvent,
): boolean {
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed":
      return isItemKindCapabilitySupported(capabilities, event.payload.itemKind);
    case "content.delta":
      return capabilities.output.streaming
        && isContentStreamCapabilitySupported(
          capabilities,
          event.payload.streamKind,
        );
    case "turn.plan.updated":
    case "turn.plan.proposed":
      return capabilities.output.plans;
    case "turn.diff.updated":
      return capabilities.output.fileChanges !== "none";
    case "artifact.referenced":
      return capabilities.output.artifactKinds.includes(
        event.payload.artifact.kind,
      );
    case "request.opened":
      return event.payload.request.requestKind === "approval"
        ? capabilities.requests.approval
        : capabilities.requests.elicitation.kind === "structured"
          || (capabilities.requests.elicitation.kind === "text"
            && event.payload.request.fields.every(
              (field) => field.kind === "text",
            ));
    case "turn.started":
    case "turn.state_changed":
    case "turn.completed":
    case "progress.updated":
    case "runtime.warning":
    case "runtime.error":
    case "provider.diagnostic":
      return true;
  }
  return unsupportedCapabilitySemantic(event);
}

function assertOutputCapability(
  context: AgentProviderOutputValidationContext,
  output: AgentProviderOutput,
): void {
  if (output.kind === "artifact") {
    if (
      context.capabilities.output.artifactKinds.includes(
        output.candidate.descriptor.kind,
      )
    ) {
      return;
    }
    throwAgentProviderContractError(
      context.providerKey,
      "output_capability_mismatch",
      `Provider ${context.providerKey} emitted an artifact without advertising its kind.`,
    );
  }
  if (
    output.kind === "event"
    && !isEventCapabilitySupported(context.capabilities, output.event)
  ) {
    throwAgentProviderContractError(
      context.providerKey,
      "output_capability_mismatch",
      `Provider ${context.providerKey} emitted ${output.event.type} without advertising support.`,
    );
  }
}

// ------------------------------------------------------------------------------------------------
//                Output and Operation Results
// ------------------------------------------------------------------------------------------------

export function validateAgentProviderOutputForContext(
  candidate: AgentProviderOutput,
  context: AgentProviderOutputValidationContext,
): AgentProviderOutput {
  const output = validateAgentProviderOutput(candidate);
  if (output.kind === "event" && context.sessionId !== undefined) {
    if (output.event.sessionId !== context.sessionId) {
      throwAgentProviderContractError(
        context.providerKey,
        "output_session_mismatch",
        `Provider ${context.providerKey} emitted an event for another session.`,
      );
    }
    if (
      context.turnId !== undefined &&
      output.event.turnId !== undefined &&
      output.event.turnId !== context.turnId
    ) {
      throwAgentProviderContractError(
        context.providerKey,
        "output_turn_mismatch",
        `Provider ${context.providerKey} emitted an event for another turn.`,
      );
    }
  }
  if (
    output.kind === "authentication" &&
    output.progress.attemptId !== context.authenticationAttemptId
  ) {
    throwAgentProviderContractError(
      context.providerKey,
      "output_authentication_attempt_mismatch",
      `Provider ${context.providerKey} emitted authentication progress for another attempt.`,
    );
  }
  assertOutputCapability(context, output);
  return output;
}

export function validateAgentProviderOperationResult(
  candidate: AgentProviderOperationResult,
  context: AgentProviderOutputValidationContext,
): AgentProviderOperationResult {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    ![
      "accepted",
      "completed",
      "failed",
      "canceled",
      "waiting_for_request",
    ].includes(candidate.status) ||
    (candidate.outputs !== undefined && !Array.isArray(candidate.outputs))
  ) {
    throwAgentProviderContractError(
      context.providerKey,
      "invalid_operation_result",
      `Provider ${context.providerKey} returned an invalid operation result.`,
    );
  }
  if ((candidate.status === "failed") !== (candidate.error !== undefined)) {
    throwAgentProviderContractError(
      context.providerKey,
      "invalid_operation_result",
      "Only failed provider operation results must include an error.",
    );
  }
  return Object.freeze({
    status: candidate.status,
    ...(candidate.outputs === undefined
      ? {}
      : {
          outputs: Object.freeze(
            candidate.outputs.map((output) =>
              validateAgentProviderOutputForContext(output, context),
            ),
          ),
        }),
    ...(candidate.error === undefined
      ? {}
      : { error: parseAgentError(candidate.error) }),
  });
}
