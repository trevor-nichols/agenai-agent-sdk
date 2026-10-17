// ------------------------------------------------------------------------------------------------
//                types.ts - Neutral session request producer and consumer contracts
// ------------------------------------------------------------------------------------------------
import type {
  AgentError, AgentSessionAcceptedResponse, AgentSessionDecisionResponse, AgentSessionRequest,
  AgentSessionRequestKind, AgentSessionResponse, AgentSessionFormRequest, AgentSessionPlanReviewRequest,
} from "@agen-ai/agent-protocol";
import type { MaybePromise } from "../foundation.js";
import type { AgentRequestResolutionResult } from "../sessions.js";
import type { AgentPreparedSessionResponse, AgentSessionResponseAttemptId } from "../nativeContinuations/types.js";

export type AgentSessionInteractionOpeningOperation = "create" | "resume" | "branch";
export type AgentSessionHumanWaitKind = "bounded" | "until_withdrawn_or_closed";
export type AgentSessionHumanWaitPolicy = Readonly<{ kind: "bounded" }> | Readonly<{ kind: "until_withdrawn_or_closed" }>;
export interface AgentSessionInteractionMapping {
  readonly openingOperation: AgentSessionInteractionOpeningOperation;
  readonly requestKind: AgentSessionRequestKind;
}
export type AgentSessionInteractionSupport =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "supported"; mappings: readonly [AgentSessionInteractionMapping, ...AgentSessionInteractionMapping[]];
      producerOwnership: "exclusive"; humanWait: readonly [AgentSessionHumanWaitKind, ...AgentSessionHumanWaitKind[]] }>;
export interface AgentSessionInteractionLimits {
  readonly maxRetainedRequests: number;
  readonly maxRetainedBytes: number;
  readonly requestTimeoutMs: number;
  readonly responseTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
}
export type AgentSessionInteractionOptions =
  | Readonly<{ humanWait?: Readonly<{ kind: "bounded" }>; limits?: Partial<AgentSessionInteractionLimits> }>
  | Readonly<{ humanWait: Readonly<{ kind: "until_withdrawn_or_closed" }>; limits?: Partial<Omit<AgentSessionInteractionLimits, "requestTimeoutMs">> }>;
export type AgentSessionInteractionDeadline =
  | Readonly<{ kind: "no_deadline" }>
  | Readonly<{ kind: "deadline"; expiresAt: import("@agen-ai/agent-protocol").AgentIsoDateTime; source: "provider" | "host_policy" }>;
export type AgentSessionResponseInput = AgentSessionResponse & Readonly<{ signal?: AbortSignal }>;
export type AgentSessionDecisionResponseInput = AgentSessionDecisionResponse & Readonly<{ signal?: AbortSignal }>;
export type AgentSessionInteractionTerminal =
  | Readonly<{ kind: "answered"; response: AgentSessionAcceptedResponse }>
  | Readonly<{ kind: "rejected"; error: AgentError }>
  | Readonly<{ kind: "delivery_uncertain"; error: AgentError }>
  | Readonly<{ kind: "withdrawn" }>
  | Readonly<{ kind: "expired"; source: "provider" | "host_policy" }>
  | Readonly<{ kind: "session_closed" }>
  | Readonly<{ kind: "failed"; error: AgentError }>;
export interface AgentSessionInteraction {
  readonly request: AgentSessionRequest;
  readonly deadline: AgentSessionInteractionDeadline;
  readonly signal: AbortSignal;
  readonly terminal: Promise<AgentSessionInteractionTerminal>;
  readonly respond: (input: AgentSessionResponseInput) => Promise<AgentRequestResolutionResult>;
}
export type AgentSessionInteractionHandler = (interaction: AgentSessionInteraction) => MaybePromise<void>;
export type AgentSessionInteractionContext = AgentSessionInteractionOptions & Readonly<{ onRequest: AgentSessionInteractionHandler }>;
export interface AgentProviderDirectSessionInteraction {
  readonly kind: "direct";
  readonly request: AgentSessionRequest;
  readonly signal: AbortSignal;
  readonly terminal: Promise<AgentSessionInteractionTerminal>;
  readonly respond: (input: AgentSessionResponseInput) => Promise<AgentRequestResolutionResult>;
}
export interface AgentProviderPrepareSessionResponseInput {
  readonly response: AgentSessionResponse;
  readonly responseAttemptId: AgentSessionResponseAttemptId;
  readonly signal: AbortSignal;
}
export interface AgentProviderPreparedSessionInteraction {
  readonly kind: "prepared";
  readonly request: AgentSessionFormRequest | AgentSessionPlanReviewRequest;
  readonly signal: AbortSignal;
  readonly terminal: Promise<AgentSessionInteractionTerminal>;
  readonly prepareResponse: (input: AgentProviderPrepareSessionResponseInput) => MaybePromise<AgentPreparedSessionResponse>;
}
export type AgentProviderSessionInteraction = AgentProviderDirectSessionInteraction | AgentProviderPreparedSessionInteraction;
export type AgentProviderSessionInteractionContext = AgentSessionInteractionOptions & Readonly<{
  onRequest: (interaction: AgentProviderSessionInteraction) => MaybePromise<void>;
}>;
export const DEFAULT_AGENT_SESSION_INTERACTION_LIMITS: Readonly<AgentSessionInteractionLimits> = Object.freeze({
  maxRetainedRequests: 8, maxRetainedBytes: 524_288, requestTimeoutMs: 300_000,
  responseTimeoutMs: 30_000, cleanupTimeoutMs: 30_000,
});
