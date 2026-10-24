import {
  createAgentOutputDefinition,
  parseAgentApprovalOptionId,
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentItemId,
  parseAgentOutputSchema,
  parseAgentRequestId,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentCapabilities,
  type AgentRequest,
  type AgentRequestResolution,
  type AgentTurnCompletedPayload,
} from "@agen-ai/agent-protocol";
import {
  createAgentEventOutput,
  createAgentProviderRegistry,
  type AgentProviderCreateSessionInput,
  type AgentProviderDriver,
  type AgentProviderOutput,
  type AgentProviderResolveRequestInput,
  type AgentProviderStartTurnInput,
  type AgentRequestResolutionResult,
} from "../../../src/index.js";
import { createFakeAgentProvider } from "../../../src/testing/index.js";
import { deferred } from "../hostBindings/harness.js";

export { deferred };
export const titleSchema = parseAgentOutputSchema({
  type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
  required: ["title"], additionalProperties: false,
});
export const titleOutput = createAgentOutputDefinition(titleSchema, (value) => {
  if (typeof value.title !== "string") return { success: false, issues: [{ code: "title_required", path: ["title"], message: "A title is required." }] };
  return { success: true, data: { title: value.title } };
});
export const sessionInput = {
  sessionId: parseAgentSessionId("generation:session"),
  workingDirectory: "/fixture/workspace",
  configuration: { kind: "managed" as const, revision: parseAgentConfigurationRevisionId("generation:configuration") },
};
export const turnInput = {
  turnId: parseAgentTurnId("generation:turn"), interactionMode: "default" as const,
  parts: [{ type: "text" as const, text: "Create a concise title for this first conversation prompt." }],
};
export const itemId = parseAgentItemId("generation:item");
const optionId = parseAgentApprovalOptionId("allow-once");
export function approval(id = "generation:request"): AgentRequest {
  return { requestKind: "approval", requestId: parseAgentRequestId(id), prompt: "Allow this operation?",
    subject: { kind: "other", itemId, title: "Observed operation" },
    options: [{ optionId, label: "Allow once", decision: "approved", consequence: { kind: "scoped", persistence: "once", scope: { kind: "exact_action" } } }] };
}
export function answer(request: AgentRequest): AgentRequestResolution {
  return { requestKind: "approval", requestId: request.requestId, disposition: "selected", optionId };
}
export function event(context: AgentProviderCreateSessionInput, turn: AgentProviderStartTurnInput, type: string, payload: unknown): AgentProviderOutput {
  return createAgentEventOutput({ protocolVersion: 13, sessionId: context.sessionId, turnId: turn.turnId,
    occurredAt: "2026-10-21T12:00:00.000Z", type, payload });
}
export function terminal(context: AgentProviderCreateSessionInput, turn: AgentProviderStartTurnInput,
  payload: AgentTurnCompletedPayload = { outcome: "completed", structuredOutput: { kind: "json", value: { title: "A useful title" } } }) {
  return event(context, turn, "turn.completed", payload);
}

export async function generationFixture(options: {
  readonly scope?: "turn" | "session" | "unsupported";
  readonly maxSchemaBytes?: number;
  readonly beforeOpen?: (context: AgentProviderCreateSessionInput) => Promise<void>;
  readonly ignoreOpeningAbort?: boolean;
  readonly close?: (attempt: number) => Promise<void>;
  readonly resolveRequest?: (input: AgentProviderResolveRequestInput) => Promise<AgentRequestResolutionResult>;
  readonly outputs?: (context: AgentProviderCreateSessionInput, turn: AgentProviderStartTurnInput, closed: Promise<void>) => AsyncIterable<AgentProviderOutput>;
} = {}) {
  const defaults = createFakeAgentProvider().capabilities;
  const structuredOutput: AgentCapabilities["turns"]["structuredOutput"] = options.scope === "unsupported"
    ? { kind: "unsupported" }
    : { kind: "supported", mechanism: "native", schemaProfile: "agenai.output-schema.v1", scope: options.scope ?? "turn",
      maxSchemaBytes: options.maxSchemaBytes ?? 16_384, maxOutputBytes: 16_384, resume: false, branch: false };
  const capabilities = parseAgentCapabilities({ ...defaults, configuration: { kind: "managed" },
    operations: { kind: "unsupported" }, managedContent: { kind: "unsupported" }, integrations: { kind: "unsupported" },
    collaboration: { kind: "unsupported" }, generatedResources: { kind: "unsupported" },
    turns: { ...defaults.turns, structuredOutput } });
  const fake = createFakeAgentProvider({ capabilities });
  const contexts: AgentProviderCreateSessionInput[] = [];
  const turns: AgentProviderStartTurnInput[] = [];
  const resolutions: AgentProviderResolveRequestInput[] = [];
  const counts = { opens: 0, readers: 0, closes: 0, interrupts: 0, settledReaders: 0 };
  const opened = deferred<void>();
  const started = deferred<void>();
  const closed = deferred<void>();
  const driver: AgentProviderDriver = { ...fake.driver, async materialize(definition) {
    const instance = await fake.driver.materialize(definition);
    return { ...instance, adapter: { ...instance.adapter, async createSession(context) {
      counts.opens += 1; contexts.push(context); opened.resolve();
      await options.beforeOpen?.(context);
      const { signal: _signal, ...withoutSignal } = context;
      const native = await instance.adapter.createSession(options.ignoreOpeningAbort ? withoutSignal : context);
      return { ...native,
        startTurn(turn) {
          turns.push(turn); started.resolve();
          return { turnId: turn.turnId,
            outputs: { [Symbol.asyncIterator]() {
              counts.readers += 1;
              return (async function* () {
                try {
                  if (options.outputs) yield* options.outputs(context, turn, closed.promise);
                  else { yield event(context, turn, "turn.started", {}); yield terminal(context, turn); }
                } finally { counts.settledReaders += 1; }
              })();
            } },
            async resolveRequest(input) { resolutions.push(input); return options.resolveRequest?.(input) ?? { status: "delivered" }; },
          };
        },
        interruption: { kind: "supported" as const, interruptTurn() { counts.interrupts += 1; return { status: "accepted" as const }; } },
        async close(input) {
          counts.closes += 1;
          await options.close?.(counts.closes);
          closed.resolve(); await native.close(input);
        },
      };
    } } };
  } };
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [fake.definition] });
  const instance = registry.requireInstance(fake.definition.instanceId);
  return { instance, registry, contexts, turns, resolutions, counts, opened: opened.promise, started: started.promise,
    disposed: () => fake.snapshot().instanceDisposeCount,
    input: { instance, session: sessionInput, turn: turnInput, output: titleOutput },
  };
}
