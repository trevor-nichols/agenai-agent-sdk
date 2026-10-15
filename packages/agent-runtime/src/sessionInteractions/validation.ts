import path from "node:path";
import {
  parseAgentError,
  parseAgentSessionDecisionChoiceId,
  parseAgentSessionDecisionRequest,
  type AgentCapabilities,
  type AgentProviderKey,
  type AgentSessionId,
} from "@agen-ai/agent-protocol";
import { AgentProviderContractError } from "../contractErrors.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";
import type { AgentProviderAdapter } from "../sessions.js";
import {
  DEFAULT_AGENT_SESSION_INTERACTION_LIMITS,
  type AgentSessionInteraction,
  type AgentSessionInteractionContext,
  type AgentSessionInteractionLimits,
  type AgentSessionInteractionOpeningOperation,
  type AgentSessionInteractionSupport,
  type AgentSessionInteractionTerminal,
} from "./types.js";

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Expected an interaction object.");
  return input as Record<string, unknown>;
}

export function interactionContractError(providerKey: AgentProviderKey, message: string): AgentProviderContractError {
  return new AgentProviderContractError(providerKey, "invalid_session_interaction", message);
}

export function validateSessionInteractionSupport(
  capabilities: AgentCapabilities,
  adapter: AgentProviderAdapter,
): AgentSessionInteractionSupport {
  const input = adapter.sessionInteractions;
  if (input === undefined) return Object.freeze({ kind: "unsupported" });
  try {
    const value = record(input);
    if (value.kind === "unsupported" && hasExactOwnKeys(value, ["kind"])) return Object.freeze({ kind: "unsupported" });
    if (!hasExactOwnKeys(value, ["kind", "openingOperations", "requestKinds", "producerOwnership"])
      || value.kind !== "supported" || value.producerOwnership !== "exclusive"
      || !Array.isArray(value.openingOperations) || value.openingOperations.length === 0
      || !Array.isArray(value.requestKinds) || value.requestKinds.length !== 1 || value.requestKinds[0] !== "decision") throw new TypeError();
    const operations: AgentSessionInteractionOpeningOperation[] = [];
    for (const operation of value.openingOperations) {
      if (operation !== "create" && operation !== "resume" && operation !== "branch") throw new TypeError();
      if (operations.includes(operation)) throw new TypeError();
      if (operation === "resume" && (!capabilities.sessions.resume || adapter.resumption.kind !== "supported")) throw new TypeError();
      if (operation === "branch" && (capabilities.sessions.branch.kind !== "through_turn" || adapter.branching.kind !== "through_turn")) throw new TypeError();
      operations.push(operation);
    }
    const order = ["create", "resume", "branch"];
    if (operations.some((operation, index) => index > 0 && order.indexOf(operation) < order.indexOf(operations[index - 1]!))) throw new TypeError();
    const [first, ...rest] = operations;
    if (first === undefined) throw new TypeError();
    return Object.freeze({ kind: "supported", producerOwnership: "exclusive",
      openingOperations: Object.freeze([first, ...rest] as const), requestKinds: Object.freeze(["decision"] as const) });
  } catch {
    throw interactionContractError(capabilities.providerKey, "Provider declared invalid session interaction support.");
  }
}

const limitRanges: Readonly<Record<keyof AgentSessionInteractionLimits, readonly [number, number]>> = {
  maxRetainedRequests: [1, 32], maxRetainedBytes: [65_536, 2_097_152],
  requestTimeoutMs: [1_000, 1_800_000], responseTimeoutMs: [1_000, 120_000], cleanupTimeoutMs: [1_000, 120_000],
};

export interface ValidatedSessionInteractionContext {
  readonly onRequest: AgentSessionInteractionContext["onRequest"];
  readonly limits: Readonly<AgentSessionInteractionLimits>;
}

export function validateSessionInteractionContext(input: AgentSessionInteractionContext): ValidatedSessionInteractionContext {
  const value = record(input);
  const onRequest = value.onRequest;
  if (!hasExactOwnKeys(value, Object.hasOwn(value, "limits") ? ["onRequest", "limits"] : ["onRequest"])
    || typeof onRequest !== "function") throw new TypeError("Session interactions require a callable handler and known fields.");
  const supplied = value.limits === undefined ? {} : record(value.limits);
  if (Reflect.ownKeys(supplied).some((key) => typeof key !== "string" || !Object.hasOwn(limitRanges, key))) {
    throw new TypeError("Session interaction limits contain an unknown field.");
  }
  const limits = { ...DEFAULT_AGENT_SESSION_INTERACTION_LIMITS };
  for (const key of Object.keys(limitRanges) as (keyof AgentSessionInteractionLimits)[]) {
    const number = supplied[key];
    if (number === undefined) continue;
    const [minimum, maximum] = limitRanges[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
      throw new RangeError(`Session interaction ${key} must be an integer between ${minimum} and ${maximum}.`);
    }
    limits[key] = number;
  }
  return Object.freeze({ onRequest: onRequest.bind(input) as AgentSessionInteractionContext["onRequest"], limits: Object.freeze(limits) });
}

export interface CapturedSessionInteractionCandidate {
  readonly request: unknown;
  readonly signal: AbortSignal;
  readonly terminal: Promise<unknown>;
  readonly respond: AgentSessionInteraction["respond"];
}

export function captureSessionInteractionCandidate(input: AgentSessionInteraction,
  observe: (terminal: Promise<unknown>) => void): CapturedSessionInteractionCandidate {
  const value = record(input);
  const terminal = value.terminal;
  // Observe a captured terminal before parsing any other provider-owned value.
  const observation = Promise.resolve(terminal);
  void observation.catch(() => {});
  observe(observation);
  const request = value.request;
  const signal = value.signal;
  const respond = value.respond;
  if (!hasExactOwnKeys(value, ["request", "signal", "terminal", "respond"])
    || !(signal instanceof AbortSignal) || typeof respond !== "function"
    || !terminal || typeof record(terminal).then !== "function") throw new TypeError("Provider offered an invalid session interaction handle.");
  return Object.freeze({ request, signal, terminal: observation,
    respond: respond.bind(input) as AgentSessionInteraction["respond"] });
}

export function validateSessionInteractionCandidate(input: CapturedSessionInteractionCandidate, sessionId: AgentSessionId,
  requestTimeoutMs: number): CapturedSessionInteractionCandidate & Pick<AgentSessionInteraction, "request"> {
  const parsed = parseAgentSessionDecisionRequest(input.request);
  if (parsed.sessionId !== sessionId || !path.isAbsolute(parsed.target.path) || path.normalize(parsed.target.path) !== parsed.target.path) {
    throw new TypeError("Session interaction does not match its session or canonical workspace target.");
  }
  const expiry = Math.min(Date.parse(parsed.expiresAt), Date.now() + requestTimeoutMs);
  if (expiry <= Date.now()) throw new TypeError("Provider offered an expired session interaction.");
  const request = parseAgentSessionDecisionRequest({ ...parsed, expiresAt: new Date(expiry).toISOString() });
  return Object.freeze({ ...input, request });
}

export function validateSessionInteractionTerminal(input: unknown): AgentSessionInteractionTerminal {
  const value = record(input);
  if (value.kind === "answered" && hasExactOwnKeys(value, ["kind", "choiceId"])) {
    return Object.freeze({ kind: "answered", choiceId: parseAgentSessionDecisionChoiceId(value.choiceId) });
  }
  if ((value.kind === "failed" || value.kind === "rejected" || value.kind === "delivery_uncertain")
    && hasExactOwnKeys(value, ["kind", "error"])) return Object.freeze({ kind: value.kind, error: parseAgentError(value.error) });
  if ((value.kind === "withdrawn" || value.kind === "expired" || value.kind === "session_closed")
    && hasExactOwnKeys(value, ["kind"])) return Object.freeze({ kind: value.kind });
  throw new TypeError("Provider returned an invalid session interaction terminal.");
}
