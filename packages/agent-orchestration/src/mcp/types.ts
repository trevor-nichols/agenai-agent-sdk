// ------------------------------------------------------------------------------------------------
//                types.ts - Explicit session-local MCP transport ownership
// ------------------------------------------------------------------------------------------------

import type { AgentSessionHostBinding } from "@agen-ai/agent-runtime";

export interface DelegationMcpServerDefinition {
  readonly name: "agenai_delegation";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface DelegationMcpBridge {
  /** Session-local connection data. The authorization header must never be logged or persisted. */
  readonly server: DelegationMcpServerDefinition;
  /** Stops and drains transport producers. The runtime owner separately releases the host binding. */
  release(): Promise<void>;
}

export interface StartDelegationMcpBridgeOptions {
  readonly binding: AgentSessionHostBinding;
  /** Cancels startup only; successful startup transfers transport cleanup to release(). */
  readonly signal?: AbortSignal;
  /** Handler response budget, default 60 seconds. Set above any larger client wait budget. */
  readonly requestTimeoutMs?: number;
  /** Finite drain deadline; a nonquiescent callback retains cleanup responsibility for retry. */
  readonly shutdownTimeoutMs?: number;
}
