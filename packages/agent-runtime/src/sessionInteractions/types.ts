import type {
  AgentError,
  AgentSessionDecisionChoiceId,
  AgentSessionDecisionRequest,
  AgentSessionDecisionResponse,
} from "@agen-ai/agent-protocol";
import type { MaybePromise } from "../foundation.js";
import type { AgentRequestResolutionResult } from "../sessions.js";

export type AgentSessionInteractionOpeningOperation = "create" | "resume" | "branch";

export type AgentSessionInteractionSupport =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "supported";
      openingOperations: readonly [AgentSessionInteractionOpeningOperation, ...AgentSessionInteractionOpeningOperation[]];
      requestKinds: readonly ["decision"];
      producerOwnership: "exclusive";
    }>;

export interface AgentSessionInteractionLimits {
  readonly maxRetainedRequests: number;
  readonly maxRetainedBytes: number;
  readonly requestTimeoutMs: number;
  readonly responseTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
}

export interface AgentSessionDecisionResponseInput extends AgentSessionDecisionResponse {
  readonly signal?: AbortSignal;
}

export type AgentSessionInteractionTerminal =
  | Readonly<{ kind: "answered"; choiceId: AgentSessionDecisionChoiceId }>
  | Readonly<{ kind: "rejected"; error: AgentError }>
  | Readonly<{ kind: "delivery_uncertain"; error: AgentError }>
  | Readonly<{ kind: "withdrawn" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "session_closed" }>
  | Readonly<{ kind: "failed"; error: AgentError }>;

export interface AgentSessionInteraction {
  readonly request: AgentSessionDecisionRequest;
  readonly signal: AbortSignal;
  readonly terminal: Promise<AgentSessionInteractionTerminal>;
  readonly respond: (input: AgentSessionDecisionResponseInput) => Promise<AgentRequestResolutionResult>;
}

export type AgentSessionInteractionHandler = (interaction: AgentSessionInteraction) => MaybePromise<void>;

export interface AgentSessionInteractionContext {
  readonly onRequest: AgentSessionInteractionHandler;
  readonly limits?: Partial<AgentSessionInteractionLimits>;
}

export const DEFAULT_AGENT_SESSION_INTERACTION_LIMITS: Readonly<AgentSessionInteractionLimits> = Object.freeze({
  maxRetainedRequests: 8,
  maxRetainedBytes: 524_288,
  requestTimeoutMs: 300_000,
  responseTimeoutMs: 30_000,
  cleanupTimeoutMs: 30_000,
});
