// ------------------------------------------------------------------------------------------------
//                tokenUsageSession.ts - Registry-backed sessions that deliver token usage
// ------------------------------------------------------------------------------------------------

import {
  parseAgentCapabilities,
  parseAgentTurnId,
  type AgentSessionId,
  type AgentTurnId,
} from "@agen-ai/agent-protocol";

import {
  createAgentEventOutput,
  type AgentProviderOutput,
  type AgentProviderSession,
  type AgentProviderSessionContext,
  type AgentProviderStartTurnInput,
} from "../../src/index.js";
import { createFakeAgentProvider } from "../../src/testing/index.js";
import { createHarness } from "./hostBindings/harness.js";
import { DETAIL_VIEW, SESSION_VIEW } from "./tokenUsage.js";
import { fixtureTurn } from "./turnExecution.js";

const base = createFakeAgentProvider().capabilities;

export const usageCapabilities = parseAgentCapabilities({
  ...base,
  output: { ...base.output, fileChanges: "final_diff" },
  tokenUsage: {
    kind: "supported",
    views: [
      { view: SESSION_VIEW, scopeKind: "session", reportedCounters: ["inputTokens", "outputTokens"], attribution: ["model", "unknown"] },
      { view: DETAIL_VIEW, scopeKind: "turn", reportedCounters: ["inputTokens", "outputTokens"], attribution: ["unknown"] },
    ],
  },
});

const occurredAt = "2026-11-13T00:00:00.000Z";

/** Envelopes for one delivery turn; `raw` bypasses construction-time parsing like a malformed producer. */
export function emitter(sessionId: AgentSessionId, turnId: AgentTurnId) {
  const envelope = { protocolVersion: 14 as const, sessionId, turnId, occurredAt };
  const output = (type: string, payload: unknown) =>
    createAgentEventOutput({ ...envelope, type, payload } as Parameters<typeof createAgentEventOutput>[0]);
  return {
    started: () => output("turn.started", {}),
    usage: (payload: unknown) => output("usage.observed", payload),
    raw: (payload: unknown, overrides: Readonly<Record<string, unknown>> = {}) =>
      ({ kind: "event", event: { ...envelope, type: "usage.observed", payload, ...overrides } }) as unknown as AgentProviderOutput,
    diff: () => output("turn.diff.updated", { summary: "One file changed.", fileCount: 1, byteSize: 32 }),
    warning: () => output("runtime.warning", { code: "late", message: "Late materialization." }),
    completed: (outcome: "completed" | "failed" = "completed") => output("turn.completed", {
      structuredOutput: { kind: "not_requested" },
      outcome,
      ...(outcome === "failed"
        ? { error: { category: "provider", code: "native_failure", message: "Native failure.", recovery: { kind: "none" } } }
        : {}),
    }),
  };
}
export type UsageEmitter = ReturnType<typeof emitter>;

type Script = (emit: UsageEmitter, input: AgentProviderStartTurnInput) => AsyncIterable<AgentProviderOutput>;

export async function openUsageSession(options: {
  readonly script?: Script;
  readonly capabilities?: typeof usageCapabilities;
  readonly session?: (session: AgentProviderSession, context: AgentProviderSessionContext) => Partial<AgentProviderSession>;
} = {}) {
  let nativeCloses = 0;
  const harness = await createHarness({
    capabilities: options.capabilities ?? usageCapabilities,
    transformSession(session, context) {
      const script = options.script;
      return {
        ...session,
        ...(script === undefined ? {} : {
          startTurn: fixtureTurn((input) => script(emitter(context.sessionId, input.turnId), input)),
        }),
        async close(input) {
          nativeCloses += 1;
          await session.close(input);
        },
        ...options.session?.(session, context),
      };
    },
  });
  const session = await harness.open("create");
  return {
    session,
    sessionId: harness.contexts[0]!.sessionId,
    nativeCloses: () => nativeCloses,
    async dispose() {
      await Promise.resolve(session.close({ reason: "idle" })).catch(() => undefined);
      await harness.registry.dispose();
    },
  };
}

export const turn = (id: string) => ({
  turnId: parseAgentTurnId(id),
  interactionMode: "default" as const,
  parts: [{ type: "text" as const, text: "Report token usage." }],
});

export async function collectOutputs(outputs: AsyncIterable<AgentProviderOutput>): Promise<readonly AgentProviderOutput[]> {
  const collected: AgentProviderOutput[] = [];
  for await (const output of outputs) collected.push(output);
  return collected;
}
