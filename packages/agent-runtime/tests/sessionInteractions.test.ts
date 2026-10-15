// ------------------------------------------------------------------------------------------------
//                sessionInteractions.test.ts - Public session decision authority and owned cleanup
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import {
  AgentProtocolValidationError, parseAgentConfigurationRevisionId, parseAgentIsoDateTime, parseAgentItemId, parseAgentOperationId,
  parseAgentOperationInvocationId, parseAgentSessionDecisionChoiceId, parseAgentSessionDecisionRequest,
  parseAgentSessionId, parseAgentTurnId, type AgentError,
} from "@agen-ai/agent-protocol";
import {
  AgentProviderSessionCleanupError, createAgentEventOutput,
  createAgentProviderSessionCleanupError, isAgentProviderSessionCleanupErrorFor,
  type AgentProviderCreateSessionInput, type AgentProviderOutput, type AgentProviderSession,
  type AgentProviderSessionContext, type AgentRequestResolutionResult, type AgentSessionInteraction,
  type AgentSessionInteractionContext, type AgentSessionInteractionSupport, type AgentSessionInteractionTerminal,
} from "../src/index.js";
import { createHarness, deferred, hasContractCode, makeBinding, type OpeningKind } from "./fixtures/hostBindings/harness.js";

const grant = parseAgentSessionDecisionChoiceId("trust-workspace");
const decline = parseAgentSessionDecisionChoiceId("leave-gated");
const refusal: AgentError = { category: "permission", code: "native_decision_refused", message: "Native decision refused.", recovery: { kind: "none" } };
const uncertainty: AgentError = { category: "unknown", code: "native_delivery_uncertain", message: "Native answer acceptance is uncertain.", recovery: { kind: "unknown" } };
const supported: AgentSessionInteractionSupport = {
  kind: "supported", openingOperations: ["create", "resume", "branch"], requestKinds: ["decision"], producerOwnership: "exclusive",
};
const turnInput = { turnId: parseAgentTurnId("decision-turn"), interactionMode: "default" as const, parts: [{ type: "text" as const, text: "Continue the actual turn." }] };

function decision(context: AgentProviderSessionContext, id = "session-decision", large = false, expiresAt?: string) {
  const choices = large ? Array.from({ length: 16 }, (_, index) => ({
    choiceId: `choice-${index}`, label: `Choice ${index}`, description: "d".repeat(1_000), consequence: { kind: "decline", configuration: "remains_gated" },
  })) : [
    { choiceId: grant, label: "Trust workspace", description: "Persist workspace configuration authority, including later and sibling sessions.",
      consequence: { kind: "grant", scope: "workspace", persistence: { kind: "provider_managed", duration: "persistent", mayAffectOtherSessions: true } } },
    { choiceId: decline, label: "Leave gated", description: "Keep the workspace configuration gated.", consequence: { kind: "decline", configuration: "remains_gated" } },
  ];
  return parseAgentSessionDecisionRequest({ kind: "decision", requestId: id, sessionId: context.sessionId,
    title: "Workspace configuration", description: large ? "r".repeat(4_000) : "Choose how this workspace configuration is loaded.",
    target: { kind: "workspace", path: "/configuration/workspace" }, expiresAt: expiresAt ?? new Date(Date.now() + 60_000).toISOString(), choices });
}

function nativeOffer(context: AgentProviderSessionContext, options: {
  id?: string;
  large?: boolean;
  expiresAt?: string;
  respond?: AgentSessionInteraction["respond"];
} = {}) {
  const controller = new AbortController();
  const terminal = deferred<AgentSessionInteractionTerminal>();
  const entered = deferred<void>();
  const active = new Set<Promise<unknown>>();
  const answers: string[] = [];
  let terminalSettled = false;
  let stopped = false;
  const settle = (value: AgentSessionInteractionTerminal) => {
    if (terminalSettled) return;
    terminalSettled = true;
    terminal.resolve(value);
  };
  const handle: AgentSessionInteraction = {
    request: decision(context, options.id, options.large, options.expiresAt), signal: controller.signal, terminal: terminal.promise,
    respond(input) {
      answers.push(input.choiceId);
      entered.resolve();
      const work = (async () => {
        try {
          const result = await (options.respond?.(input) ?? { status: "delivered" as const });
          if (result.status === "delivered") settle({ kind: "answered", choiceId: input.choiceId });
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
    context, handle, answers, entered: entered.promise, completion: Promise.resolve(),
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

async function scenario(options: {
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

function includesCause(error: unknown, cause: unknown): boolean {
  return error === cause || (error instanceof AggregateError && error.errors.some((entry: unknown) => includesCause(entry, cause)))
    || (error instanceof Error && error.cause !== undefined && includesCause(error.cause, cause));
}

test("create, resume and branch publish pending decisions and accept immediate bound responses", async (t) => {
  for (const kind of ["create", "resume", "branch"] satisfies OpeningKind[]) await t.test(kind, async () => {
    const fixture = await scenario();
    t.after(() => fixture.dispose());
    let interaction: AgentSessionInteraction | undefined;
    let receipt: Promise<AgentRequestResolutionResult> | undefined;
    const session = await fixture.open(kind, undefined, { interactions: { onRequest(value) {
      interaction = value;
      receipt = value.respond({ choiceId: grant });
    } } });
    assert.ok(interaction && receipt);
    assert.deepEqual(fixture.offers[0]!.answers, ["trust-workspace"], "The immediate response enters while the provider opening is in progress.");
    assert.deepEqual(await receipt, { status: "delivered" });
    assert.deepEqual(await interaction.terminal, { kind: "answered", choiceId: grant });
    assert.deepEqual(fixture.offers[0]!.answers, ["trust-workspace"]);
    assert.notEqual(interaction, fixture.offers[0]!.handle);
    assert.equal(interaction.request.target.path, "/configuration/workspace");
    await session.close({ reason: "idle" });
  });
});

test("a callback awaiting publication remains pending after opening and opening abort loses no adopted authority", async (t) => {
  const published = deferred<void>();
  const finished = deferred<void>();
  const controller = new AbortController();
  const fixture = await scenario({ cleanup: () => published.resolve() });
  t.after(() => fixture.dispose());
  let handle: AgentSessionInteraction | undefined;
  const session = await fixture.open("create", undefined, { signal: controller.signal, interactions: { async onRequest(value) {
    handle = value;
    await published.promise;
    assert.deepEqual(await value.respond({ choiceId: decline }), { status: "delivered" });
    finished.resolve();
  } } });
  assert.ok(handle);
  assert.deepEqual(fixture.offers[0]!.answers, []);
  controller.abort(new DOMException("Opening scope has finished.", "AbortError"));
  assert.equal(handle.signal.aborted, false);
  published.resolve();
  await finished.promise;
  assert.deepEqual(await handle.terminal, { kind: "answered", choiceId: decline });
  assert.deepEqual(fixture.offers[0]!.answers, ["leave-gated"]);
  await session.close({ reason: "idle" });
});

test("malformed, pre-aborted and concurrent responses never enter a second native answer", async (t) => {
  const acknowledgment = deferred<AgentRequestResolutionResult>();
  const fixture = await scenario({ openingOfferOptions: { respond: () => acknowledgment.promise }, cleanup: () => acknowledgment.resolve({ status: "delivered" }) });
  t.after(() => fixture.dispose());
  let handle: AgentSessionInteraction | undefined;
  const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
  assert.ok(handle);
  const candidate = fixture.offers[0]!;
  const abort = new AbortController();
  const reason = new DOMException("Response already aborted.", "AbortError");
  abort.abort(reason);
  await assert.rejects(handle.respond({ choiceId: grant, signal: abort.signal }), (error: unknown) => error === reason);
  await assert.rejects(handle.respond({ choiceId: parseAgentSessionDecisionChoiceId("unoffered") }), (error: unknown) => error instanceof AgentProtocolValidationError);
  assert.equal(candidate.answers.length, 0);
  const first = handle.respond({ choiceId: grant });
  await candidate.entered;
  const duplicate = await handle.respond({ choiceId: decline });
  assert.equal(duplicate.status, "rejected");
  if (duplicate.status !== "rejected") throw new Error("Expected bound duplicate rejection.");
  assert.equal(duplicate.requestState, "pending");
  assert.equal(duplicate.error.code, "session_interaction_response_active");
  acknowledgment.resolve({ status: "delivered" });
  assert.deepEqual(await first, { status: "delivered" });
  assert.deepEqual(candidate.answers, ["trust-workspace"]);
  const late = await handle.respond({ choiceId: decline });
  assert.equal(late.status, "rejected");
  if (late.status !== "rejected") throw new Error("Expected terminal rejection.");
  assert.equal(late.requestState, "unavailable");
  assert.equal(late.error.code, "session_interaction_unavailable");
  await session.close({ reason: "idle" });
});

test("stale bound handles cannot answer a fresh session generation with the same displayed request ID", async (t) => {
  const fixture = await scenario();
  t.after(() => fixture.dispose());
  const handles: AgentSessionInteraction[] = [];
  const interactions: AgentSessionInteractionContext = { onRequest(value) { handles.push(value); } };
  const first = await fixture.open("create", undefined, { interactions });
  await first.close({ reason: "idle" });
  const next = await fixture.open("resume", undefined, { interactions });
  const stale = await handles[0]!.respond({ choiceId: grant });
  assert.equal(stale.status, "rejected");
  if (stale.status !== "rejected") throw new Error("Expected retired response authority.");
  assert.deepEqual([stale.requestState, stale.error.code], ["unavailable", "session_interaction_unavailable"]);
  assert.deepEqual(fixture.offers.map((candidate) => candidate.answers), [[], []]);
  assert.deepEqual(await handles[1]!.respond({ choiceId: decline }), { status: "delivered" });
  assert.deepEqual(fixture.offers.map((candidate) => candidate.answers), [[], ["leave-gated"]]);
  assert.deepEqual(await handles[0]!.terminal, { kind: "session_closed" });
  assert.deepEqual(await handles[1]!.terminal, { kind: "answered", choiceId: decline });
  await next.close({ reason: "idle" });
});

test("close fences new answers while preserving the actual receipt of an already entered response", async (t) => {
  for (const outcome of ["delivered", "pending-refusal"] as const) await t.test(outcome, async () => {
    const acknowledgment = deferred<AgentRequestResolutionResult>();
    const host = makeBinding();
    const fixture = await scenario({ openingOfferOptions: { respond: () => acknowledgment.promise }, cleanup: () => acknowledgment.resolve({ status: "delivered" }) });
    t.after(() => fixture.dispose());
    let handle: AgentSessionInteraction | undefined;
    const session = await fixture.open("create", host.binding, { interactions: { onRequest(value) { handle = value; } } });
    assert.ok(handle);
    const answer = handle.respond({ choiceId: grant });
    await fixture.offers[0]!.entered;
    let closed = false;
    const closing = Promise.resolve(session.close({ reason: "idle" })).then(() => { closed = true; });
    await fixture.nativeCloseEntered;
    const late = await handle.respond({ choiceId: decline });
    assert.equal(late.status, "rejected");
    if (late.status !== "rejected") throw new Error("Expected stopped response authority.");
    assert.deepEqual([late.requestState, late.error.code], ["unavailable", "session_interaction_unavailable"]);
    assert.deepEqual([closed, host.releaseCount(), fixture.offers[0]!.answers], [false, 0, ["trust-workspace"]]);
    acknowledgment.resolve(outcome === "delivered" ? { status: "delivered" } : { status: "rejected", requestState: "pending", error: refusal });
    const result = await answer;
    if (outcome === "delivered") {
      assert.deepEqual(result, { status: "delivered" });
      assert.deepEqual(await handle.terminal, { kind: "answered", choiceId: grant });
    } else {
      assert.equal(result.status, "rejected");
      if (result.status !== "rejected") throw new Error("Expected refusal after stopping.");
      assert.equal(result.requestState, "unavailable");
      assert.deepEqual(await handle.terminal, { kind: "session_closed" });
    }
    await closing;
    assert.deepEqual([closed, host.releaseCount(), fixture.closes()], [true, 1, 1]);
  });
});

test("native withdrawal leaves a healthy session usable without interpreting withdrawal as a choice", async (t) => {
  const fixture = await scenario();
  t.after(() => fixture.dispose());
  let handle: AgentSessionInteraction | undefined;
  const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
  assert.ok(handle);
  fixture.offers[0]!.withdraw();
  assert.deepEqual(await handle.terminal, { kind: "withdrawn" });
  const late = await handle.respond({ choiceId: grant });
  assert.equal(late.status, "rejected");
  if (late.status !== "rejected") throw new Error("Expected withdrawn response authority.");
  assert.equal(late.requestState, "unavailable");
  const outputs: AgentProviderOutput[] = [];
  const execution = session.startTurn(turnInput);
  for await (const output of execution.outputs) {
    outputs.push(output);
    if (output.kind === "event" && output.event.type === "request.opened") {
      const request = output.event.payload.request;
      if (request.requestKind !== "approval") throw new Error("Expected the existing fake provider's approval request.");
      assert.deepEqual(await execution.resolveRequest({ resolution: { requestKind: "approval", requestId: request.requestId,
        disposition: "selected", optionId: request.options[0]!.optionId } }), { status: "delivered" });
    }
  }
  const terminal = outputs.at(-1);
  assert.equal(terminal?.kind === "event" ? terminal.event.type : null, "turn.completed");
  assert.deepEqual([fixture.offers[0]!.answers, fixture.closes()], [[], 0]);
  await session.close({ reason: "idle" });
});

test("uncertain session answers fence future mutation while the entered output reader still drains", async (t) => {
  const continueOutput = deferred<void>();
  let starts = 0;
  const fixture = await scenario({ openingOffer: false, cleanup: () => continueOutput.resolve(), transformSession(session, context) {
    return { ...session, startTurn(input) {
      starts += 1;
      const base = { protocolVersion: 11 as const, sessionId: context.sessionId, turnId: input.turnId, occurredAt: parseAgentIsoDateTime("2026-10-13T00:00:00.000Z") };
      const itemId = parseAgentItemId("decision-output");
      return { turnId: input.turnId, async resolveRequest() { throw new Error("This turn has no turn-scoped requests."); }, outputs: (async function* () {
        yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
        yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId, itemKind: "assistant_message", status: "in_progress" } });
        yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId, streamKind: "assistant_text", delta: "Before the session answer." } });
        await continueOutput.promise;
        yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId, streamKind: "assistant_text", delta: "After uncertain delivery." } });
        yield createAgentEventOutput({ ...base, type: "item.completed", payload: { itemId, itemKind: "assistant_message", status: "completed" } });
        yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "completed" } });
      })() };
    } };
  } });
  t.after(() => fixture.dispose());
  let handle: AgentSessionInteraction | undefined;
  const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
  const iterator = session.startTurn(turnInput).outputs[Symbol.asyncIterator]();
  const first = [await iterator.next(), await iterator.next(), await iterator.next()];
  assert.deepEqual(first.map((entry) => !entry.done && entry.value.kind === "event" ? entry.value.event.type : null), ["turn.started", "item.started", "content.delta"]);
  const candidate = fixture.offer(fixture.contexts[0]!, { respond: async () => ({ status: "delivery_uncertain", error: uncertainty }) });
  assert.ok(handle);
  assert.deepEqual(await handle.respond({ choiceId: grant }), { status: "delivery_uncertain", error: uncertainty });
  assert.deepEqual(await handle.terminal, { kind: "delivery_uncertain", error: uncertainty });
  assert.throws(() => session.startTurn(turnInput), hasContractCode("session_unusable"));
  assert.deepEqual([starts, fixture.closes(), candidate.answers], [1, 0, ["trust-workspace"]]);
  continueOutput.resolve();
  const tail: AgentProviderOutput[] = [];
  for (;;) { const next = await iterator.next(); if (next.done) break; tail.push(next.value); }
  assert.deepEqual(tail.map((entry) => entry.kind === "event" ? entry.event.type : entry.kind), ["content.delta", "item.completed", "turn.completed"]);
  assert.equal(tail[0]?.kind === "event" && tail[0].event.type === "content.delta" ? tail[0].event.payload.delta : null, "After uncertain delivery.");
  await session.close({ reason: "idle" });
});

test("uncertainty during awaited inventory prevents configuration and operation entry", async (t) => {
  for (const port of ["configuration", "operation"] as const) await t.test(port, async () => {
    const inventoryEntered = deferred<void>();
    const releaseInventory = deferred<void>();
    let mutations = 0;
    let boundaries = 0;
    const fixture = await scenario({ openingOffer: false, cleanup: () => releaseInventory.resolve(), transformSession(session) {
      assert.equal(session.configuration.kind, "selectable");
      assert.equal(session.operations.kind, "supported");
      if (session.configuration.kind !== "selectable" || session.operations.kind !== "supported") throw new Error("Expected the real fake provider's selectable ports.");
      const configuration = session.configuration;
      const operations = session.operations;
      return { ...session,
        configuration: { ...configuration, async listConfiguration(input) { inventoryEntered.resolve(); await releaseInventory.promise; return configuration.listConfiguration(input); },
          applyConfigurationSelection(input) { mutations += 1; return configuration.applyConfigurationSelection(input); } },
        operations: { ...operations, async listOperations(input) { inventoryEntered.resolve(); await releaseInventory.promise; return operations.listOperations(input); },
          invokeOperation(input) { mutations += 1; return operations.invokeOperation(input); } },
      };
    } });
    t.after(() => fixture.dispose());
    let handle: AgentSessionInteraction | undefined;
    const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
    if (session.configuration.kind !== "selectable" || session.operations.kind !== "supported") throw new Error("Expected selectable public ports.");
    const mutation = port === "configuration" ? Promise.resolve(session.configuration.applyConfigurationSelection({
      selection: { key: "model", expectedCatalogRevision: 1, expectedFieldRevision: 1, value: { fieldKind: "single_select", optionId: "fake-model-2" } },
      onProviderExecutionStarted: () => { boundaries += 1; },
    })) : Promise.resolve(session.operations.invokeOperation({
      invocation: { invocationId: parseAgentOperationInvocationId("decision-control"), operationId: parseAgentOperationId("fake.session.reset"), expectedRevision: 1, values: [] },
      observationTurnId: parseAgentTurnId("decision-control"), onProviderExecutionStarted: () => { boundaries += 1; },
    }));
    const refused = assert.rejects(mutation, hasContractCode("session_unusable"));
    await inventoryEntered.promise;
    fixture.offer(fixture.contexts[0]!, { respond: async () => ({ status: "delivery_uncertain", error: uncertainty }) });
    assert.ok(handle);
    assert.deepEqual(await handle.respond({ choiceId: grant }), { status: "delivery_uncertain", error: uncertainty });
    releaseInventory.resolve();
    await refused;
    assert.deepEqual([mutations, boundaries], [0, 0]);
    await session.close({ reason: "idle" });
  });
});

test("answered requests retain count and byte capacity until the actual host callbacks join", async (t) => {
  for (const capacity of ["count", "bytes"] as const) await t.test(capacity, async () => {
    const releaseCallbacks = deferred<void>();
    const accepted: ReturnType<typeof deferred<void>>[] = [];
    const published: AgentSessionInteraction[] = [];
    const host = makeBinding();
    const fixture = await scenario({ openingOffer: false, cleanup: () => releaseCallbacks.resolve() });
    t.after(() => fixture.dispose());
    const session = await fixture.open("create", host.binding, { interactions: {
      limits: { maxRetainedRequests: capacity === "count" ? 1 : 32, maxRetainedBytes: 65_536 },
      async onRequest(value) {
        published.push(value);
        const receipt = deferred<void>();
        accepted.push(receipt);
        assert.deepEqual(await value.respond({ choiceId: value.request.choices[0].choiceId }), { status: "delivered" });
        receipt.resolve();
        await releaseCallbacks.promise;
      },
    } });
    const retained = capacity === "count" ? 1 : 2;
    for (let index = 0; index < retained; index += 1) {
      fixture.offer(fixture.contexts[0]!, { id: `capacity-${index}`, large: capacity === "bytes" });
      await accepted[index]!.promise;
      assert.deepEqual(await published[index]!.terminal, { kind: "answered", choiceId: published[index]!.request.choices[0].choiceId });
    }
    const overflow = fixture.offer(fixture.contexts[0]!, { id: "capacity-overflow", large: capacity === "bytes" });
    if (capacity === "bytes") {
      const sizes = fixture.offers.map((candidate) => Buffer.byteLength(JSON.stringify(candidate.handle.request)));
      assert.ok(sizes.slice(0, retained).reduce((total, size) => total + size, 0) <= 65_536);
      assert.ok(sizes.reduce((total, size) => total + size, 0) > 65_536);
    }
    await assert.rejects(overflow.completion, hasContractCode("invalid_session_interaction"));
    await fixture.nativeCloseEntered;
    assert.deepEqual([published.length, overflow.answers, host.releaseCount()], [retained, [], 0]);
    releaseCallbacks.resolve();
    await assert.rejects(async () => session.close({ reason: "idle" }), hasContractCode("invalid_session_interaction"));
    await session.close({ reason: "idle" });
    assert.deepEqual([host.releaseCount(), fixture.closes()], [1, 1]);
  });
});

test("a callback ignoring abort retains cleanup and host binding until its real completion", async (t) => {
  const releaseCallback = deferred<void>();
  const host = makeBinding();
  let callbackCompleted = false;
  let handle: AgentSessionInteraction | undefined;
  const fixture = await scenario({ cleanup: () => releaseCallback.resolve() });
  t.after(() => fixture.dispose());
  const session = await fixture.open("create", host.binding, { interactions: {
    limits: { cleanupTimeoutMs: 1_000 }, async onRequest(value) {
      handle = value;
      await releaseCallback.promise;
      callbackCompleted = true;
    },
  } });
  assert.ok(handle);
  let cleanup: AgentProviderSessionCleanupError | undefined;
  await assert.rejects(async () => session.close({ reason: "idle" }), (error: unknown) => {
    assert.ok(error instanceof AgentProviderSessionCleanupError);
    cleanup = error;
    return true;
  });
  assert.deepEqual(await handle.terminal, { kind: "session_closed" });
  assert.deepEqual([handle.signal.aborted, callbackCompleted, host.releaseCount(), fixture.closes()], [true, false, 0, 1]);
  const retry = cleanup!.retryCleanup();
  const concurrentClose = Promise.resolve(session.close({ reason: "idle" }));
  releaseCallback.resolve();
  await Promise.all([retry, concurrentClose]);
  assert.deepEqual([callbackCompleted, host.releaseCount(), fixture.closes(), fixture.offers[0]!.answers], [true, 1, 1, []]);
});

test("an asynchronous host failure after answering stays observable and retires the session once", async (t) => {
  const failCallback = deferred<void>();
  const accepted = deferred<void>();
  const failure = new Error("The host publication store rejected the answered interaction.");
  const host = makeBinding();
  let handle: AgentSessionInteraction | undefined;
  const fixture = await scenario({ cleanup: () => failCallback.resolve() });
  t.after(() => fixture.dispose());
  const session = await fixture.open("create", host.binding, { interactions: { async onRequest(value) {
    handle = value;
    assert.deepEqual(await value.respond({ choiceId: grant }), { status: "delivered" });
    accepted.resolve();
    await failCallback.promise;
  } } });
  await accepted.promise;
  assert.ok(handle);
  failCallback.reject(failure);
  await fixture.nativeCloseEntered;
  assert.deepEqual(await handle.terminal, { kind: "answered", choiceId: grant });
  assert.throws(() => session.startTurn(turnInput), (error: unknown) => includesCause(error, failure));
  await assert.rejects(async () => session.close({ reason: "idle" }), (error: unknown) => includesCause(error, failure));
  await session.close({ reason: "idle" });
  assert.deepEqual([host.releaseCount(), fixture.closes(), fixture.offers[0]!.answers], [1, 1, ["trust-workspace"]]);
});

test("a failed opening retains exact native cleanup and entered host work under the caller's input identity", async (t) => {
  const releaseNative = deferred<void>();
  const releaseCallback = deferred<void>();
  const retryEntered = deferred<void>();
  const nativeFailure = new Error("The partially opened producer is still live.");
  const events: string[] = [];
  const host = makeBinding({ events });
  let nativeRetries = 0;
  let callbackCompleted = false;
  let handle: AgentSessionInteraction | undefined;
  const fixture = await scenario({ cleanup() { releaseNative.resolve(); releaseCallback.resolve(); }, beforeOpen(context) {
    throw createAgentProviderSessionCleanupError({ providerKey: fixture.fake.definition.providerKey, openingInput: context,
      errors: [nativeFailure], async retryCleanup() {
        nativeRetries += 1;
        retryEntered.resolve();
        await releaseNative.promise;
        await Promise.all(fixture.offers.map((candidate) => candidate.stop()));
        events.push("native_closed");
      } });
  } });
  t.after(() => fixture.dispose());
  const input: AgentProviderCreateSessionInput = {
    sessionId: parseAgentSessionId("failed-decision-opening"), workingDirectory: "/host/workspace",
    configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("configuration:1"), catalogRevision: 1, selections: [] },
    onBindingCreated: () => undefined, hostBinding: host.binding,
    interactions: { limits: { cleanupTimeoutMs: 1_000 }, async onRequest(value) { handle = value; await releaseCallback.promise; callbackCompleted = true; } },
  };
  let cleanup: AgentProviderSessionCleanupError | undefined;
  await assert.rejects(async () => fixture.adapter.createSession(input), (error: unknown) => {
    assert.ok(isAgentProviderSessionCleanupErrorFor(error, input));
    assert.equal(isAgentProviderSessionCleanupErrorFor(error, { ...input }), false);
    assert.ok(includesCause(error, nativeFailure));
    cleanup = error;
    return true;
  });
  assert.ok(handle);
  assert.deepEqual([handle.signal.aborted, callbackCompleted, host.releaseCount(), fixture.candidates.length], [true, false, 0, 0]);
  const first = cleanup!.retryCleanup();
  const second = cleanup!.retryCleanup();
  await retryEntered.promise;
  assert.equal(nativeRetries, 1);
  releaseCallback.resolve();
  await fixture.offers[0]!.completion;
  assert.deepEqual([callbackCompleted, host.releaseCount()], [true, 0]);
  releaseNative.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["native_closed", "host_release"]);
  assert.deepEqual([nativeRetries, host.releaseCount(), fixture.contexts.length, fixture.offers[0]!.answers], [1, 1, 1, []]);
});

test("contradictory native terminal evidence cannot promote a response to accepted delivery", async (t) => {
  for (const conflict of ["different-choice", "rejected-delivery", "rejected-pending", "rejected-uncertainty"] as const) await t.test(conflict, async () => {
    const fixture = await scenario({ openingOffer: false });
    t.after(() => fixture.dispose());
    let handle: AgentSessionInteraction | undefined;
    const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
    const candidate = fixture.offer(fixture.contexts[0]!, { async respond() {
      candidate.settle(conflict === "different-choice" ? { kind: "answered", choiceId: decline } : { kind: "rejected", error: refusal });
      return conflict === "rejected-pending" ? { status: "rejected", requestState: "pending", error: refusal }
        : conflict === "rejected-uncertainty" ? { status: "delivery_uncertain", error: uncertainty } : { status: "delivered" };
    } });
    assert.ok(handle);
    const result = await handle.respond({ choiceId: grant });
    assert.equal(result.status, "delivery_uncertain");
    if (result.status !== "delivery_uncertain") throw new Error("Expected contradictory native evidence to remain uncertain.");
    assert.equal(result.error.code, "session_interaction_delivery_uncertain");
    assert.deepEqual(await handle.terminal, { kind: "delivery_uncertain", error: result.error });
    await assert.rejects(async () => session.close({ reason: "idle" }), hasContractCode("invalid_session_interaction"));
    await session.close({ reason: "idle" });
    assert.deepEqual([fixture.closes(), candidate.answers], [1, ["trust-workspace"]]);
  });
});

test("a late native acceptance after response timeout cannot restore reply or mutation authority", async (t) => {
  const acknowledgment = deferred<AgentRequestResolutionResult>();
  const fixture = await scenario({ openingOfferOptions: { respond: () => acknowledgment.promise }, cleanup: () => acknowledgment.resolve({ status: "delivered" }) });
  t.after(() => fixture.dispose());
  let handle: AgentSessionInteraction | undefined;
  const session = await fixture.open("create", undefined, { interactions: { limits: { responseTimeoutMs: 1_000 }, onRequest(value) { handle = value; } } });
  assert.ok(handle);
  const result = await handle.respond({ choiceId: grant });
  assert.equal(result.status, "delivery_uncertain");
  if (result.status !== "delivery_uncertain") throw new Error("Expected lost acceptance to remain uncertain.");
  assert.equal(result.error.code, "session_interaction_delivery_uncertain");
  const firstTerminal = await handle.terminal;
  assert.deepEqual(firstTerminal, { kind: "delivery_uncertain", error: result.error });
  acknowledgment.resolve({ status: "delivered" });
  assert.deepEqual(await fixture.offers[0]!.handle.terminal, { kind: "answered", choiceId: grant });
  await setImmediate();
  assert.deepEqual(await handle.terminal, firstTerminal);
  assert.throws(() => session.startTurn(turnInput), hasContractCode("session_unusable"));
  const late = await handle.respond({ choiceId: decline });
  assert.equal(late.status, "rejected");
  if (late.status !== "rejected") throw new Error("Expected uncertain reply authority to stay fenced.");
  assert.equal(late.requestState, "unavailable");
  assert.deepEqual([fixture.closes(), fixture.offers[0]!.answers], [0, ["trust-workspace"]]);
  await session.close({ reason: "idle" });
});

test("expiry retires the producer without inventing a decline or rewriting an entered answer", async (t) => {
  for (const entered of [false, true]) await t.test(entered ? "entered answer" : "unanswered", async () => {
    const acknowledgment = deferred<AgentRequestResolutionResult>();
    const fixture = await scenario({ openingOffer: false, cleanup: () => acknowledgment.resolve({ status: "delivered" }) });
    t.after(() => fixture.dispose());
    let handle: AgentSessionInteraction | undefined;
    const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
    const candidate = fixture.offer(fixture.contexts[0]!, { expiresAt: new Date(Date.now() + 100).toISOString(), respond: () => acknowledgment.promise });
    assert.ok(handle);
    const answer = entered ? handle.respond({ choiceId: grant }) : undefined;
    if (entered) await candidate.entered;
    await fixture.nativeCloseEntered;
    assert.equal(handle.signal.aborted, true);
    const late = await handle.respond({ choiceId: decline });
    assert.equal(late.status, "rejected");
    if (late.status !== "rejected") throw new Error("Expected expired response authority.");
    assert.equal(late.requestState, "unavailable");
    acknowledgment.resolve({ status: "delivered" });
    if (answer) assert.deepEqual(await answer, { status: "delivered" });
    assert.deepEqual(await handle.terminal, entered ? { kind: "answered", choiceId: grant } : { kind: "expired" });
    await assert.rejects(async () => session.close({ reason: "idle" }), hasContractCode("invalid_session_interaction"));
    await session.close({ reason: "idle" });
    assert.deepEqual([fixture.closes(), candidate.answers], [1, entered ? ["trust-workspace"] : []]);
  });
});

test("a late candidate after opening abort retains failed native cleanup and the entered callback", async (t) => {
  const publication = deferred<void>();
  const candidateCreated = deferred<void>();
  const releaseCallback = deferred<void>();
  const releaseNative = deferred<void>();
  const aborted = deferred<void>();
  const retryEntered = deferred<void>();
  const controller = new AbortController();
  const reason = new DOMException("Opening was canceled after decision publication.", "AbortError");
  const nativeFailure = new Error("Late candidate producer did not quiesce.");
  const events: string[] = [];
  const host = makeBinding({ events });
  let nativeCloses = 0;
  let callbackCompleted = false;
  const fixture = await scenario({ publication: publication.promise, cleanup() { publication.resolve(); releaseCallback.resolve(); releaseNative.resolve(); }, transformSession(session) {
    candidateCreated.resolve();
    return { ...session, async close(input) {
      nativeCloses += 1;
      if (nativeCloses === 1) throw nativeFailure;
      retryEntered.resolve();
      await releaseNative.promise;
      await session.close(input);
      events.push("native_closed");
    } };
  } });
  t.after(() => fixture.dispose());
  const input: AgentProviderCreateSessionInput = {
    sessionId: parseAgentSessionId("late-decision-opening"), workingDirectory: "/host/workspace", signal: controller.signal,
    configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("configuration:1"), catalogRevision: 1, selections: [] },
    onBindingCreated: () => undefined, hostBinding: host.binding,
    interactions: { limits: { cleanupTimeoutMs: 1_000 }, async onRequest(value) {
      value.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await releaseCallback.promise;
      callbackCompleted = true;
    } },
  };
  let cleanup: AgentProviderSessionCleanupError | undefined;
  const opening = Promise.resolve(fixture.adapter.createSession(input));
  const rejected = assert.rejects(opening, (error: unknown) => {
    assert.ok(isAgentProviderSessionCleanupErrorFor(error, input));
    assert.ok(includesCause(error, nativeFailure));
    assert.ok(includesCause(error, reason));
    cleanup = error;
    return true;
  });
  await candidateCreated.promise;
  controller.abort(reason);
  await aborted.promise;
  assert.deepEqual([fixture.offers[0]!.answers, host.releaseCount(), nativeCloses], [[], 0, 0]);
  publication.resolve();
  await rejected;
  assert.deepEqual([callbackCompleted, host.releaseCount(), nativeCloses], [false, 0, 1]);
  const first = cleanup!.retryCleanup();
  const second = cleanup!.retryCleanup();
  await retryEntered.promise;
  releaseCallback.resolve();
  await fixture.offers[0]!.completion;
  assert.deepEqual([callbackCompleted, host.releaseCount(), nativeCloses], [true, 0, 2]);
  releaseNative.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["native_closed", "host_release"]);
  assert.deepEqual([nativeCloses, host.releaseCount(), fixture.contexts.length, fixture.offers[0]!.answers], [2, 1, 1, []]);
});

test("invalid candidate admission and terminal evidence retire the owner while preserving entered work", async (t) => {
  for (const fault of ["wrong-session", "malformed-handle", "relative-target", "retained-id", "rejected-terminal", "malformed-terminal"] as const) {
    await t.test(fault, async () => {
      const releaseCallbacks = deferred<void>();
      const nativeTerminal = deferred<unknown>();
      const nativeFailure = new Error("Native interaction terminal failed.");
      const handles: AgentSessionInteraction[] = [];
      const host = makeBinding();
      const fixture = await scenario({ openingOffer: false, cleanup: () => releaseCallbacks.resolve() });
      t.after(() => fixture.dispose());
      const session = await fixture.open("create", host.binding, { interactions: { async onRequest(value) {
        handles.push(value);
        await releaseCallbacks.promise;
      } } });
      const context = fixture.contexts[0]!;
      const retained = fixture.offer(context, { id: "retained-candidate" });
      assert.deepEqual(await handles[0]!.respond({ choiceId: decline }), { status: "delivered" });
      assert.deepEqual(await handles[0]!.terminal, { kind: "answered", choiceId: decline });

      const candidate = nativeOffer(context, { id: fault === "retained-id" ? "retained-candidate" : "invalid-candidate" });
      fixture.offers.push(candidate);
      let supplied = candidate.handle;
      if (fault === "wrong-session") supplied = { ...supplied, request: parseAgentSessionDecisionRequest({
        ...supplied.request, sessionId: "a-different-session",
      }) };
      if (fault === "relative-target") supplied = { ...supplied, request: parseAgentSessionDecisionRequest({
        ...supplied.request, target: { kind: "workspace", path: "relative/workspace" },
      }) };
      // Deliberately invalid provider envelopes cross the public adapter boundary as unknown data.
      if (fault === "malformed-handle") supplied = { ...supplied, respond: undefined } as unknown as AgentSessionInteraction;
      const terminalFault = fault === "rejected-terminal" || fault === "malformed-terminal";
      if (terminalFault) supplied = { ...supplied, terminal: nativeTerminal.promise as Promise<AgentSessionInteractionTerminal> };
      assert.ok(context.interactions);
      const completion = Promise.resolve().then(() => context.interactions!.onRequest(supplied));
      void completion.catch(() => {});
      if (terminalFault) {
        await setImmediate();
        assert.equal(handles.length, 2);
        if (fault === "rejected-terminal") nativeTerminal.reject(nativeFailure);
        else nativeTerminal.resolve({ kind: "answered" });
      } else await assert.rejects(completion, hasContractCode("invalid_session_interaction"));

      await fixture.nativeCloseEntered;
      assert.deepEqual([handles.length, candidate.answers, retained.answers, host.releaseCount()],
        [terminalFault ? 2 : 1, [], ["leave-gated"], 0]);
      assert.deepEqual(await handles[0]!.terminal, { kind: "answered", choiceId: decline });
      if (terminalFault) {
        const terminal = await handles[1]!.terminal;
        assert.equal(terminal.kind, "failed");
        if (terminal.kind !== "failed") throw new Error("Expected invalid native terminal evidence to fail the host interaction.");
        assert.equal(terminal.error.code, "session_interaction_failed");
        const late = await handles[1]!.respond({ choiceId: grant });
        assert.equal(late.status, "rejected");
        if (late.status !== "rejected") throw new Error("Expected failed candidate reply authority to be unavailable.");
        assert.equal(late.requestState, "unavailable");
      }
      releaseCallbacks.resolve();
      await Promise.all([retained.completion, terminalFault ? completion : Promise.resolve()]);
      await assert.rejects(async () => session.close({ reason: "idle" }), (error: unknown) =>
        hasContractCode("invalid_session_interaction")(error) && (fault !== "rejected-terminal" || includesCause(error, nativeFailure)));
      await session.close({ reason: "idle" });
      assert.deepEqual([fixture.closes(), host.releaseCount(), candidate.answers], [1, 1, []]);
    });
  }
});

test("native uncertainty fences mutation when observed before or after a refusal receipt", async (t) => {
  for (const timing of ["early", "late"] as const) for (const requestState of ["pending", "unavailable"] as const) {
    await t.test(`${timing} terminal / ${requestState} receipt`, async () => {
      const nativeTerminal = deferred<AgentSessionInteractionTerminal>();
      const nativeReceipt = deferred<AgentRequestResolutionResult>();
      let starts = 0;
      const fixture = await scenario({ openingOffer: false, cleanup() {
        nativeTerminal.resolve({ kind: "delivery_uncertain", error: uncertainty });
        nativeReceipt.resolve({ status: "rejected", requestState, error: refusal });
      }, transformSession(session) {
        return { ...session, startTurn(input) {
          starts += 1;
          return session.startTurn(input);
        } };
      } });
      t.after(() => fixture.dispose());
      let handle: AgentSessionInteraction | undefined;
      const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
      const context = fixture.contexts[0]!;
      const candidate = nativeOffer(context, { respond: () => nativeReceipt.promise });
      fixture.offers.push(candidate);
      assert.ok(context.interactions);
      await context.interactions.onRequest({ ...candidate.handle, terminal: nativeTerminal.promise });
      assert.ok(handle);
      const response = handle.respond({ choiceId: grant });
      await candidate.entered;
      if (timing === "early") {
        nativeTerminal.resolve({ kind: "delivery_uncertain", error: uncertainty });
        await setImmediate();
      }
      nativeReceipt.resolve({ status: "rejected", requestState, error: refusal });
      const receipt = await response;
      if (timing === "late") {
        nativeTerminal.resolve({ kind: "delivery_uncertain", error: uncertainty });
        await setImmediate();
      }
      const terminal = await handle.terminal;
      assert.throws(() => session.startTurn(turnInput), hasContractCode("invalid_session_interaction"));
      assert.deepEqual([starts, candidate.answers], [0, ["trust-workspace"]]);
      if (timing === "early") {
        assert.equal(receipt.status, "delivery_uncertain");
        if (receipt.status !== "delivery_uncertain") throw new Error("Expected conflicting native evidence to remain uncertain.");
        assert.equal(receipt.error.code, "session_interaction_delivery_uncertain");
        assert.deepEqual(terminal, { kind: "delivery_uncertain", error: receipt.error });
      } else {
        assert.deepEqual(receipt, { status: "rejected", requestState, error: refusal });
        assert.deepEqual(terminal, requestState === "pending" ? { kind: "delivery_uncertain", error: uncertainty } : { kind: "rejected", error: refusal });
      }
      await assert.rejects(async () => session.close({ reason: "idle" }), hasContractCode("invalid_session_interaction"));
      await session.close({ reason: "idle" });
      assert.equal(fixture.closes(), 1);
    });
  }
});

test("elapsed request expiry refuses native entry before a delayed timer can run", async (t) => {
  const fixture = await scenario({ openingOffer: false });
  t.after(() => fixture.dispose());
  let handle: AgentSessionInteraction | undefined;
  const session = await fixture.open("create", undefined, { interactions: { onRequest(value) { handle = value; } } });
  const candidate = fixture.offer(fixture.contexts[0]!, { expiresAt: new Date(Date.now() + 50).toISOString() });
  assert.ok(handle);
  const abort = new AbortController();
  const reason = new DOMException("The response was already canceled.", "AbortError");
  abort.abort(reason);
  const untilExpired = Math.max(0, Date.parse(handle.request.expiresAt) - Date.now()) + 20;
  assert.ok(untilExpired <= 100);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, untilExpired);
  await assert.rejects(handle.respond({ choiceId: parseAgentSessionDecisionChoiceId("unoffered") }), (error: unknown) => error instanceof AgentProtocolValidationError);
  await assert.rejects(handle.respond({ choiceId: grant, signal: abort.signal }), (error: unknown) => error === reason);
  const receipt = await handle.respond({ choiceId: grant });
  assert.deepEqual(candidate.answers, [], "Elapsed authority cannot enter native response while its timer is delayed.");
  assert.equal(receipt.status, "rejected");
  if (receipt.status !== "rejected") throw new Error("Expected an expired request to refuse delivery.");
  assert.deepEqual([receipt.requestState, receipt.error.code], ["unavailable", "session_interaction_unavailable"]);
  assert.deepEqual(await handle.terminal, { kind: "expired" });
  await fixture.nativeCloseEntered;
  await assert.rejects(async () => session.close({ reason: "idle" }), hasContractCode("invalid_session_interaction"));
  await session.close({ reason: "idle" });
  assert.deepEqual([fixture.closes(), candidate.answers], [1, []]);
});
