// ------------------------------------------------------------------------------------------------
//                validation.ts - Parse neutral session ownership at producer and host boundaries
// ------------------------------------------------------------------------------------------------
import path from "node:path";
import {
  parseAgentError, parseAgentIsoDateTime, parseAgentSessionRequest, parseAgentSessionResponse,
  parseAgentSessionFormChoiceId, parseAgentSessionPlanReviewChoiceId,
  parseAgentSessionPlanId, parseAgentSessionPlanRevision,
  type AgentCapabilities, type AgentProviderKey, type AgentSessionId, type AgentSessionAcceptedResponse,
} from "@agen-ai/agent-protocol";
import { AgentProviderContractError } from "../contractErrors.js";
import { hasExactOwnKeys } from "../internal/objectShape.js";
import type { AgentProviderAdapter } from "../sessions.js";
import type { AgentNativeContinuationSupport, AgentNativeContinuationMapping, AgentNativeContinuationContext } from "../nativeContinuations/types.js";
import {
  DEFAULT_AGENT_SESSION_INTERACTION_LIMITS,
  type AgentSessionInteractionContext, type AgentSessionInteractionLimits,
  type AgentSessionInteractionSupport, type AgentSessionInteractionTerminal, type AgentSessionHumanWaitKind,
  type AgentProviderSessionInteraction, type AgentSessionInteractionDeadline, type AgentSessionInteractionMapping,
} from "./types.js";

export function interactionRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Expected an interaction object.");
  return input as Record<string, unknown>;
}
export function interactionContractError(providerKey: AgentProviderKey, message: string): AgentProviderContractError {
  return new AgentProviderContractError(providerKey, "invalid_session_interaction", message);
}
const operations = ["create", "resume", "branch"] as const;
const kinds = ["decision", "form", "plan_review"] as const;
const timings = ["after_open_return", "before_open_return", "before_binding"] as const;
const waits = ["bounded", "until_withdrawn_or_closed"] as const;
function ordered<T>(input: unknown, values: readonly T[]): readonly [T, ...T[]] {
  if (!Array.isArray(input) || input.length === 0 || input.length > values.length) throw new TypeError("Expected a bounded nonempty support list.");
  let last = -1;
  const result: T[] = [];
  for (const value of input) {
    const index = values.indexOf(value);
    if (index <= last) throw new TypeError("Support must be unique and canonical-sorted.");
    last = index; result.push(values[index]!);
  }
  const [first, ...rest] = result;
  if (first === undefined) throw new TypeError();
  return Object.freeze([first, ...rest]);
}
function mapping(input: unknown, capabilities: AgentCapabilities, adapter: AgentProviderAdapter): AgentSessionInteractionMapping {
  const value = interactionRecord(input);
  const operation = operations.find((entry) => entry === value.openingOperation);
  const requestKind = kinds.find((entry) => entry === value.requestKind);
  if (!operation || !requestKind || (operation === "resume" && (!capabilities.sessions.resume || adapter.resumption.kind !== "supported"))
    || (operation === "branch" && (capabilities.sessions.branch.kind !== "through_turn" || adapter.branching.kind !== "through_turn"))) throw new TypeError();
  return Object.freeze({ openingOperation: operation, requestKind });
}
export function validateSessionInteractionSupport(capabilities: AgentCapabilities, adapter: AgentProviderAdapter): AgentSessionInteractionSupport {
  if (adapter.sessionInteractions === undefined) return Object.freeze({ kind: "unsupported" });
  try {
    const value = interactionRecord(adapter.sessionInteractions);
    if (value.kind === "unsupported" && hasExactOwnKeys(value, ["kind"])) return Object.freeze({ kind: "unsupported" });
    if (!hasExactOwnKeys(value, ["kind", "mappings", "producerOwnership", "humanWait"]) || value.kind !== "supported"
      || value.producerOwnership !== "exclusive" || !Array.isArray(value.mappings) || value.mappings.length < 1 || value.mappings.length > 9) throw new TypeError();
    let previous = -1;
    const parsed = value.mappings.map((entry) => {
      if (!hasExactOwnKeys(interactionRecord(entry), ["openingOperation", "requestKind"])) throw new TypeError();
      const parsed = mapping(entry, capabilities, adapter);
      const index = operations.indexOf(parsed.openingOperation) * 3 + kinds.indexOf(parsed.requestKind);
      if (index <= previous) throw new TypeError();
      previous = index; return parsed;
    });
    const [first, ...rest] = parsed; if (!first) throw new TypeError();
    return Object.freeze({ kind: "supported", producerOwnership: "exclusive", mappings: Object.freeze([first, ...rest] as const), humanWait: ordered(value.humanWait, waits) });
  } catch { throw interactionContractError(capabilities.providerKey, "Provider declared invalid session interaction support."); }
}
export function validateNativeContinuationSupport(capabilities: AgentCapabilities, adapter: AgentProviderAdapter, interactions: AgentSessionInteractionSupport): AgentNativeContinuationSupport {
  if (adapter.nativeContinuations === undefined) return Object.freeze({ kind: "unsupported" });
  try {
    const value = interactionRecord(adapter.nativeContinuations);
    if (value.kind === "unsupported" && hasExactOwnKeys(value, ["kind"])) return Object.freeze({ kind: "unsupported" });
    if (!hasExactOwnKeys(value, ["kind", "mappings", "producerOwnership"]) || value.kind !== "supported" || value.producerOwnership !== "exclusive"
      || !Array.isArray(value.mappings) || value.mappings.length < 1 || value.mappings.length > 18 || interactions.kind !== "supported") throw new TypeError();
    let previous = -1;
    const parsed: AgentNativeContinuationMapping[] = value.mappings.map((entry) => {
      const record = interactionRecord(entry);
      if (!hasExactOwnKeys(record, ["openingOperation", "requestKind", "timing"])) throw new TypeError();
      const parsed = mapping(record, capabilities, adapter);
      const timing = timings.find((entry) => entry === record.timing);
      if (parsed.requestKind === "decision" || !timing || !interactions.mappings.some((entry) => entry.openingOperation === parsed.openingOperation && entry.requestKind === parsed.requestKind)) throw new TypeError();
      const index = operations.indexOf(parsed.openingOperation) * 6 + (parsed.requestKind === "form" ? 0 : 3) + timings.indexOf(timing);
      if (index <= previous) throw new TypeError(); previous = index;
      return Object.freeze({ openingOperation: parsed.openingOperation, requestKind: parsed.requestKind, timing });
    });
    const [first, ...rest] = parsed; if (!first) throw new TypeError();
    return Object.freeze({ kind: "supported", producerOwnership: "exclusive", mappings: Object.freeze([first, ...rest] as const) });
  } catch { throw new AgentProviderContractError(capabilities.providerKey, "capability_port_mismatch", "Provider declared invalid native continuation support."); }
}
const limitRanges: Readonly<Record<keyof AgentSessionInteractionLimits, readonly [number, number]>> = {
  maxRetainedRequests: [1, 32], maxRetainedBytes: [65_536, 2_097_152], requestTimeoutMs: [1_000, 1_800_000], responseTimeoutMs: [1_000, 120_000], cleanupTimeoutMs: [1_000, 120_000],
};
export interface ValidatedSessionInteractionContext {
  readonly onRequest: AgentSessionInteractionContext["onRequest"];
  readonly humanWait: AgentSessionHumanWaitKind;
  readonly limits: Readonly<AgentSessionInteractionLimits>;
}
export function validateSessionInteractionContext(input: AgentSessionInteractionContext): ValidatedSessionInteractionContext {
  const value = interactionRecord(input);
  if (Reflect.ownKeys(value).some((key) => !["onRequest", "limits", "humanWait"].includes(String(key))) || typeof value.onRequest !== "function") throw new TypeError("Session interactions require a callable handler and known fields.");
  const human = value.humanWait === undefined ? { kind: "bounded" } : interactionRecord(value.humanWait);
  if (!hasExactOwnKeys(human, ["kind"]) || (human.kind !== "bounded" && human.kind !== "until_withdrawn_or_closed")) throw new TypeError("Invalid human wait policy.");
  const supplied = value.limits === undefined ? {} : interactionRecord(value.limits);
  if (Reflect.ownKeys(supplied).some((key) => typeof key !== "string" || !Object.hasOwn(limitRanges, key))
    || (human.kind === "until_withdrawn_or_closed" && Object.hasOwn(supplied, "requestTimeoutMs"))) throw new TypeError("Conflicting or unknown session interaction limits.");
  const limits = { ...DEFAULT_AGENT_SESSION_INTERACTION_LIMITS };
  for (const key of Object.keys(limitRanges) as (keyof AgentSessionInteractionLimits)[]) {
    const number = supplied[key]; if (number === undefined) continue;
    const [minimum, maximum] = limitRanges[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new RangeError(`Invalid session interaction ${key}.`);
    limits[key] = number;
  }
  return Object.freeze({ onRequest: input.onRequest.bind(input), humanWait: human.kind, limits: Object.freeze(limits) });
}
export function validateNativeContinuationContext(input: AgentNativeContinuationContext | undefined): AgentNativeContinuationContext | undefined {
  if (input === undefined) return undefined;
  const value = interactionRecord(input);
  if (!hasExactOwnKeys(value, ["onExecution"]) || typeof value.onExecution !== "function") throw new TypeError("Native continuations require one callable handler.");
  return Object.freeze({ onExecution: input.onExecution.bind(input) });
}
export type CapturedSessionInteractionCandidate = AgentProviderSessionInteraction;
export function captureSessionInteractionCandidate(input: AgentProviderSessionInteraction, observe: (terminal: Promise<unknown>) => void): CapturedSessionInteractionCandidate {
  const value = interactionRecord(input);
  const terminal = value.terminal;
  const observation = Promise.resolve(terminal); void observation.catch(() => {}); observe(observation);
  if (!(value.signal instanceof AbortSignal) || !terminal || typeof interactionRecord(terminal).then !== "function") throw new TypeError("Invalid interaction lifecycle.");
  if (value.kind === "direct" && hasExactOwnKeys(value, ["kind", "request", "signal", "terminal", "respond"]) && typeof value.respond === "function") {
    return Object.freeze({ kind: "direct", request: input.request, signal: value.signal, terminal: observation as Promise<AgentSessionInteractionTerminal>, respond: value.respond.bind(input) as Extract<AgentProviderSessionInteraction, { kind: "direct" }>["respond"] });
  }
  if (value.kind === "prepared" && hasExactOwnKeys(value, ["kind", "request", "signal", "terminal", "prepareResponse"]) && typeof value.prepareResponse === "function") {
    const request = parseAgentSessionRequest(value.request);
    if (request.kind === "decision") throw new TypeError("Decisions cannot prepare native execution.");
    return Object.freeze({ kind: "prepared", request, signal: value.signal, terminal: observation as Promise<AgentSessionInteractionTerminal>, prepareResponse: value.prepareResponse.bind(input) as Extract<AgentProviderSessionInteraction, { kind: "prepared" }>["prepareResponse"] });
  }
  throw new TypeError("Provider offered an invalid session interaction handle.");
}
export type ValidatedSessionInteractionCandidate = CapturedSessionInteractionCandidate & Readonly<{ deadline: AgentSessionInteractionDeadline; deadlineAt?: number }>;
export function validateSessionInteractionCandidate(input: CapturedSessionInteractionCandidate, sessionId: AgentSessionId, context: ValidatedSessionInteractionContext): ValidatedSessionInteractionCandidate {
  const request = parseAgentSessionRequest(input.request);
  if (request.sessionId !== sessionId || (request.kind === "decision" && (!path.isAbsolute(request.target.path) || path.normalize(request.target.path) !== request.target.path))) throw new TypeError("Interaction does not match its exact session or canonical workspace target.");
  const provider = request.expiresAt === undefined ? undefined : Date.parse(request.expiresAt);
  const host = context.humanWait === "bounded" ? Date.now() + context.limits.requestTimeoutMs : undefined;
  const source = provider !== undefined && (host === undefined || provider <= host) ? "provider" : "host_policy";
  const deadlineAt = source === "provider" ? provider : host;
  const deadline: AgentSessionInteractionDeadline = deadlineAt === undefined ? Object.freeze({ kind: "no_deadline" })
    : Object.freeze({ kind: "deadline", expiresAt: source === "provider" ? request.expiresAt! : parseAgentIsoDateTime(new Date(deadlineAt).toISOString()), source });
  if (input.kind === "prepared" && request.kind === "decision") throw new TypeError();
  return Object.freeze({ ...input, request, deadline, ...(deadlineAt === undefined ? {} : { deadlineAt }) }) as ValidatedSessionInteractionCandidate;
}
function acceptedResponse(input: unknown): AgentSessionAcceptedResponse {
  const value = interactionRecord(input);
  if (value.kind === "decision") return parseAgentSessionResponse(value) as Extract<AgentSessionAcceptedResponse, { kind: "decision" }>;
  if (value.kind === "form" && hasExactOwnKeys(value, ["kind", "action", "choiceId"]) && (value.action === "submit" || value.action === "cancel")) return Object.freeze({ kind: "form", action: value.action, choiceId: parseAgentSessionFormChoiceId(value.choiceId) });
  if (value.kind === "plan_review" && hasExactOwnKeys(value, ["kind", "action", "choiceId", "planId", "revision"]) && (value.action === "approve" || value.action === "revise" || value.action === "abandon")) return Object.freeze({ kind: "plan_review", action: value.action, choiceId: parseAgentSessionPlanReviewChoiceId(value.choiceId), planId: parseAgentSessionPlanId(value.planId), revision: parseAgentSessionPlanRevision(value.revision) });
  throw new TypeError("Invalid accepted response.");
}
export function validateSessionInteractionTerminal(input: unknown): AgentSessionInteractionTerminal {
  const value = interactionRecord(input);
  if (value.kind === "answered" && hasExactOwnKeys(value, ["kind", "response"])) return Object.freeze({ kind: "answered", response: acceptedResponse(value.response) });
  if ((value.kind === "failed" || value.kind === "rejected" || value.kind === "delivery_uncertain") && hasExactOwnKeys(value, ["kind", "error"])) return Object.freeze({ kind: value.kind, error: parseAgentError(value.error) });
  if (value.kind === "expired" && hasExactOwnKeys(value, ["kind", "source"]) && (value.source === "provider" || value.source === "host_policy")) return Object.freeze({ kind: "expired", source: value.source });
  if ((value.kind === "withdrawn" || value.kind === "session_closed") && hasExactOwnKeys(value, ["kind"])) return Object.freeze({ kind: value.kind });
  throw new TypeError("Provider returned an invalid session interaction terminal.");
}
