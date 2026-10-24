import type { AgentProviderKey, AgentStructuredOutputUnavailableReason, ValidationIssue } from "@agen-ai/agent-protocol";

import { AgentProviderSessionCleanupError } from "../contractErrors.js";
import type { AgentRequestResolutionResult } from "../sessions.js";
import type { AgentGeneratedObject } from "./types.js";

export const AGENT_GENERATION_ERROR_CODES = [
  "unsupported", "interaction_required", "generation_failed", "decoding_failed",
  "observer_failed", "request_failed", "timeout",
] as const;

export type AgentGenerationErrorCode = (typeof AGENT_GENERATION_ERROR_CODES)[number];

export class AgentGenerationError extends Error {
  readonly reason?: AgentStructuredOutputUnavailableReason;
  readonly issues?: readonly ValidationIssue[];
  readonly receipt?: AgentRequestResolutionResult;

  constructor(readonly code: AgentGenerationErrorCode, message: string, options?: ErrorOptions & Readonly<{
    reason?: AgentStructuredOutputUnavailableReason;
    issues?: readonly ValidationIssue[];
    receipt?: AgentRequestResolutionResult;
  }>) {
    super(message, options);
    this.name = "AgentGenerationError";
    this.reason = options?.reason;
    this.issues = options?.issues;
    this.receipt = options?.receipt;
  }
}

export class AgentGenerationCleanupError<T = unknown> extends AgentProviderSessionCleanupError {
  readonly primaryError?: unknown;
  readonly result?: AgentGeneratedObject<T>;

  constructor(input: Readonly<{
    providerKey: AgentProviderKey;
    errors: readonly unknown[];
    retryCleanup: () => Promise<void>;
    primaryError?: unknown;
    result?: AgentGeneratedObject<T>;
  }>) {
    super(input);
    this.name = "AgentGenerationCleanupError";
    this.message = "Object generation cleanup remains incomplete.";
    this.primaryError = input.primaryError;
    this.result = input.result;
  }
}
