// ------------------------------------------------------------------------------------------------
//                outputs.ts - Neutral semantic and technical output union - Dependencies: protocol
// ------------------------------------------------------------------------------------------------

import {
  parseAgentError,
  parseAgentEvent,
  parseAgentIsoDateTime,
  type AgentError,
  type AgentEvent,
  type AgentIsoDateTime,
} from "@agenai/agent-protocol";

import {
  createAgentArtifactCandidate,
  type AgentArtifactCandidate,
  type CreateAgentArtifactCandidateInput,
} from "./artifacts.js";
import {
  createAgentProviderEvidence,
  validateAgentProviderRequestContext,
  validateAgentProviderEvidence,
  type AgentProviderEvidence,
  type AgentProviderRequestContext,
  type CreateAgentProviderEvidenceInput,
} from "./evidence.js";
import {
  parseAgentBoundedText,
  parseAgentProviderTechnicalId,
} from "./foundation.js";
import { containsAgentControlCharacter } from "./internal/controlCharacters.js";

// ------------------------------------------------------------------------------------------------
//                Technical Output Contracts
// ------------------------------------------------------------------------------------------------

export const AGENT_PROCESS_LIFECYCLE_TYPES = [
  "process.started",
  "process.ready",
  "process.exited",
  "process.timeout",
  "process.interrupted",
  "process.error",
] as const;

export type AgentProcessLifecycleType =
  (typeof AGENT_PROCESS_LIFECYCLE_TYPES)[number];

export interface AgentProcessLifecycle {
  readonly type: AgentProcessLifecycleType;
  readonly occurredAt: AgentIsoDateTime;
  readonly message?: string;
  readonly exitCode?: number;
  readonly error?: AgentError;
}

export const AGENT_AUTHENTICATION_STATUSES = [
  "awaiting_user",
  "completed",
  "failed",
  "canceled",
  "expired",
] as const;

export type AgentAuthenticationStatus =
  (typeof AGENT_AUTHENTICATION_STATUSES)[number];

export interface AgentAuthenticationProgress {
  readonly attemptId: string;
  readonly status: AgentAuthenticationStatus;
  readonly occurredAt: AgentIsoDateTime;
  readonly providerLoginId?: string;
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly expiresAt?: AgentIsoDateTime;
  readonly accountLabel?: string;
  readonly error?: AgentError;
}

export interface AgentProviderEventOutput {
  readonly kind: "event";
  readonly event: AgentEvent;
  readonly evidence?: AgentProviderObservationEvidence;
  readonly requestContext?: AgentProviderRequestContext;
}

export interface AgentProviderLifecycleOutput {
  readonly kind: "lifecycle";
  readonly lifecycle: AgentProcessLifecycle;
}

export interface AgentProviderAuthenticationOutput {
  readonly kind: "authentication";
  readonly progress: AgentAuthenticationProgress;
}

export interface AgentProviderArtifactOutput {
  readonly kind: "artifact";
  readonly candidate: AgentArtifactCandidate;
}

export interface AgentProviderEvidenceOutput {
  readonly kind: "evidence";
  readonly evidence: AgentProviderDiagnosticEvidence;
}

export type AgentProviderObservationEvidence = AgentProviderEvidence &
  Readonly<{ category: "provider_event" | "provider_request" }>;

export type AgentProviderDiagnosticEvidence = AgentProviderEvidence &
  Readonly<{ category: "diagnostic" }>;

export type AgentProviderOutput =
  | AgentProviderEventOutput
  | AgentProviderLifecycleOutput
  | AgentProviderAuthenticationOutput
  | AgentProviderArtifactOutput
  | AgentProviderEvidenceOutput;

// ------------------------------------------------------------------------------------------------
//                Output Construction
// ------------------------------------------------------------------------------------------------

const AGENT_AUTHENTICATION_VERIFICATION_URL_MAX_LENGTH = 2_048;
const AGENT_AUTHENTICATION_USER_CODE_MAX_LENGTH = 80;
const AGENT_AUTHENTICATION_ACCOUNT_LABEL_MAX_LENGTH = 4_000;
const AGENT_AUTHENTICATION_VERIFICATION_URL_PATTERN =
  /^[Hh][Tt][Tt][Pp][Ss]:\/\/(?![^/?#]*@)/u;

function authenticationVerificationUrl(value: string): string {
  if (
    value.length > AGENT_AUTHENTICATION_VERIFICATION_URL_MAX_LENGTH ||
    !AGENT_AUTHENTICATION_VERIFICATION_URL_PATTERN.test(value)
  ) {
    throw new TypeError(
      "Authentication verificationUrl must use HTTPS without user information and contain at most 2,048 characters.",
    );
  }
  try {
    new URL(value);
  } catch {
    throw new TypeError("Authentication verificationUrl must be a valid URL.");
  }
  return value;
}

function authenticationText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const text = parseAgentBoundedText(value, field, maxLength);
  if (text !== text.trim() || containsAgentControlCharacter(text)) {
    throw new TypeError(
      `${field} must be canonical text without surrounding whitespace or control characters.`,
    );
  }
  return text;
}

function boundedText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return parseAgentBoundedText(value, field, 4_000);
}

function validatedObservationEvidence(
  input: AgentProviderEvidence,
): AgentProviderObservationEvidence {
  const evidence = validateAgentProviderEvidence(input);
  if (evidence.category === "diagnostic") {
    throw new TypeError(
      "Agent event evidence must describe a provider event or request.",
    );
  }
  return evidence as AgentProviderObservationEvidence;
}

function validatedDiagnosticEvidence(
  input: AgentProviderEvidence,
): AgentProviderDiagnosticEvidence {
  const evidence = validateAgentProviderEvidence(input);
  if (evidence.category !== "diagnostic") {
    throw new TypeError(
      "Standalone agent evidence must be diagnostic.",
    );
  }
  return evidence as AgentProviderDiagnosticEvidence;
}

export interface CreateAgentEventOutputOptions {
  readonly evidence?: AgentProviderObservationEvidence;
  readonly requestContext?: AgentProviderRequestContext;
}

export function createAgentEventOutput(
  input: unknown,
  options: CreateAgentEventOutputOptions = {},
): AgentProviderEventOutput {
  const event = parseAgentEvent(input);
  if (options.requestContext !== undefined && event.type !== "request.opened") {
    throw new TypeError(
      "Provider request context may be attached only to request.opened events.",
    );
  }
  if (
    options.evidence !== undefined &&
    (options.evidence.category === "provider_request") !==
      (event.type === "request.opened")
  ) {
    throw new TypeError(
      "Provider request evidence must be attached exactly to request.opened events.",
    );
  }
  return Object.freeze({
    kind: "event" as const,
    event,
    ...(options.evidence === undefined
      ? {}
      : { evidence: validatedObservationEvidence(options.evidence) }),
    ...(options.requestContext === undefined
      ? {}
      : {
          requestContext: validateAgentProviderRequestContext(
            options.requestContext,
          ),
        }),
  });
}

export function createAgentLifecycleOutput(input: {
  readonly type: AgentProcessLifecycleType;
  readonly occurredAt: string;
  readonly message?: string;
  readonly exitCode?: number;
  readonly error?: AgentError;
}): AgentProviderLifecycleOutput {
  if (!AGENT_PROCESS_LIFECYCLE_TYPES.includes(input.type)) {
    throw new TypeError("Agent process lifecycle type is unsupported.");
  }
  if (
    input.exitCode !== undefined &&
    (!Number.isSafeInteger(input.exitCode) || input.exitCode < -1)
  ) {
    throw new TypeError(
      "Agent process exitCode must be a safe integer of at least -1.",
    );
  }
  return Object.freeze({
    kind: "lifecycle" as const,
    lifecycle: Object.freeze({
      type: input.type,
      occurredAt: parseAgentIsoDateTime(input.occurredAt),
      ...(input.message === undefined
        ? {}
        : { message: boundedText(input.message, "lifecycle message") }),
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(input.error === undefined
        ? {}
        : { error: parseAgentError(input.error) }),
    }),
  });
}

export function createAgentAuthenticationOutput(input: {
  readonly attemptId: string;
  readonly status: AgentAuthenticationStatus;
  readonly occurredAt: string;
  readonly providerLoginId?: string;
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly expiresAt?: string;
  readonly accountLabel?: string;
  readonly error?: AgentError;
}): AgentProviderAuthenticationOutput {
  if (!AGENT_AUTHENTICATION_STATUSES.includes(input.status)) {
    throw new TypeError("Agent authentication status is unsupported.");
  }
  if ((input.status === "failed") !== (input.error !== undefined)) {
    throw new TypeError(
      "Only failed agent authentication progress must include an error.",
    );
  }
  return Object.freeze({
    kind: "authentication" as const,
    progress: Object.freeze({
      attemptId: parseAgentProviderTechnicalId(input.attemptId, "attemptId"),
      status: input.status,
      occurredAt: parseAgentIsoDateTime(input.occurredAt),
      ...(input.providerLoginId === undefined
        ? {}
        : {
            providerLoginId: parseAgentProviderTechnicalId(
              input.providerLoginId,
              "providerLoginId",
            ),
          }),
      ...(input.verificationUrl === undefined
        ? {}
        : {
            verificationUrl: authenticationVerificationUrl(
              input.verificationUrl,
            ),
          }),
      ...(input.userCode === undefined
        ? {}
        : {
            userCode: authenticationText(
              input.userCode,
              "userCode",
              AGENT_AUTHENTICATION_USER_CODE_MAX_LENGTH,
            ),
          }),
      ...(input.expiresAt === undefined
        ? {}
        : { expiresAt: parseAgentIsoDateTime(input.expiresAt) }),
      ...(input.accountLabel === undefined
        ? {}
        : {
            accountLabel: authenticationText(
              input.accountLabel,
              "accountLabel",
              AGENT_AUTHENTICATION_ACCOUNT_LABEL_MAX_LENGTH,
            ),
          }),
      ...(input.error === undefined
        ? {}
        : { error: parseAgentError(input.error) }),
    }),
  });
}

export function createAgentArtifactOutput(
  input: CreateAgentArtifactCandidateInput,
): AgentProviderArtifactOutput {
  return Object.freeze({
    kind: "artifact" as const,
    candidate: createAgentArtifactCandidate(input),
  });
}

export function createAgentEvidenceOutput(
  input: CreateAgentProviderEvidenceInput<"diagnostic">,
): AgentProviderEvidenceOutput {
  return Object.freeze({
    kind: "evidence" as const,
    evidence: validatedDiagnosticEvidence(createAgentProviderEvidence(input)),
  });
}

export function validateAgentProviderOutput(
  input: unknown,
): AgentProviderOutput {
  if (input === null || typeof input !== "object" || !("kind" in input)) {
    throw new TypeError("Agent provider output is invalid.");
  }
  const candidate = input as AgentProviderOutput;
  switch (candidate.kind) {
    case "event":
      return createAgentEventOutput(candidate.event, {
        ...(candidate.evidence === undefined
          ? {}
          : { evidence: candidate.evidence }),
        ...(candidate.requestContext === undefined
          ? {}
          : { requestContext: candidate.requestContext }),
      });
    case "lifecycle":
      return createAgentLifecycleOutput(candidate.lifecycle);
    case "authentication":
      return createAgentAuthenticationOutput(candidate.progress);
    case "artifact":
      return createAgentArtifactOutput(candidate.candidate);
    case "evidence":
      return Object.freeze({
        kind: "evidence" as const,
        evidence: validatedDiagnosticEvidence(candidate.evidence),
      });
    default:
      throw new TypeError("Agent provider output kind is unsupported.");
  }
}
