import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import {
  AgentProtocolValidationError,
  parseAgentApprovalOptionId,
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentItemId,
  parseAgentOutputSchema,
  parseAgentRequestId,
  parseAgentSessionId,
  parseAgentTurnId,
  type AgentCapabilities,
  type AgentOutputSchema,
  type AgentRequest,
  type AgentStructuredOutputRequest,
  type AgentStructuredOutputResult,
  type AgentTurnCompletedPayload,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  createAgentEventOutput,
  validateAgentProviderAdapter,
  type AgentCreateSessionInput,
  type AgentProviderAdapter,
  type AgentProviderCreateSessionInput,
  type AgentProviderDriver,
  type AgentProviderOutput,
  type AgentProviderResolveRequestInput,
  type AgentProviderSession,
  type AgentProviderSessionContext,
  type AgentProviderStartTurnInput,
  type AgentRequestResolutionResult,
} from "../src/index.js";
import { AgentProviderConformanceError, createFakeAgentProvider, runAgentProviderConformance, type AgentProviderConformanceScenario } from "../src/testing/index.js";
import { deferred, hasContractCode } from "./fixtures/hostBindings/harness.js";
import { approve, continuationFixture } from "./fixtures/nativeContinuations.js";

const titleSchema = parseAgentOutputSchema({ type: "object", properties: { title: { type: "string", minLength: 1 } }, required: ["title"], additionalProperties: false });
const countSchema = parseAgentOutputSchema({ type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"], additionalProperties: false });
const output = (schema: AgentOutputSchema = titleSchema): AgentStructuredOutputRequest => ({ kind: "json_schema", schema });
const configuration = { kind: "managed" as const, revision: parseAgentConfigurationRevisionId("structured-configuration") };
const error = { category: "unknown" as const, code: "native_failure", message: "Native execution failed.", recovery: { kind: "unknown" as const } };
const baseTurn = { interactionMode: "default" as const, parts: [{ type: "text" as const, text: "Return the requested object." }] };

function structuredCapability(scope: "turn" | "session", limits: { maxSchemaBytes?: number; maxOutputBytes?: number } = {}): AgentCapabilities["turns"]["structuredOutput"] {
  return { kind: "supported", mechanism: "native", schemaProfile: "agenai.output-schema.v1", scope, maxSchemaBytes: limits.maxSchemaBytes ?? 16_384, maxOutputBytes: limits.maxOutputBytes ?? 16_384, resume: false, branch: false };
}

function event(context: AgentProviderSessionContext, input: AgentProviderStartTurnInput, type: "turn.started" | "turn.completed", payload: unknown) {
  return createAgentEventOutput({ protocolVersion: 13, sessionId: context.sessionId, turnId: input.turnId, occurredAt: "2026-10-21T12:00:00.000Z", type, payload });
}

function terminal(context: AgentProviderSessionContext, input: AgentProviderStartTurnInput, structuredOutput: AgentStructuredOutputResult = { kind: "json", value: { title: "A useful title" } }) {
  return event(context, input, "turn.completed", { outcome: "completed", structuredOutput });
}

async function fixture(options: {
  readonly capability?: AgentCapabilities["turns"]["structuredOutput"];
  readonly outputs?: (context: AgentProviderSessionContext, turn: AgentProviderStartTurnInput) => AsyncIterable<AgentProviderOutput>;
  readonly resolveRequest?: (input: AgentProviderResolveRequestInput) => Promise<AgentRequestResolutionResult>;
  readonly beforeOpen?: (context: AgentProviderSessionContext) => Promise<void>;
  readonly beforeClose?: () => Promise<void>;
} = {}) {
  const defaults = createFakeAgentProvider().capabilities;
  const capabilities = parseAgentCapabilities({ ...defaults, configuration: { kind: "managed" },
    operations: { kind: "unsupported" }, managedContent: { kind: "unsupported" }, integrations: { kind: "unsupported" }, collaboration: { kind: "unsupported" }, generatedResources: { kind: "unsupported" },
    turns: { ...defaults.turns, structuredOutput: options.capability ?? structuredCapability("turn") } });
  const fake = createFakeAgentProvider({ capabilities });
  const instance = await fake.driver.materialize(fake.definition);
  const contexts: AgentProviderCreateSessionInput[] = [];
  const turns: AgentProviderStartTurnInput[] = [];
  const resolutions: AgentProviderResolveRequestInput[] = [];
  const counts = { creates: 0, resumes: 0, branches: 0, readers: 0, closes: 0, interrupts: 0, steers: 0 };
  const candidate = instance.adapter;
  assert.equal(candidate.resumption.kind, "supported");
  assert.equal(candidate.branching.kind, "through_turn");
  if (candidate.resumption.kind !== "supported" || candidate.branching.kind !== "through_turn") throw new Error("The fixture requires ordinary restoration support.");
  const resumption = candidate.resumption;
  const branching = candidate.branching;
  const wrap = (native: AgentProviderSession, context: AgentProviderSessionContext, openingOutput?: AgentStructuredOutputRequest): AgentProviderSession => ({
    ...native,
    startTurn(input) {
      turns.push(input);
      return {
        turnId: input.turnId,
        outputs: { [Symbol.asyncIterator]() {
          counts.readers += 1;
          return (async function* () {
            if (options.outputs) yield* options.outputs(context, input);
            else { yield event(context, input, "turn.started", {}); yield terminal(context, input, input.output || openingOutput ? { kind: "json", value: { title: "A useful title" } } : { kind: "not_requested" }); }
          })();
        } },
        async resolveRequest(input) { resolutions.push(input); return options.resolveRequest?.(input) ?? { status: "delivered" }; },
      };
    },
    interruption: { kind: "supported", interruptTurn() { counts.interrupts += 1; return { status: "accepted" }; } },
    steering: { kind: "supported", steerTurn() { counts.steers += 1; return { status: "delivered" }; } },
    async close(input) { counts.closes += 1; await options.beforeClose?.(); await native.close(input); },
  });
  const rawAdapter: AgentProviderAdapter = {
    ...candidate,
    async createSession(input) { counts.creates += 1; contexts.push(input); await options.beforeOpen?.(input); return wrap(await candidate.createSession(input), input, input.output); },
    resumption: { kind: "supported", async resumeSession(input) { counts.resumes += 1; return wrap(await resumption.resumeSession(input), input); } },
    branching: { kind: "through_turn", async branchSession(input) { counts.branches += 1; return wrap(await branching.branchSession(input), input); } },
  };
  const adapter = validateAgentProviderAdapter(capabilities, rawAdapter);
  const driver: AgentProviderDriver = { ...fake.driver, async materialize() { return { ...instance, adapter: rawAdapter }; } };
  let sequence = 0;
  const openInput = (overrides: Partial<AgentCreateSessionInput> = {}): AgentCreateSessionInput => ({ sessionId: parseAgentSessionId(`structured-session:${++sequence}`), workingDirectory: "/fixture/workspace", configuration, onBindingCreated() {}, ...overrides });
  return { adapter, driver, capabilities, contexts, turns, resolutions, counts, fake, openInput, dispose: () => instance.dispose() };
}

async function collect(execution: ReturnType<AgentProviderSession["startTurn"]>): Promise<AgentProviderOutput[]> {
  const outputs: AgentProviderOutput[] = [];
  for await (const entry of execution.outputs) outputs.push(entry);
  return outputs;
}

function completed(outputs: readonly AgentProviderOutput[]): AgentTurnCompletedPayload {
  const last = outputs.at(-1);
  assert.equal(last?.kind === "event" ? last.event.type : undefined, "turn.completed");
  if (last?.kind !== "event" || last.event.type !== "turn.completed") throw new Error("Expected a terminal event.");
  return last.event.payload;
}

test("structured admission rejects unsupported capability, wrong scope, invalid schemas and provider limits before native entry", async (t) => {
  const cases = [
    { name: "unsupported", capability: { kind: "unsupported" } as const, schema: titleSchema, code: "structured_output_unsupported" },
    { name: "session request on turn provider", capability: structuredCapability("turn"), schema: titleSchema, code: "structured_output_scope_mismatch", opening: true },
    { name: "turn request on session provider", capability: structuredCapability("session"), schema: titleSchema, code: "structured_output_scope_mismatch" },
    { name: "invalid portable schema", capability: structuredCapability("turn"), schema: { ...titleSchema, pattern: "not-portable" }, protocol: true },
    { name: "lower native schema limit", capability: structuredCapability("turn", { maxSchemaBytes: 40 }), schema: titleSchema, code: "invalid_structured_output" },
    { name: "impossible lower output limit", capability: structuredCapability("turn", { maxOutputBytes: 12 }), schema: titleSchema, protocol: true },
  ] as const;
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const f = await fixture({ capability: scenario.capability });
    t.after(() => f.dispose());
    const request = { kind: "json_schema" as const, schema: scenario.schema };
    const matches = (failure: unknown) => "protocol" in scenario ? failure instanceof AgentProtocolValidationError : failure instanceof AgentProviderContractError && failure.code === scenario.code;
    if ("opening" in scenario || scenario.name === "unsupported") {
      await assert.rejects(async () => f.adapter.createSession(f.openInput({ output: request })), matches);
      assert.equal(f.counts.creates, 0);
    }
    if (!("opening" in scenario)) {
      const session = await f.adapter.createSession(f.openInput());
      assert.throws(() => session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("rejected-structured"), output: request }), matches);
      assert.deepEqual(f.turns, []);
      const ordinary = await collect(session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("ordinary-after-rejection") }));
      assert.deepEqual(completed(ordinary), { outcome: "completed", structuredOutput: { kind: "not_requested" } });
      assert.equal(f.turns.length, 1);
      await session.close({ reason: "idle" });
    }
  });
});

test("pre-aborted structured opening and reserved turn keep the exact abort and never enter native work", async () => {
  const f = await fixture({ capability: structuredCapability("session") });
  const reason = new DOMException("Generation was canceled before dispatch.", "AbortError");
  const aborted = new AbortController(); aborted.abort(reason);
  await assert.rejects(async () => f.adapter.createSession(f.openInput({ output: output(), signal: aborted.signal })), (failure) => failure === reason);
  assert.equal(f.counts.creates, 0);
  const session = await f.adapter.createSession(f.openInput({ output: output() }));
  assert.throws(() => session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("pre-aborted"), signal: aborted.signal }), (failure) => failure === reason);
  const controller = new AbortController();
  const execution = session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("reserved-aborted"), signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(collect(execution), (failure) => failure === reason);
  assert.equal(f.turns.length, 0);
  const valid = await collect(session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("after-reserved-abort") }));
  assert.deepEqual(completed(valid), { outcome: "completed", structuredOutput: { kind: "json", value: { title: "A useful title" } } });
  await session.close({ reason: "idle" }); await f.dispose();
});

test("turn schemas are immutable snapshots and A, B and ordinary turns each retain their own result contract", async () => {
  const mutable = { type: "object" as const, properties: { title: { type: "string" as const, minLength: 1 } }, required: ["title"], additionalProperties: false as const };
  const f = await fixture({ async *outputs(context, input) {
    yield event(context, input, "turn.started", {});
    yield terminal(context, input, input.turnId === "schema-a" ? { kind: "json", value: { title: "Original contract" } } : input.turnId === "schema-b" ? { kind: "json", value: { count: 3 } } : { kind: "not_requested" });
  } });
  const session = await f.adapter.createSession(f.openInput());
  const first = session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("schema-a"), output: output(mutable) });
  mutable.properties.title.minLength = 100;
  mutable.required[0] = "changed";
  assert.deepEqual(completed(await collect(first)), { outcome: "completed", structuredOutput: { kind: "json", value: { title: "Original contract" } } });
  assert.deepEqual(f.turns[0]?.output, output(titleSchema));
  assert.equal(Object.isFrozen(f.turns[0]?.output?.schema.properties.title), true);
  assert.deepEqual(completed(await collect(session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("schema-b"), output: output(countSchema) }))), { outcome: "completed", structuredOutput: { kind: "json", value: { count: 3 } } });
  assert.deepEqual(completed(await collect(session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("plain") }))), { outcome: "completed", structuredOutput: { kind: "not_requested" } });
  assert.deepEqual(f.turns.map((input) => input.output?.schema), [titleSchema, countSchema, undefined]);
  assert.deepEqual([f.turns.length, f.counts.readers], [3, 3]);
  await session.close({ reason: "idle" }); await f.dispose();
});

test("session schema snapshots survive asynchronous opening and apply to every turn while overrides and removal are refused", async () => {
  const opening = deferred<void>();
  const entered = deferred<void>();
  const mutable = { type: "object" as const, properties: { title: { type: "string" as const, minLength: 1 } }, required: ["title"], additionalProperties: false as const };
  const f = await fixture({ capability: structuredCapability("session"), async beforeOpen() { entered.resolve(); await opening.promise; } });
  const pending = f.adapter.createSession(f.openInput({ output: output(mutable) }));
  await entered.promise;
  mutable.properties.title.minLength = 100; mutable.required[0] = "changed";
  opening.resolve();
  const session = await pending;
  assert.deepEqual(f.contexts[0]?.output, output(titleSchema));
  assert.equal(Object.isFrozen(f.contexts[0]?.output?.schema.properties.title), true);
  for (const turnId of ["inherited-first", "inherited-second"]) {
    assert.deepEqual(completed(await collect(session.startTurn({ ...baseTurn, turnId: parseAgentTurnId(turnId) }))), { outcome: "completed", structuredOutput: { kind: "json", value: { title: "A useful title" } } });
  }
  for (const override of [output(), output(countSchema), undefined]) {
    assert.throws(() => session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("override-refused"), output: override }), hasContractCode("structured_output_scope_mismatch"));
  }
  assert.deepEqual(f.turns.map((input) => Object.hasOwn(input, "output")), [false, false]);
  await session.close({ reason: "idle" }); await f.dispose();
});

test("resume, branch and steering cannot introduce or change output bindings", async () => {
  const f = await fixture();
  const source = await f.adapter.createSession(f.openInput());
  assert.equal(f.adapter.resumption.kind, "supported"); assert.equal(f.adapter.branching.kind, "through_turn");
  if (f.adapter.resumption.kind !== "supported" || f.adapter.branching.kind !== "through_turn") throw new Error("Expected restoration.");
  for (const forbidden of [output(), undefined]) {
    const resume = { ...f.openInput(), binding: source.binding, output: forbidden };
    const branch = { ...f.openInput(), source: { sessionId: f.contexts[0]!.sessionId, binding: source.binding, throughTurn: { turnId: parseAgentTurnId("source-turn"), historyAnchor: source.binding.historyAnchor! } }, output: forbidden };
    await assert.rejects(async () => f.adapter.resumption.kind === "supported" && f.adapter.resumption.resumeSession(resume), hasContractCode("structured_output_unsupported"));
    await assert.rejects(async () => f.adapter.branching.kind === "through_turn" && f.adapter.branching.branchSession(branch), hasContractCode("structured_output_unsupported"));
  }
  assert.deepEqual([f.counts.resumes, f.counts.branches], [0, 0]);
  const execution = source.startTurn({ ...baseTurn, turnId: parseAgentTurnId("steering-bound-turn"), output: output() });
  const iterator = execution.outputs[Symbol.asyncIterator](); await iterator.next();
  assert.equal(source.steering.kind, "supported");
  if (source.steering.kind !== "supported") throw new Error("Expected steering.");
  for (const forbidden of [output(), undefined]) {
    const input = { ...baseTurn, turnId: execution.turnId, output: forbidden };
    await assert.rejects(async () => source.steering.kind === "supported" && source.steering.steerTurn(input), hasContractCode("structured_output_scope_mismatch"));
  }
  assert.equal(f.counts.steers, 0);
  assert.deepEqual(await source.steering.steerTurn({ ...baseTurn, turnId: execution.turnId }), { status: "delivered" });
  assert.equal(f.counts.steers, 1);
  assert.equal((await iterator.next()).done, false); assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  await source.close({ reason: "idle" }); await f.dispose();
});

test("the runtime validates canonical candidate data independently and preserves completed outcome on schema mismatch", async () => {
  const f = await fixture({ async *outputs(context, input) { yield event(context, input, "turn.started", {}); yield terminal(context, input, { kind: "json", value: { title: 9 } }); } });
  const session = await f.adapter.createSession(f.openInput());
  const result = completed(await collect(session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("mismatched-value"), output: output() })));
  assert.deepEqual(result, { outcome: "completed", structuredOutput: { kind: "unavailable", reason: "schema_mismatch", issues: [{ code: "schema_mismatch", path: ["title"], message: "Value does not have the declared JSON type." }] } });
  assert.deepEqual([f.turns.length, f.counts.readers], [1, 1]);
  await session.close({ reason: "idle" }); await f.dispose();
});

test("observed unavailable reasons and non-success outcomes are preserved without manufacturing JSON", async (t) => {
  const payloads: AgentTurnCompletedPayload[] = [
    ...(["refused", "incomplete", "missing_output", "invalid_json", "output_limit_exceeded", "native_retries_exhausted", "provider_error"] as const).map((reason) => ({ outcome: "completed" as const, structuredOutput: { kind: "unavailable" as const, reason } })),
    { outcome: "failed", error, structuredOutput: { kind: "unavailable", reason: "provider_error" } },
    { outcome: "canceled", structuredOutput: { kind: "unavailable", reason: "incomplete" } },
    { outcome: "expired", structuredOutput: { kind: "unavailable", reason: "incomplete" } },
  ];
  for (const payload of payloads) await t.test(`${payload.outcome}/${payload.structuredOutput.kind === "unavailable" ? payload.structuredOutput.reason : "wrong"}`, async () => {
    const f = await fixture({ async *outputs(context, input) { yield event(context, input, "turn.started", {}); yield event(context, input, "turn.completed", payload); } });
    const session = await f.adapter.createSession(f.openInput());
    assert.deepEqual(completed(await collect(session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("unavailable"), output: output() }))), payload);
    assert.equal(f.turns.length, 1);
    await session.close({ reason: "idle" }); await f.dispose();
  });
});

test("provider output byte ceilings are rechecked at the validated session boundary", async () => {
  const f = await fixture({ capability: structuredCapability("turn", { maxOutputBytes: 16 }) });
  const session = await f.adapter.createSession(f.openInput());
  assert.deepEqual(completed(await collect(session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("native-output-limit"), output: output() }))), { outcome: "completed", structuredOutput: { kind: "unavailable", reason: "output_limit_exceeded" } });
  assert.equal(f.turns.length, 1);
  await session.close({ reason: "idle" }); await f.dispose();
});

test("requested mode, correlation and terminal ordering reject malformed adapters and fence later mutation", async (t) => {
  const scenarios = ["requested_not_requested", "ordinary_json", "ordinary_unavailable", "wrong_turn", "duplicate_terminal", "post_terminal", "missing_terminal", "failed_json", "canceled_json", "expired_json"] as const;
  for (const scenario of scenarios) await t.test(scenario, async () => {
    const f = await fixture({ async *outputs(context, input) {
      yield event(context, input, "turn.started", {});
      if (scenario === "missing_terminal") return;
      if (scenario === "wrong_turn") { yield terminal(context, { ...input, turnId: parseAgentTurnId("foreign-turn") }); return; }
      if (scenario === "requested_not_requested") { yield terminal(context, input, { kind: "not_requested" }); return; }
      if (scenario === "ordinary_unavailable") { yield terminal(context, input, { kind: "unavailable", reason: "missing_output" }); return; }
      if (scenario === "failed_json" || scenario === "canceled_json" || scenario === "expired_json") {
        const outcome = scenario === "failed_json" ? "failed" : scenario === "canceled_json" ? "canceled" : "expired";
        // Deliberately malformed external adapter data bypasses the convenience constructor.
        yield { kind: "event", event: { protocolVersion: 13, sessionId: context.sessionId, turnId: input.turnId, occurredAt: "2026-10-21T12:00:00.000Z", type: "turn.completed", payload: { outcome, ...(outcome === "failed" ? { error } : {}), structuredOutput: { kind: "json", value: { title: "Must not escape" } } } } } as unknown as AgentProviderOutput;
        return;
      }
      yield terminal(context, input);
      if (scenario === "duplicate_terminal") yield terminal(context, input);
      if (scenario === "post_terminal") yield event(context, input, "turn.started", {});
    } });
    const session = await f.adapter.createSession(f.openInput());
    const ordinary = scenario.startsWith("ordinary_");
    const execution = session.startTurn({ ...baseTurn, turnId: parseAgentTurnId(`invalid-${scenario}`), ...(ordinary ? {} : { output: output() }) });
    const expected = scenario === "wrong_turn" ? "output_turn_mismatch" : ["duplicate_terminal", "post_terminal", "missing_terminal"].includes(scenario) ? "invalid_turn_sequence" : "invalid_structured_output";
    await assert.rejects(collect(execution), (failure) => scenario.endsWith("_json") && !ordinary ? failure instanceof AgentProtocolValidationError : hasContractCode(expected)(failure));
    assert.throws(() => session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("after-contract-failure") }), hasContractCode("session_unusable"));
    assert.deepEqual([f.turns.length, f.counts.readers], [1, 1]);
    await session.close({ reason: "contract_rejected" }); await f.dispose();
  });
});

const itemId = parseAgentItemId("structured-item");
const request: AgentRequest = { requestKind: "approval", requestId: parseAgentRequestId("structured-approval"), prompt: "Allow this action?", subject: { kind: "other", title: "Action", itemId }, options: [{ optionId: parseAgentApprovalOptionId("allow"), label: "Allow once", decision: "approved", consequence: { kind: "scoped", persistence: "once", scope: { kind: "exact_action" } } }] };
const resolution = { requestKind: "approval" as const, requestId: request.requestId, disposition: "selected" as const, optionId: parseAgentApprovalOptionId("allow") };

test("structured output retains the original pending reader and exact response receipt even when native delivery is uncertain", async (t) => {
  for (const uncertain of [false, true]) await t.test(uncertain ? "uncertain" : "delivered", async () => {
    const finish = deferred<void>();
    const acknowledgment = deferred<AgentRequestResolutionResult>();
    const f = await fixture({ resolveRequest: () => acknowledgment.promise, async *outputs(context, input) {
      yield event(context, input, "turn.started", {});
      const base = { protocolVersion: 13 as const, sessionId: context.sessionId, turnId: input.turnId, occurredAt: "2026-10-21T12:00:00.000Z" };
      yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId, itemKind: "assistant_message", status: "in_progress" } });
      yield createAgentEventOutput({ ...base, type: "request.opened", payload: { request } });
      yield createAgentEventOutput({ ...base, type: "turn.state_changed", payload: { state: "waiting_for_request", requestId: request.requestId } });
      await finish.promise;
      yield terminal(context, input);
    } });
    const session = await f.adapter.createSession(f.openInput());
    const execution = session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("structured-human-wait"), output: output() });
    const iterator = execution.outputs[Symbol.asyncIterator]();
    for (let index = 0; index < 4; index += 1) await iterator.next();
    const pending = iterator.next();
    let delivered = false;
    const answer = execution.resolveRequest({ resolution }).then((receipt) => { delivered = true; return receipt; });
    await Promise.resolve();
    assert.deepEqual([delivered, f.turns.length, f.counts.readers, f.resolutions.length], [false, 1, 1, 1]);
    acknowledgment.resolve(uncertain ? { status: "delivery_uncertain", error } : { status: "delivered" });
    assert.deepEqual(await answer, uncertain ? { status: "delivery_uncertain", error } : { status: "delivered" });
    assert.deepEqual(f.resolutions.map((input) => input.resolution), [resolution]);
    await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode(uncertain ? "session_unusable" : "request_resolution_mismatch"));
    if (uncertain) assert.throws(() => session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("fenced-structured") }), hasContractCode("session_unusable"));
    finish.resolve();
    const last = await pending;
    assert.equal(last.done, false);
    assert.deepEqual(completed(last.done ? [] : [last.value]), { outcome: "completed", structuredOutput: { kind: "json", value: { title: "A useful title" } } });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    assert.deepEqual([f.turns.length, f.counts.readers, f.resolutions.length], [1, 1, 1]);
    await session.close({ reason: "idle" }); await f.dispose();
  });
});

test("cancellation during structured streaming or request waiting closes the entered native owner without a result or answer replay", async (t) => {
  for (const waitingForRequest of [false, true]) await t.test(waitingForRequest ? "request waiting" : "streaming", async () => {
    const release = deferred<void>();
    const f = await fixture({ async beforeClose() { release.resolve(); }, async *outputs(context, input) {
      yield event(context, input, "turn.started", {});
      const base = { protocolVersion: 13 as const, sessionId: context.sessionId, turnId: input.turnId, occurredAt: "2026-10-21T12:00:00.000Z" };
      yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId, itemKind: "assistant_message", status: "in_progress" } });
      yield createAgentEventOutput(waitingForRequest
        ? { ...base, type: "request.opened", payload: { request } }
        : { ...base, type: "content.delta", payload: { itemId, streamKind: "assistant_text", delta: "Partial narrative is not a structured result." } });
      await release.promise;
      yield terminal(context, input);
    } });
    const session = await f.adapter.createSession(f.openInput());
    const controller = new AbortController();
    const reason = new DOMException("Canceled during native output.", "AbortError");
    const execution = session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("cancel-native-output"), output: output(), signal: controller.signal });
    const iterator = execution.outputs[Symbol.asyncIterator](); await iterator.next(); await iterator.next(); await iterator.next();
    const pending = iterator.next();
    controller.abort(reason);
    await assert.rejects(pending, (failure) => failure === reason);
    await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("session_unusable"));
    await session.close({ reason: "shutdown" });
    assert.deepEqual([f.turns.length, f.counts.readers, f.resolutions.length, f.counts.closes], [1, 1, 0, 1]);
    await f.dispose();
  });
});

test("a failed structured-session close retains its original native owner and retry never replays generation", async () => {
  let fail = true;
  const closeFailure = new Error("Native shutdown has not quiesced.");
  const f = await fixture({ async beforeClose() { if (fail) throw closeFailure; } });
  const session = await f.adapter.createSession(f.openInput());
  assert.deepEqual(completed(await collect(session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("close-retains-result"), output: output() }))), { outcome: "completed", structuredOutput: { kind: "json", value: { title: "A useful title" } } });
  await assert.rejects(async () => session.close({ reason: "idle" }), (failure) => failure === closeFailure);
  assert.throws(() => session.startTurn({ ...baseTurn, turnId: parseAgentTurnId("after-failed-close") }), hasContractCode("session_unusable"));
  fail = false;
  await Promise.all([session.close({ reason: "idle" }), session.close({ reason: "idle" })]);
  await session.close({ reason: "idle" });
  assert.deepEqual([f.turns.length, f.counts.readers, f.counts.closes], [1, 1, 2]);
  await f.dispose();
});

test("bound native continuation is canceled before execution or answer dispatch while no-continuation responses remain usable", async (t) => {
  for (const noContinuation of [false, true]) await t.test(noContinuation ? "no continuation" : "native continuation", async () => {
    const defaults = createFakeAgentProvider().capabilities;
    const capabilities = parseAgentCapabilities({ ...defaults, turns: { ...defaults.turns, structuredOutput: structuredCapability("session") } });
    const f = await continuationFixture({ capabilities, noContinuation });
    let reads = 0;
    const interaction = deferred<Parameters<NonNullable<AgentCreateSessionInput["interactions"]>["onRequest"]>[0]>();
    const session = await f.adapter.createSession({ ...f.input, output: output(),
      interactions: { onRequest(value) { interaction.resolve(value); } },
      nativeContinuations: { onExecution() { reads += 1; } },
    });
    const request = await interaction.promise;
    if (noContinuation) assert.deepEqual(await request.respond(approve(request.request)), { status: "delivered" });
    else await assert.rejects(request.respond(approve(request.request)), hasContractCode("structured_output_unsupported"));
    await setImmediate();
    assert.deepEqual(f.counts(), { dispatches: noContinuation ? 1 : 0, cancels: noContinuation ? 0 : 1, callerTurns: 0, nativeCloses: 0 });
    assert.deepEqual([reads, f.events.includes("create_execution"), f.events.includes("candidate_iterator")], [0, false, false]);
    await session.close({ reason: "idle" }); await f.dispose();
  });
});

test("public conformance requires real supported fixtures and qualifies schema lifetime for both native scopes", async (t) => {
  for (const mode of ["turn", "session", "missing_fixture", "invalid_candidate", "late_terminal"] as const) await t.test(mode, async () => {
    const scope = mode === "session" ? "session" : "turn";
    const f = await fixture({ capability: structuredCapability(scope), async *outputs(context, input) {
      yield event(context, input, "turn.started", {});
      const requested = input.turnId === "conformance-structured-first" || input.turnId === "conformance-structured-second";
      yield terminal(context, input, requested ? { kind: "json", value: mode === "invalid_candidate" ? { title: 9 } : scope === "turn" && input.turnId === "conformance-structured-second" ? { count: 3 } : { title: "A useful title" } } : { kind: "not_requested" });
      if (mode === "late_terminal" && requested) yield terminal(context, input);
    } });
    const scenario: AgentProviderConformanceScenario = {
      driver: f.driver, definition: f.fake.definition, workingDirectory: "/fixture/workspace", configuration,
      createSessionId: parseAgentSessionId("conformance-create"), resumeSessionId: parseAgentSessionId("conformance-resume"),
      branchSessionId: parseAgentSessionId("conformance-branch"), abortedSessionId: parseAgentSessionId("conformance-abort"), interruptionSessionId: parseAgentSessionId("conformance-interrupt"),
      turn: { ...baseTurn, turnId: parseAgentTurnId("conformance-ordinary") }, interruptionTurn: { ...baseTurn, turnId: parseAgentTurnId("conformance-interruption") },
      resolutionFor() { throw new Error("This native fixture never requests a human answer."); },
      branchSource(binding, turnId) { return { sessionId: parseAgentSessionId("conformance-create"), binding, throughTurn: { turnId, historyAnchor: binding.historyAnchor! } }; },
      ...(mode === "missing_fixture" ? {} : { structuredOutput: {
        sessionId: parseAgentSessionId("conformance-structured-session"), plainSessionId: parseAgentSessionId("conformance-plain-session"), schema: titleSchema, alternateSchema: countSchema,
        turns: [
          { turn: { ...baseTurn, turnId: parseAgentTurnId("conformance-structured-first") }, expectedValue: { title: "A useful title" } },
          { turn: { ...baseTurn, turnId: parseAgentTurnId("conformance-structured-second") }, expectedValue: scope === "turn" ? { count: 3 } : { title: "A useful title" } },
        ], plainTurn: { ...baseTurn, turnId: parseAgentTurnId("conformance-plain-after") },
      } }),
    };
    if (mode === "missing_fixture" || mode === "invalid_candidate" || mode === "late_terminal") {
      await assert.rejects(runAgentProviderConformance(scenario), (failure) => mode === "late_terminal"
        ? hasContractCode("invalid_turn_sequence")(failure)
        : failure instanceof AgentProviderConformanceError && failure.check === "structured_output");
      assert.equal(f.turns.length, mode === "missing_fixture" ? 0 : 1);
    } else {
      const report = await runAgentProviderConformance(scenario);
      assert.deepEqual(report.checks.filter((check) => check.startsWith("structured_output")), ["structured_output", "structured_output_lifetime"]);
      assert.deepEqual(f.turns.slice(0, 3).map((input) => input.turnId), ["conformance-structured-first", "conformance-structured-second", "conformance-plain-after"]);
      assert.equal(f.fake.snapshot().instanceDisposeCount, 1);
      assert.equal(f.counts.creates, scope === "session" ? 4 : 3);
    }
    await f.dispose();
  });
});
