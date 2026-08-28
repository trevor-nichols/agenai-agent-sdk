// ------------------------------------------------------------------------------------------------
//                readiness.ts - Technical provider readiness - Dependencies: protocol, evidence
// ------------------------------------------------------------------------------------------------

import {
  parseAgentError,
  parseAgentIsoDateTime,
  type AgentError,
  type AgentIsoDateTime,
} from "@agenai/agent-protocol";

import {
  createBoundedAgentProviderData,
  validateBoundedAgentProviderData,
  type BoundedAgentProviderData,
} from "./evidence.js";
import { parseAgentCanonicalText } from "./foundation.js";

// ------------------------------------------------------------------------------------------------
//                Readiness Contracts
// ------------------------------------------------------------------------------------------------

export const AGENT_PROVIDER_READINESS_STATUSES = [
  "ready",
  "missing_executable",
  "missing_credentials",
  "unsupported_version",
  "unavailable",
] as const;

export type AgentProviderReadinessStatus =
  (typeof AGENT_PROVIDER_READINESS_STATUSES)[number];

export interface AgentProviderReadiness {
  readonly status: AgentProviderReadinessStatus;
  readonly checkedAt: AgentIsoDateTime;
  readonly version?: string;
  readonly reason?: AgentError;
  readonly diagnostics: BoundedAgentProviderData;
}

export interface CreateAgentProviderReadinessInput {
  readonly status: AgentProviderReadinessStatus;
  readonly checkedAt: string;
  readonly version?: string;
  readonly reason?: AgentError;
  readonly diagnostics?: unknown;
  readonly diagnosticsBytesLimit?: number;
}

// ------------------------------------------------------------------------------------------------
//                Readiness Construction
// ------------------------------------------------------------------------------------------------

function validatedReadinessReason(
  status: AgentProviderReadinessStatus,
  reason: AgentError | undefined,
): AgentError | undefined {
  if (status === "ready" && reason !== undefined) {
    throw new TypeError("Ready providers cannot report a failure reason.");
  }
  return reason === undefined ? undefined : parseAgentError(reason);
}

export function createAgentProviderReadiness(
  input: CreateAgentProviderReadinessInput,
): AgentProviderReadiness {
  if (!AGENT_PROVIDER_READINESS_STATUSES.includes(input.status)) {
    throw new TypeError("Provider readiness status is unsupported.");
  }
  const version =
    input.version === undefined
      ? undefined
      : parseAgentCanonicalText(input.version, "Provider version", 160);
  const reason = validatedReadinessReason(input.status, input.reason);
  return Object.freeze({
    status: input.status,
    checkedAt: parseAgentIsoDateTime(input.checkedAt),
    ...(version === undefined ? {} : { version }),
    ...(reason === undefined ? {} : { reason }),
    diagnostics: createBoundedAgentProviderData(
      input.diagnostics ?? {},
      input.diagnosticsBytesLimit,
    ),
  });
}

export function validateAgentProviderReadiness(
  input: AgentProviderReadiness,
): AgentProviderReadiness {
  if (
    input === null ||
    typeof input !== "object" ||
    !AGENT_PROVIDER_READINESS_STATUSES.includes(input.status)
  ) {
    throw new TypeError("Provider readiness is invalid.");
  }
  const version =
    input.version === undefined
      ? undefined
      : parseAgentCanonicalText(input.version, "Provider version", 160);
  const reason = validatedReadinessReason(input.status, input.reason);
  return Object.freeze({
    status: input.status,
    checkedAt: parseAgentIsoDateTime(input.checkedAt),
    ...(version === undefined ? {} : { version }),
    ...(reason === undefined ? {} : { reason }),
    diagnostics: validateBoundedAgentProviderData(input.diagnostics),
  });
}
