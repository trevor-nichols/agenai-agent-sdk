// ------------------------------------------------------------------------------------------------
//                nativeContinuations.ts - Candidate preparation with independently observed entry
// ------------------------------------------------------------------------------------------------
import assert from "node:assert/strict";
import {
  parseAgentConfigurationRevisionId, parseAgentSessionId, parseAgentSessionPlanReviewRequest,
  type AgentSessionResponse, type AgentSessionRequest, type AgentTurnId,
} from "@agen-ai/agent-protocol";
import {
  createAgentEventOutput, validateAgentProviderAdapter,
  type AgentCreateSessionInput, type AgentProviderCreateSessionInput, type AgentNativeContinuationOutcome, type AgentNativeContinuationTiming,
  type AgentPreparedSessionResponse, type AgentProviderPreparedSessionInteraction, type AgentProviderSession,
  type AgentProviderSessionContext, type AgentRequestResolutionResult, type AgentSessionInteractionTerminal,
  type AgentSessionHostBindingSupport,
} from "../../src/index.js";
import { createFakeAgentProvider } from "../../src/testing/index.js";
import { deferred } from "./hostBindings/harness.js";

export async function continuationFixture(options: {
  timing?: AgentNativeContinuationTiming;
  beforeBinding?: boolean;
  delayBinding?: Promise<void>;
  offerCount?: number;
  delayOpening?: Promise<void>;
  noContinuation?: boolean;
  outcome?: "started" | "not_started" | "missing" | "malformed" | "reject";
  receipt?: AgentRequestResolutionResult | Promise<AgentRequestResolutionResult>;
  afterStarted?: Promise<void>;
  hostBindingSupport?: AgentSessionHostBindingSupport;
  preparation?: Promise<void>;
  cancel?: () => Promise<void>;
  close?: () => Promise<void>;
  createExecution?: (turnId: AgentTurnId) => AgentTurnId | void;
  extraOutput?: (context: AgentProviderSessionContext, turnId: AgentTurnId) => ReturnType<typeof createAgentEventOutput>;
} = {}) {
  const fake = createFakeAgentProvider();
  const instance = await fake.driver.materialize(fake.definition);
  const events: string[] = [];
  const opened = deferred<void>();
  const output = deferred<void>();
  const outcome = deferred<AgentNativeContinuationOutcome>();
  const responseEntered = deferred<void>();
  const preparationEntered = deferred<void>();
  const terminal = deferred<AgentSessionInteractionTerminal>();
  const controller = new AbortController();
  let request: AgentProviderPreparedSessionInteraction["request"];
  let producer: AgentProviderSessionContext | undefined;
  let publication: Promise<void> | undefined;
  let preparedResponse: AgentSessionResponse | undefined;
  let dispatches = 0;
  let cancels = 0;
  let callerTurns = 0;
  let nativeCloses = 0;
  let executionSignal: AbortSignal | undefined;
  const offer = (context: AgentProviderSessionContext, index = 0) => {
    producer = context;
    request = parseAgentSessionPlanReviewRequest({ kind: "plan_review", requestId: `native-plan-review:${index}`, sessionId: context.sessionId,
      title: "Review the saved plan", plan: { planId: "saved-plan", revision: "revision-one", title: "Saved plan", content: { kind: "text", format: "markdown", text: "Perform the exact reviewed work." } },
      choices: [{ choiceId: "approve", action: "approve", label: "Approve" }, { choiceId: "revise", action: "revise", label: "Revise" }, { choiceId: "abandon", action: "abandon", label: "Abandon" }] });
    const candidate: AgentProviderPreparedSessionInteraction = {
      kind: "prepared", request, signal: controller.signal, terminal: terminal.promise,
      async prepareResponse(input) {
        events.push("prepare"); preparationEntered.resolve(); preparedResponse = input.response;
        await options.preparation;
        const control = {
          async dispatch(): Promise<AgentRequestResolutionResult> {
            dispatches += 1; events.push("dispatch"); responseEntered.resolve();
            if (options.outcome === "not_started") outcome.resolve({ kind: "not_started" });
            else if (options.outcome === "reject") outcome.reject(new Error("Native outcome rejected."));
            else if (options.outcome === "malformed") outcome.resolve({ kind: "foreign" } as unknown as AgentNativeContinuationOutcome);
            else if (options.outcome !== "missing") outcome.resolve({ kind: "started" });
            output.resolve();
            const receipt = await (options.receipt ?? { status: "delivered" as const });
            if (receipt.status === "delivered") {
              assert.ok(preparedResponse?.kind === "plan_review");
              terminal.resolve({ kind: "answered", response: { kind: "plan_review", action: preparedResponse.action,
                choiceId: preparedResponse.choiceId, planId: preparedResponse.planId, revision: preparedResponse.revision } });
            } else if (receipt.status === "rejected" && receipt.requestState === "unavailable") terminal.resolve({ kind: "rejected", error: receipt.error });
            return receipt;
          },
          async cancel() {
            cancels += 1; events.push("cancel");
            await options.cancel?.();
            outcome.resolve({ kind: "not_started" });
            output.resolve();
          },
        };
        if (options.noContinuation) return { kind: "no_continuation", ...control };
        const prepared: AgentPreparedSessionResponse = {
          kind: "native_continuation", ...control, outcome: outcome.promise,
          createExecution({ turnId, signal }) {
            executionSignal = signal;
            const selectedTurn = options.createExecution?.(turnId) ?? turnId;
            events.push("create_execution");
            return { turnId: selectedTurn, async resolveRequest() { return { status: "delivered" }; }, outputs: {
              [Symbol.asyncIterator]() {
                events.push("candidate_iterator");
                return (async function* () {
                  events.push("candidate_pull");
                  await output.promise;
                  if (signal.aborted) return;
                  if (options.outcome === "not_started") return;
                  const envelope = { protocolVersion: 12 as const, sessionId: context.sessionId, turnId, occurredAt: "2026-10-16T12:00:00.000Z" };
                  yield createAgentEventOutput({ ...envelope, type: "turn.started", payload: {} });
                  if (options.afterStarted) events.push("source_waiting");
                  await options.afterStarted;
                  if (options.afterStarted) events.push("source_released");
                  if (signal.aborted) return;
                  if (options.extraOutput) yield options.extraOutput(context, turnId);
                  yield createAgentEventOutput({ ...envelope, type: "turn.completed", payload: { outcome: "completed" } });
                  events.push("source_complete");
                })();
              },
            } };
          },
        };
        return prepared;
      },
    };
    assert.ok(context.interactions);
    publication = Promise.resolve(context.interactions.onRequest(candidate));
    void publication.catch(() => {});
    opened.resolve();
  };
  const adapter = validateAgentProviderAdapter(instance.capabilities, {
    ...instance.adapter,
    ...(options.hostBindingSupport === undefined ? {} : { hostBinding: options.hostBindingSupport }),
    sessionInteractions: { kind: "supported", mappings: [{ openingOperation: "create", requestKind: "plan_review" }], producerOwnership: "exclusive", humanWait: ["bounded", "until_withdrawn_or_closed"] },
    nativeContinuations: { kind: "supported", mappings: [{ openingOperation: "create", requestKind: "plan_review", timing: options.timing ?? "after_open_return" }], producerOwnership: "exclusive" },
    async createSession(input: AgentProviderCreateSessionInput) {
      events.push("candidate_open");
      if (options.beforeBinding) for (let index = 0; index < (options.offerCount ?? 1); index += 1) offer(input, index);
      await options.delayBinding;
      const native = await instance.adapter.createSession({ ...input, onBindingCreated(binding) { events.push("provider_binding"); input.onBindingCreated(binding); } });
      if (!options.beforeBinding) offer(input);
      await options.delayOpening;
      events.push("candidate_return");
      const session: AgentProviderSession = { ...native,
        startTurn(turn) { callerTurns += 1; return native.startTurn(turn); },
        async close(close) {
          nativeCloses += 1; events.push("native_close");
          controller.abort(); terminal.resolve({ kind: "session_closed" }); output.resolve();
          await options.close?.(); await native.close(close); events.push("native_closed");
        },
      };
      return session;
    },
  });
  const input: AgentCreateSessionInput = {
    sessionId: parseAgentSessionId("native-session"), workingDirectory: "/fixture/workspace",
    configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("fixture-config"), catalogRevision: 1, selections: [] },
    onBindingCreated() { events.push("binding"); },
  };
  return { adapter, input, fake, events, opened: opened.promise, preparationEntered: preparationEntered.promise,
    responseEntered: responseEntered.promise, outcome, controller, terminal, output,
    executionSignal: () => { assert.ok(executionSignal); return executionSignal; },
    request: () => request!, producer: () => producer!, publication: () => publication!,
    counts: () => ({ dispatches, cancels, callerTurns, nativeCloses }), dispose: () => instance.dispose() };
}
export function approve(request: AgentSessionRequest): AgentSessionResponse {
  assert.equal(request.kind, "plan_review");
  if (request.kind !== "plan_review") throw new Error("Expected plan fixture.");
  return { kind: "plan_review", action: "approve", choiceId: request.choices[0]!.choiceId, planId: request.plan.planId, revision: request.plan.revision };
}
