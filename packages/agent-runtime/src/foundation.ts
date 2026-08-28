// ------------------------------------------------------------------------------------------------
//                foundation.ts - Runtime primitives and abort semantics - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import { AGENT_PROTOCOL_ID_MAX_LENGTH } from "@agenai/agent-protocol";

import { containsAgentControlCharacter } from "./internal/controlCharacters.js";

// ------------------------------------------------------------------------------------------------
//                Package and Promise Contracts
// ------------------------------------------------------------------------------------------------

export const AGENT_RUNTIME_PACKAGE_NAME = "@agenai/agent-runtime" as const;

export type MaybePromise<Value> = Value | Promise<Value>;

export function parseAgentBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError("Agent text maxLength must be a positive integer.");
  }
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength
  ) {
    throw new TypeError(`${field} must be a bounded non-empty string.`);
  }
  return value;
}

export function parseAgentCanonicalText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const text = parseAgentBoundedText(value, field, maxLength);
  if (text !== text.trim() || containsAgentControlCharacter(text)) {
    throw new TypeError(`${field} must be canonical text.`);
  }
  return text;
}

export function parseAgentProviderTechnicalId(
  value: unknown,
  field = "provider technical identifier",
): string {
  return parseAgentCanonicalText(value, field, AGENT_PROTOCOL_ID_MAX_LENGTH);
}

// ------------------------------------------------------------------------------------------------
//                Abort Semantics
// ------------------------------------------------------------------------------------------------

export function throwIfAgentOperationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The agent operation was aborted.", "AbortError");
}

export function isAgentOperationAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
