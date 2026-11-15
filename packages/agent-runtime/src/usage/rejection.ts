// ------------------------------------------------------------------------------------------------
//                rejection.ts - Internal accounting rejection unwinding - Dependencies: usage types
// ------------------------------------------------------------------------------------------------

import type { AgentTokenUsageErrorCode } from "./types.js";

/** Unwinds one admission attempt; the ledger boundary returns it as rejection data. */
export class TokenUsageRejection extends Error {
  constructor(
    readonly code: AgentTokenUsageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TokenUsageRejection";
  }
}

export function rejectUsage(code: AgentTokenUsageErrorCode, message: string): never {
  throw new TokenUsageRejection(code, message);
}
