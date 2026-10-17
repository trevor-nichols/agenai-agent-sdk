// ------------------------------------------------------------------------------------------------
//                types.ts - Staged native continuation contracts without serialized authority
// ------------------------------------------------------------------------------------------------
import type { AgentRequestId, AgentSessionId, AgentTurnId } from "@agen-ai/agent-protocol";
import type { MaybePromise } from "../foundation.js";
import type { AgentProviderTurnExecution, AgentRequestResolutionResult } from "../sessions.js";
import type { AgentSessionInteractionOpeningOperation } from "../sessionInteractions/types.js";

declare const agentSessionResponseAttemptIdBrand: unique symbol;
export type AgentSessionResponseAttemptId = string & { readonly [agentSessionResponseAttemptIdBrand]: "AgentSessionResponseAttemptId" };
export type AgentNativeContinuationTiming = "after_open_return" | "before_open_return" | "before_binding";
export interface AgentNativeContinuationMapping {
  readonly openingOperation: AgentSessionInteractionOpeningOperation;
  readonly requestKind: "form" | "plan_review";
  readonly timing: AgentNativeContinuationTiming;
}
export type AgentNativeContinuationSupport =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "supported"; mappings: readonly [AgentNativeContinuationMapping, ...AgentNativeContinuationMapping[]]; producerOwnership: "exclusive" }>;
export type AgentNativeContinuationOutcome = Readonly<{ kind: "started" }> | Readonly<{ kind: "not_started" }>;
export interface AgentPreparedSessionResponseControl {
  readonly dispatch: () => Promise<AgentRequestResolutionResult>;
  readonly cancel: () => Promise<void>;
}
export type AgentPreparedSessionResponse =
  | (AgentPreparedSessionResponseControl & Readonly<{ kind: "no_continuation" }>)
  | (AgentPreparedSessionResponseControl & Readonly<{ kind: "native_continuation";
      createExecution: (input: Readonly<{ turnId: AgentTurnId; signal: AbortSignal }>) => AgentProviderTurnExecution;
      outcome: Promise<AgentNativeContinuationOutcome> }>);
export interface AgentNativeContinuation {
  readonly sessionId: AgentSessionId;
  readonly requestId: AgentRequestId;
  readonly responseAttemptId: AgentSessionResponseAttemptId;
  readonly execution: AgentProviderTurnExecution;
  readonly outcome: Promise<AgentNativeContinuationOutcome>;
}
export interface AgentNativeContinuationContext {
  readonly onExecution: (continuation: AgentNativeContinuation) => MaybePromise<void>;
}
