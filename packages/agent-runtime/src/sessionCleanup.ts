// ------------------------------------------------------------------------------------------------
//                sessionCleanup.ts - Exact failed-opening cleanup ownership evidence
// ------------------------------------------------------------------------------------------------

import { AgentProviderSessionCleanupError } from "./contractErrors.js";
import type { AgentProviderSessionContext } from "./sessions.js";

const openingOwners = new WeakMap<AgentProviderSessionCleanupError, object>();

/** Retain provider cleanup for the exact input received by a create/resume/branch port. */
export function createAgentProviderSessionCleanupError(input: ConstructorParameters<typeof AgentProviderSessionCleanupError>[0] & Readonly<{
  openingInput: AgentProviderSessionContext;
}>): AgentProviderSessionCleanupError {
  return associateAgentSessionCleanupError(new AgentProviderSessionCleanupError(input), input.openingInput);
}

export function associateAgentSessionCleanupError<Error extends AgentProviderSessionCleanupError>(error: Error, openingInput: object): Error {
  openingOwners.set(error, openingInput);
  return error;
}

export function isAgentProviderSessionCleanupErrorFor(
  error: unknown,
  openingInput: object,
): error is AgentProviderSessionCleanupError {
  return error instanceof AgentProviderSessionCleanupError && openingOwners.get(error) === openingInput;
}
