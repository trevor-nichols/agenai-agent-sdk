// ------------------------------------------------------------------------------------------------
//                sessions.ts - Provider adapter and session SPI - Dependencies: agent protocol
// ------------------------------------------------------------------------------------------------

import type {
  AgentAuthenticationFlow,
  AgentError,
  AgentRequestResolution,
  AgentSessionBinding,
  AgentSessionBranchSource,
  AgentSessionConfiguration,
  AgentSessionId,
  AgentTurnId,
  AgentTurnInputContent,
  AgentTurnInteractionMode,
  AgentTurnInputPart,
  AgentTurnInterruptionReason,
} from "@agenai/agent-protocol";

import type { MaybePromise } from "./foundation.js";
import type { AgentProviderOutput } from "./outputs.js";

// ------------------------------------------------------------------------------------------------
//                Session Open Contracts
// ------------------------------------------------------------------------------------------------

export interface AgentProviderSessionContext {
  readonly sessionId: AgentSessionId;
  readonly workingDirectory: string;
  readonly configuration: AgentSessionConfiguration;
  readonly signal?: AbortSignal;
}

export type AgentSessionBindingCreatedObserver = (
  binding: AgentSessionBinding,
) => void;

export interface AgentProviderCreateSessionInput
  extends AgentProviderSessionContext {
  readonly onBindingCreated: AgentSessionBindingCreatedObserver;
}

export interface AgentProviderResumeSessionInput
  extends AgentProviderSessionContext {
  readonly binding: AgentSessionBinding;
}

export interface AgentProviderBranchSessionInput
  extends AgentProviderSessionContext {
  readonly source: AgentSessionBranchSource;
  readonly onBindingCreated: AgentSessionBindingCreatedObserver;
}

// ------------------------------------------------------------------------------------------------
//                Session Operation Contracts
// ------------------------------------------------------------------------------------------------

export type AgentProviderExecutionStartedObserver = () => void;

export interface AgentProviderRunTurnInput {
  readonly turnId: AgentTurnId;
  readonly interactionMode: AgentTurnInteractionMode;
  readonly parts: readonly AgentTurnInputPart[];
  readonly summary?: string;
  readonly deadlineAt?: string;
  readonly signal?: AbortSignal;
  readonly onProviderExecutionStarted?: AgentProviderExecutionStartedObserver;
}

export interface AgentProviderResolveRequestInput {
  readonly resolution: AgentRequestResolution;
  readonly signal?: AbortSignal;
}

export interface AgentProviderInterruptTurnInput {
  readonly turnId: AgentTurnId;
  readonly reason: AgentTurnInterruptionReason;
  readonly requestedAt?: string;
  readonly signal?: AbortSignal;
}

export interface AgentProviderApplyConfigurationInput {
  readonly configuration: AgentSessionConfiguration;
  readonly signal?: AbortSignal;
}

export interface AgentProviderSteerTurnInput extends AgentTurnInputContent {
  readonly turnId: AgentTurnId;
  readonly signal?: AbortSignal;
}

export type AgentProviderSessionCloseReason =
  | "idle"
  | "shutdown"
  | "replaced"
  | "contract_rejected"
  | "error"
  | "other";

export interface AgentProviderCloseSessionInput {
  readonly reason?: AgentProviderSessionCloseReason;
  readonly signal?: AbortSignal;
}

export type AgentProviderOperationStatus =
  | "accepted"
  | "completed"
  | "failed"
  | "canceled"
  | "waiting_for_request";

export interface AgentProviderOperationResult {
  readonly status: AgentProviderOperationStatus;
  readonly outputs?: readonly AgentProviderOutput[];
  readonly error?: AgentError;
}

export type AgentTurnSteeringResult =
  | Readonly<{ status: "delivered" }>
  | Readonly<{ status: "rejected"; error: AgentError }>
  | Readonly<{ status: "delivery_uncertain"; error: AgentError }>;

// ------------------------------------------------------------------------------------------------
//                Capability-Matched Operation Ports
// ------------------------------------------------------------------------------------------------

export type AgentTurnInterruption =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "supported";
      interruptTurn: (
        input: AgentProviderInterruptTurnInput,
      ) => MaybePromise<AgentProviderOperationResult>;
    }>;

export type AgentTurnSteering =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "supported";
      steerTurn: (
        input: AgentProviderSteerTurnInput,
      ) => MaybePromise<AgentTurnSteeringResult>;
    }>;

export type AgentSessionConfigurationControl =
  | Readonly<{ kind: "managed" }>
  | Readonly<{
      kind: "selectable";
      applyConfiguration: (
        input: AgentProviderApplyConfigurationInput,
      ) => MaybePromise<AgentProviderOperationResult>;
    }>;

export interface AgentProviderSession {
  readonly binding: AgentSessionBinding;
  readonly runTurn: (
    input: AgentProviderRunTurnInput,
  ) => AsyncIterable<AgentProviderOutput>;
  readonly resolveRequest: (
    input: AgentProviderResolveRequestInput,
  ) => AsyncIterable<AgentProviderOutput>;
  readonly interruption: AgentTurnInterruption;
  readonly steering: AgentTurnSteering;
  readonly configuration: AgentSessionConfigurationControl;
  readonly close: (input: AgentProviderCloseSessionInput) => MaybePromise<void>;
}

// ------------------------------------------------------------------------------------------------
//                Adapter and Authentication Contracts
// ------------------------------------------------------------------------------------------------

export type AgentSessionResumption =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "supported";
      resumeSession: (
        input: AgentProviderResumeSessionInput,
      ) => MaybePromise<AgentProviderSession>;
    }>;

export type AgentSessionBranching =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "through_turn";
      branchSession: (
        input: AgentProviderBranchSessionInput,
      ) => MaybePromise<AgentProviderSession>;
    }>;

export interface AgentProviderAuthenticationStartInput {
  readonly attemptId: string;
  readonly flow: AgentAuthenticationFlow;
  readonly deadlineAt?: string;
  readonly signal?: AbortSignal;
}

export interface AgentProviderAuthenticationCancelInput {
  readonly attemptId: string;
  readonly providerLoginId?: string;
  readonly reason?: "user_requested" | "timeout" | "shutdown" | "other";
  readonly signal?: AbortSignal;
}

export type AgentProviderAuthentication =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "supported";
      start: (
        input: AgentProviderAuthenticationStartInput,
      ) => AsyncIterable<AgentProviderOutput>;
      cancel: (
        input: AgentProviderAuthenticationCancelInput,
      ) => MaybePromise<AgentProviderOperationResult>;
    }>;

export interface AgentProviderAdapter {
  readonly createSession: (
    input: AgentProviderCreateSessionInput,
  ) => MaybePromise<AgentProviderSession>;
  readonly resumption: AgentSessionResumption;
  readonly branching: AgentSessionBranching;
  readonly authentication: AgentProviderAuthentication;
}
