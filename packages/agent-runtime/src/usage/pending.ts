// ------------------------------------------------------------------------------------------------
//                pending.ts - Bounded ordered retention until an owned output path - Dependencies: ledger
// ------------------------------------------------------------------------------------------------

import {
  AGENT_PROTOCOL_VERSION,
  safeParseAgentTokenUsageObservation,
  safeParseAgentUsageObservedEvent,
  type AgentProviderKey,
  type AgentSessionId,
  type AgentTokenUsageObservation,
  type AgentTurnId,
  type AgentUsageObservedEvent,
} from "@agen-ai/agent-protocol";

import { AgentProviderContractError, throwAgentProviderContractError } from "../contractErrors.js";
import { canonicalUsageJson, deepFreeze, usageJsonBytes } from "./canonical.js";
import { AGENT_TOKEN_USAGE_PENDING_LIMITS as LIMITS } from "./types.js";

export type AgentTokenUsageDelivery = Readonly<{
  sessionId: AgentSessionId;
  /** The owned output path's turn, which need not be the observation's accounting scope. */
  turnId: AgentTurnId;
  occurredAt: string;
}>;

/**
 * Retains opening, resume and between-turn observations in arrival order without coalescing.
 * Overflow and malformed input fail through the caller's contract owner and stay failed, so the
 * next drain cannot silently publish a truncated sequence.
 */
export interface AgentTokenUsagePendingBuffer {
  readonly size: number;
  retain(observation: AgentTokenUsageObservation): void;
  drain(delivery: AgentTokenUsageDelivery): readonly AgentUsageObservedEvent[];
}

export function createTokenUsagePendingBuffer(
  input: Readonly<{ providerKey: AgentProviderKey }>,
): AgentTokenUsagePendingBuffer {
  const { providerKey } = input;
  let pending: readonly Readonly<{ observation: AgentTokenUsageObservation; bytes: number }>[] = [];
  let bytes = 0;
  let failure: AgentProviderContractError | undefined;

  const fail = (code: "usage_invalid" | "usage_capacity_exceeded", message: string): never => {
    failure = new AgentProviderContractError(providerKey, code, message);
    throw failure;
  };

  return Object.freeze({
    get size() {
      return pending.length;
    },
    retain(candidate: AgentTokenUsageObservation) {
      if (failure !== undefined) throw failure;
      const parsed = safeParseAgentTokenUsageObservation(candidate);
      if (!parsed.success) return fail("usage_invalid", "A pending token usage observation is invalid.");
      const size = usageJsonBytes(canonicalUsageJson(parsed.data));
      if (pending.length >= LIMITS.observations || bytes + size > LIMITS.bytes) {
        return fail("usage_capacity_exceeded", "Pending token usage exceeds its delivery budget.");
      }
      pending = [...pending, { observation: deepFreeze(parsed.data), bytes: size }];
      bytes += size;
    },
    drain(delivery: AgentTokenUsageDelivery) {
      if (failure !== undefined) throw failure;
      const events = pending.map(({ observation }) => {
        const parsed = safeParseAgentUsageObservedEvent({
          protocolVersion: AGENT_PROTOCOL_VERSION,
          type: "usage.observed",
          sessionId: delivery.sessionId,
          turnId: delivery.turnId,
          occurredAt: delivery.occurredAt,
          payload: observation,
        });
        if (!parsed.success) {
          return throwAgentProviderContractError(providerKey, "usage_invalid", "The token usage delivery envelope is invalid.");
        }
        return deepFreeze(parsed.data);
      });
      pending = [];
      bytes = 0;
      return Object.freeze(events);
    },
  });
}
