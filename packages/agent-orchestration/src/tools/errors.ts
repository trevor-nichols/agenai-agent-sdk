// ------------------------------------------------------------------------------------------------
//                errors.ts - Portable sanitized delegation tool failures
// ------------------------------------------------------------------------------------------------

import { AgentProtocolValidationError } from "@agen-ai/agent-protocol";
import type { AgentHostToolResult } from "@agen-ai/agent-runtime";
import { DelegationValidationError } from "../shared/errors.js";
import { DelegationOperationError, type DelegationErrorCode } from "../shared/operational-errors.js";

const messages: Readonly<Record<DelegationErrorCode, string>> = {
  delegation_disabled: "Managed delegation is currently disabled.",
  policy_denied: "Current authority does not permit this managed action.",
  target_unavailable: "The selected managed target is unavailable.",
  stale_target: "The exact target or source revision is stale. Refresh delegation_targets.",
  unsupported_operation: "This managed operation or completion policy is unsupported.",
  capacity_exceeded: "This managed action exceeds a configured capacity or content limit.",
  operation_conflict: "The operation ID conflicts with retained work. Retry only the canonical accepted ID with identical arguments.",
  stale_revision: "The policy, scope, or page revision changed. Refresh the relevant managed view.",
  owner_lost: "The managed executor is unavailable. Inspect retained task history.",
  request_unavailable: "The requested managed task or request is unavailable to this parent.",
  delivery_uncertain: "Delivery is uncertain. Inspect retained task state and do not automatically replay.",
  recovery_required: "The managed task requires host recovery. Do not replay uncertain work.",
  store_failed: "Managed storage is unavailable. Retained work may require host recovery.",
};

export function delegationToolError(code: string, message: string): AgentHostToolResult {
  return Object.freeze({ kind: "error", error: Object.freeze({ code, message, category: "unknown", recovery: Object.freeze({ kind: "unknown" }) }) });
}

export function sanitizeDelegationToolError(error: unknown): AgentHostToolResult {
  if (error instanceof DelegationOperationError) return delegationToolError(error.code, messages[error.code]);
  if (error instanceof DelegationValidationError || error instanceof AgentProtocolValidationError) {
    return delegationToolError("invalid_tool_input", "The managed tool arguments are invalid.");
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return delegationToolError("operation_aborted", "The tool invocation was canceled. Any admitted child work remains independent.");
  }
  return delegationToolError("internal_error", "The managed tool could not return a result. Inspect retained state before retrying an action.");
}
