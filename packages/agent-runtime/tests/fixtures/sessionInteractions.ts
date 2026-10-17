// ------------------------------------------------------------------------------------------------
//                sessionInteractions.ts - Registry-backed direct request and cleanup fixtures
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import {
  parseAgentSessionDecisionChoiceId, parseAgentSessionDecisionRequest, parseAgentTurnId,
  type AgentError, type AgentSessionAcceptedResponse, type AgentSessionRequest, type AgentSessionResponse,
} from "@agen-ai/agent-protocol";
import type {
  AgentProviderCreateSessionInput, AgentProviderDirectSessionInteraction, AgentProviderSession,
  AgentProviderSessionContext, AgentSessionInteractionSupport, AgentSessionInteractionTerminal,
} from "../../src/index.js";
import { createHarness, deferred, type OpeningKind } from "./hostBindings/harness.js";

export const grant = parseAgentSessionDecisionChoiceId("trust-workspace");
export const decline = parseAgentSessionDecisionChoiceId("leave-gated");
export const refusal: AgentError = { category: "permission", code: "native_decision_refused", message: "Native decision refused.", recovery: { kind: "none" } };
export const uncertainty: AgentError = { category: "unknown", code: "native_delivery_uncertain", message: "Native answer acceptance is uncertain.", recovery: { kind: "unknown" } };
export const supported: AgentSessionInteractionSupport = {
  kind: "supported", mappings: [
    { openingOperation: "create", requestKind: "decision" },
    { openingOperation: "resume", requestKind: "decision" },
    { openingOperation: "branch", requestKind: "decision" },
  ], producerOwnership: "exclusive", humanWait: ["bounded", "until_withdrawn_or_closed"],
};
export const turnInput = { turnId: parseAgentTurnId("decision-turn"), interactionMode: "default" as const, parts: [{ type: "text" as const, text: "Continue the actual turn." }] };

export function decision(context: AgentProviderSessionContext, id = "session-decision", large = false, expiresAt?: string) {
  const choices = large ? Array.from({ length: 16 }, (_, index) => ({
    choiceId: `choice-${index}`, label: `Choice ${index}`, description: "d".repeat(1_000), consequence: { kind: "decline", configuration: "remains_gated" },
  })) : [
    { choiceId: grant, label: "Trust workspace", description: "Persist workspace configuration authority, including later and sibling sessions.",
      consequence: { kind: "grant", scope: "workspace", persistence: { kind: "provider_managed", duration: "persistent", mayAffectOtherSessions: true } } },
    { choiceId: decline, label: "Leave gated", description: "Keep the workspace configuration gated.", consequence: { kind: "decline", configuration: "remains_gated" } },
  ];
  return parseAgentSessionDecisionRequest({ kind: "decision", requestId: id, sessionId: context.sessionId,
    title: "Workspace configuration", description: large ? "r".repeat(4_000) : "Choose how this workspace configuration is loaded.",
    target: { kind: "workspace", path: "/configuration/workspace" }, ...(expiresAt === undefined ? {} : { expiresAt }), choices });
}

export function nativeOffer(context: AgentProviderSessionContext, options: {
  id?: string;
  large?: boolean;
  expiresAt?: string;
  request?: (context: AgentProviderSessionContext) => AgentSessionRequest;
  respond?: AgentProviderDirectSessionInteraction["respond"];
} = {}) {
  const controller = new AbortController();
  const terminal = deferred<AgentSessionInteractionTerminal>();
  const entered = deferred<void>();
  const active = new Set<Promise<unknown>>();
  const answers: string[] = [];
  const responses: AgentSessionResponse[] = [];
  let terminalSettled = false;
  let stopped = false;
  const settle = (value: AgentSessionInteractionTerminal) => {
    if (terminalSettled) return;
    terminalSettled = true;
    terminal.resolve(value);
  };
  const handle: AgentProviderDirectSessionInteraction = {
    kind: "direct", request: options.request?.(context) ?? decision(context, options.id, options.large, options.expiresAt),
    signal: controller.signal, terminal: terminal.promise,
    respond(input) {
      answers.push(input.choiceId);
      const { signal: _signal, ...response } = input;
      responses.push(response);
      entered.resolve();
      const work = (async () => {
        try {
          const result = await (options.respond?.(input) ?? { status: "delivered" as const });
          if (result.status === "delivered") settle({ kind: "answered", response: acceptedResponse(response) });
          else if (result.status === "delivery_uncertain") settle({ kind: "delivery_uncertain", error: result.error });
          else if (result.requestState === "unavailable") settle({ kind: "rejected", error: result.error });
          else if (stopped) settle({ kind: "session_closed" });
          return result;
        } catch (error) {
          settle({ kind: "delivery_uncertain", error: uncertainty });
          throw error;
        }
      })();
      active.add(work);
      void work.finally(() => active.delete(work)).catch(() => {});
      return work;
    },
  };
  return {
    context, handle, answers, responses, entered: entered.promise, completion: Promise.resolve(),
    settle,
    withdraw() { controller.abort(); settle({ kind: "withdrawn" }); },
    async stop() {
      stopped = true;
      controller.abort();
      if (!active.size) settle({ kind: "session_closed" });
      await Promise.allSettled([...active]);
    },
  };
}

function acceptedResponse(response: AgentSessionResponse): AgentSessionAcceptedResponse {
  if (response.kind === "decision") return response;
  if (response.kind === "form") return { kind: "form", action: response.action, choiceId: response.choiceId };
  return { kind: "plan_review", action: response.action, choiceId: response.choiceId,
    planId: response.planId, revision: response.revision };
}

export async function scenario(options: {
  openingOffer?: boolean;
  openingOfferOptions?: Parameters<typeof nativeOffer>[1];
  publication?: Promise<void>;
  support?: AgentSessionInteractionSupport | null;
  beforeOpen?: (context: AgentProviderSessionContext, kind: OpeningKind) => void | Promise<void>;
  transformSession?: (session: AgentProviderSession, context: AgentProviderSessionContext) => AgentProviderSession;
  cleanup?: () => void;
} = {}) {
  const offers: ReturnType<typeof nativeOffer>[] = [];
  const events: string[] = [];
  const nativeCloseEntered = deferred<void>();
  let closes = 0;
  const offer = (context: AgentProviderSessionContext, input: Parameters<typeof nativeOffer>[1] = {}) => {
    const candidate = nativeOffer(context, input);
    offers.push(candidate);
    assert.ok(context.interactions, "The provider must receive the public interaction facade.");
    try { candidate.completion = Promise.resolve(context.interactions.onRequest(candidate.handle)); }
    catch (error) { candidate.completion = Promise.reject(error); }
    void candidate.completion.catch(() => {});
    return candidate;
  };
  const harness = await createHarness({
    transformAdapter(adapter) {
      const prepared = { ...adapter, ...(options.support === null ? {} : { sessionInteractions: options.support ?? supported }) };
      const open = adapter.createSession.bind(adapter);
      if (!options.publication) return { ...prepared, createSession: open };
      return { ...prepared, async createSession(input: AgentProviderCreateSessionInput) {
        const candidate = await open(input);
        await options.publication;
        return candidate;
      } };
    },
    async beforeOpen(context, kind) {
      if (options.openingOffer !== false) offer(context, options.openingOfferOptions);
      await options.beforeOpen?.(context, kind);
    },
    transformSession(session, context) {
      const transformed = options.transformSession?.(session, context) ?? session;
      return { ...transformed, async close(input) {
        closes += 1;
        events.push("native_close_started");
        nativeCloseEntered.resolve();
        await Promise.all(offers.filter((candidate) => candidate.context === context).map((candidate) => candidate.stop()));
        await transformed.close(input);
        events.push("native_closed");
      } };
    },
  });
  return {
    ...harness, offers, events, offer, nativeCloseEntered: nativeCloseEntered.promise, closes: () => closes,
    async dispose() { options.cleanup?.(); await harness.registry.dispose(); },
  };
}

export function includesCause(error: unknown, cause: unknown): boolean {
  return error === cause || (error instanceof AggregateError && error.errors.some((entry: unknown) => includesCause(entry, cause)))
    || (error instanceof Error && error.cause !== undefined && includesCause(error.cause, cause));
}
