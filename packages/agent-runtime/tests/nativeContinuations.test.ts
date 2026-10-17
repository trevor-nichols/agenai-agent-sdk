// ------------------------------------------------------------------------------------------------
//                nativeContinuations.test.ts - Public staged response, output and cleanup authority
// ------------------------------------------------------------------------------------------------
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseAgentTurnId, parseAgentSessionPlanReviewRequest } from "@agen-ai/agent-protocol";
import {
  AgentProviderContractError, AgentProviderSessionCleanupError, validateAgentProviderAdapter,
  type AgentNativeContinuation, type AgentProviderCreateSessionInput, type AgentSessionInteractionTerminal, type AgentProviderOutput, type AgentRequestResolutionResult, type AgentSessionInteraction,
} from "../src/index.js";
import { createFakeAgentProvider } from "../src/testing/index.js";
import { approve, continuationFixture } from "./fixtures/nativeContinuations.js";
import { deferred, hasContractCode } from "./fixtures/hostBindings/harness.js";

const turn = { turnId: parseAgentTurnId("caller-turn"), interactionMode: "default" as const, parts: [{ type: "text" as const, text: "A real caller turn." }] };
async function flush() { await setImmediate(); }

test("native continuation parks its ordinary reader before dispatch, preserves early output and never calls caller startTurn", async () => {
  const fixture = await continuationFixture();
  let interaction!: AgentSessionInteraction;
  let continuation!: AgentNativeContinuation;
  const outputs: AgentProviderOutput[] = [];
  const consumed = deferred<void>();
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { onRequest(value) { interaction = value; } },
    nativeContinuations: { async onExecution(value) {
      continuation = value; fixture.events.push("host_reader");
      for await (const output of value.execution.outputs) outputs.push(output);
      consumed.resolve();
    } },
  });
  fixture.events.push("public_return");
  await flush();
  assert.ok(interaction);
  assert.deepEqual(await interaction.respond(approve(interaction.request)), { status: "delivered" });
  await consumed.promise;
  assert.deepEqual(outputs.map((output) => output.kind === "event" ? output.event.type : output.kind), ["turn.started", "turn.completed"]);
  assert.deepEqual(await continuation.outcome, { kind: "started" });
  assert.equal(fixture.events.indexOf("candidate_iterator") > fixture.events.indexOf("dispatch"), true);
  assert.equal(fixture.events.indexOf("candidate_pull") > fixture.events.indexOf("dispatch"), true);
  assert.equal(fixture.events.indexOf("host_reader") < fixture.events.indexOf("dispatch"), true);
  assert.deepEqual(fixture.counts(), { dispatches: 1, cancels: 0, callerTurns: 0, nativeCloses: 0 });
  await flush();
  const caller = session.startTurn(turn);
  await caller.outputs[Symbol.asyncIterator]().return?.();
  await session.close({ reason: "idle" }); await fixture.dispose();
});

test("opening timing keeps after_open_return requests private and admits the exact earlier bound openings", async (t) => {
  for (const timing of ["after_open_return", "before_open_return", "before_binding"] as const) await t.test(timing, async () => {
    const releaseOpen = deferred<void>();
    const fixture = await continuationFixture({ timing, beforeBinding: timing === "before_binding", delayOpening: releaseOpen.promise });
    let presented = false;
    let receipt: Promise<AgentRequestResolutionResult> | undefined;
    const done = deferred<void>();
    const opening = fixture.adapter.createSession({ ...fixture.input,
      interactions: { onRequest(value) { presented = true; fixture.events.push("present"); receipt = value.respond(approve(fixture.request())); } },
      nativeContinuations: { async onExecution(value) { for await (const _entry of value.execution.outputs) {} done.resolve(); } },
    });
    await fixture.opened; await flush();
    if (timing === "after_open_return") { assert.equal(presented, false); assert.equal(fixture.counts().dispatches, 0); }
    else { assert.equal(presented, true); await done.promise; assert.equal(fixture.counts().dispatches, 1); }
    releaseOpen.resolve();
    const session = await opening;
    fixture.events.push("public_return");
    await flush(); await receipt; await done.promise;
    if (timing === "after_open_return") assert.equal(fixture.events.indexOf("public_return") < fixture.events.indexOf("present"), true);
    else assert.equal(fixture.events.indexOf("provider_binding") < fixture.events.indexOf("present"), true);
    await session.close({ reason: "idle" }); await fixture.dispose();
  });
});

test("effect-free preparation loses to a caller reservation without dispatching an answer and can retry after cancellation", async () => {
  const preparation = deferred<void>();
  const fixture = await continuationFixture({ preparation: preparation.promise });
  let interaction!: AgentSessionInteraction;
  let reads = 0;
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { onRequest(value) { interaction = value; } },
    nativeContinuations: { async onExecution(value) { reads += 1; for await (const _entry of value.execution.outputs) {} } },
  });
  await flush();
  const response = interaction.respond(approve(fixture.request()));
  const refused = assert.rejects(response, hasContractCode("concurrent_turn"));
  await fixture.preparationEntered;
  const caller = session.startTurn(turn);
  preparation.resolve(); await refused;
  assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 1, callerTurns: 0, nativeCloses: 0 });
  assert.equal(reads, 0);
  await caller.outputs[Symbol.asyncIterator]().return?.();
  await session.close({ reason: "idle" }); await fixture.dispose();
});

test("no-continuation abandonment and authoritative native no-work release only their exact ownership", async (t) => {
  for (const noContinuation of [true, false]) await t.test(String(noContinuation), async () => {
    const fixture = await continuationFixture({ noContinuation, outcome: "not_started" });
    let interaction!: AgentSessionInteraction;
    let executions = 0;
    let nativeTurn: ReturnType<typeof parseAgentTurnId> | undefined;
    const hostJoined = deferred<void>();
    const drained = deferred<void>();
    const outputs: AgentProviderOutput[] = [];
    const session = await fixture.adapter.createSession({ ...fixture.input,
      interactions: { onRequest(value) { interaction = value; } },
      nativeContinuations: { async onExecution(value) { executions += 1; nativeTurn = value.execution.turnId; for await (const output of value.execution.outputs) outputs.push(output); drained.resolve(); await hostJoined.promise; } },
    });
    await flush();
    const request = fixture.request(); assert.equal(request.kind, "plan_review");
    if (request.kind !== "plan_review") throw new Error();
    await interaction.respond({ kind: "plan_review", action: "abandon", choiceId: request.choices[2]!.choiceId, planId: request.plan.planId, revision: request.plan.revision });
    await flush();
    assert.equal(executions, noContinuation ? 0 : 1); assert.deepEqual(outputs, []);
    if (!noContinuation) {
      await drained.promise;
      assert.throws(() => session.startTurn(turn), hasContractCode("concurrent_turn"));
      assert.equal(session.interruption.kind, "supported");
      if (session.interruption.kind !== "supported" || !nativeTurn) throw new Error("Expected interruption fixture.");
      await assert.rejects(Promise.resolve(session.interruption.interruptTurn({ turnId: nativeTurn, reason: "user_requested" })), hasContractCode("active_turn_mismatch"));
      assert.deepEqual(fixture.fake.snapshot().interruptedTurnIds, []);
    }
    hostJoined.resolve(); await flush();
    const caller = session.startTurn(turn); await caller.outputs[Symbol.asyncIterator]().return?.();
    await session.close({ reason: "idle" }); await fixture.dispose();
  });
});

test("retaining a continuation handle or only acquiring its iterator times out before any native entry", async (t) => {
  for (const acquire of ["none", "iterator", "outcome"] as const) await t.test(acquire, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const fixture = await continuationFixture();
    let interaction!: AgentSessionInteraction;
    let continuation!: AgentNativeContinuation;
    const session = await fixture.adapter.createSession({ ...fixture.input,
      interactions: { humanWait: { kind: "until_withdrawn_or_closed" }, onRequest(value) { interaction = value; } },
      nativeContinuations: { async onExecution(value) { continuation = value; if (acquire === "iterator") value.execution.outputs[Symbol.asyncIterator](); if (acquire === "outcome") await value.outcome; } },
    });
    await flush();
    const response = interaction.respond(approve(fixture.request()));
    const rejected = assert.rejects(response, hasContractCode("native_continuation_reader_not_ready"));
    await flush(); assert.ok(continuation);
    t.mock.timers.tick(30_000); await rejected;
    assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 1, callerTurns: 0, nativeCloses: 0 });
    assert.deepEqual(await continuation.outcome, { kind: "not_started" });
    const caller = session.startTurn(turn); await caller.outputs[Symbol.asyncIterator]().return?.();
    await session.close({ reason: "idle" }); await fixture.dispose();
  });
});

test("returning a parked native reader cancels preparation before the actual dispatch boundary", { timeout: 5_000 }, async (t) => {
  for (const awaitReturn of [true, false]) await t.test(awaitReturn ? "awaited return" : "unawaited return", async (t) => {
    const fixture = await continuationFixture();
    const parkedPull = deferred<unknown>();
    let interaction!: AgentSessionInteraction;
    let continuation!: AgentNativeContinuation;
    const session = await fixture.adapter.createSession({ ...fixture.input,
      interactions: { humanWait: { kind: "until_withdrawn_or_closed" }, limits: { cleanupTimeoutMs: 1_000 }, onRequest(value) { interaction = value; } },
      nativeContinuations: { async onExecution(value) {
        continuation = value;
        const iterator = value.execution.outputs[Symbol.asyncIterator]();
        void iterator.next().catch((cause: unknown) => { parkedPull.resolve(cause); });
        const returned = iterator.return?.();
        if (awaitReturn) await returned;
        else void returned;
        await value.outcome;
      } },
    });
    t.after(async () => {
      fixture.outcome.resolve({ kind: "not_started" });
      await Promise.resolve(session.close({ reason: "shutdown" })).catch(() => {});
      await fixture.dispose();
    });
    await flush();
    await assert.rejects(interaction.respond(approve(fixture.request())), hasContractCode("native_continuation_reader_not_ready"));
    assert.deepEqual(await continuation.outcome, { kind: "not_started" });
    const stoppedPull = await parkedPull.promise;
    assert.ok(stoppedPull instanceof DOMException && stoppedPull.name === "AbortError");
    assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 1, callerTurns: 0, nativeCloses: 0 });
    assert.equal(fixture.events.includes("candidate_iterator"), false);
    const caller = session.startTurn(turn);
    await caller.outputs[Symbol.asyncIterator]().return?.();
    await session.close({ reason: "idle" });
    assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 1, callerTurns: 0, nativeCloses: 1 });
    assert.equal(fixture.events.includes("native_closed"), true);
  });
});

test("delivered receipt survives an outcome-only timeout while host outcome rejects and session cleanup quiesces", { timeout: 2_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const fixture = await continuationFixture({ outcome: "missing" });
  let interaction!: AgentSessionInteraction;
  let continuation!: AgentNativeContinuation;
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { limits: { responseTimeoutMs: 1_000 }, onRequest(value) { interaction = value; } },
    nativeContinuations: { async onExecution(value) { continuation = value; for await (const _entry of value.execution.outputs) {} } },
  });
  await flush();
  assert.deepEqual(await interaction.respond(approve(fixture.request())), { status: "delivered" });
  await flush();
  assert.ok(fixture.events.includes("source_complete"), "The ordinary source ended while start/no-work outcome remains pending.");
  const outcome = assert.rejects(continuation.outcome, hasContractCode("invalid_native_continuation"));
  t.mock.timers.tick(1_000); await outcome; await flush();
  assert.equal(fixture.counts().nativeCloses, 1);
  assert.throws(() => session.startTurn(turn), (cause: unknown) => cause instanceof AgentProviderContractError);
  fixture.outcome.resolve({ kind: "started" });
  await flush();
  await Promise.resolve(session.close({ reason: "idle" })).catch((cause: unknown) => { assert.ok(cause instanceof AgentProviderContractError); });
  await fixture.dispose();
});

test("close starts native quiescence before joining an unfinished preparation and never dispatches it", async () => {
  const preparation = deferred<void>();
  const fixture = await continuationFixture({ preparation: preparation.promise, close: async () => { preparation.resolve(); } });
  let interaction!: AgentSessionInteraction;
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { onRequest(value) { interaction = value; } },
    nativeContinuations: { async onExecution(value) { for await (const _entry of value.execution.outputs) {} } },
  });
  await flush();
  const response = interaction.respond(approve(fixture.request()));
  const rejected = assert.rejects(response, (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError");
  await fixture.preparationEntered;
  await session.close({ reason: "shutdown" }); await rejected;
  assert.equal(fixture.events.indexOf("native_close") < fixture.events.indexOf("cancel"), true);
  assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 1, callerTurns: 0, nativeCloses: 1 });
  await fixture.dispose();
});

test("native terminal output keeps the shared slot until its actual host callback joins", async () => {
  const hostJoined = deferred<void>();
  const drained = deferred<void>();
  const fixture = await continuationFixture();
  let interaction!: AgentSessionInteraction;
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { onRequest(value) { interaction = value; } },
    nativeContinuations: { async onExecution(value) {
      for await (const _entry of value.execution.outputs) {}
      drained.resolve(); await hostJoined.promise;
    } },
  });
  await flush();
  assert.deepEqual(await interaction.respond(approve(fixture.request())), { status: "delivered" });
  await drained.promise;
  assert.throws(() => session.startTurn(turn), hasContractCode("concurrent_turn"));
  hostJoined.resolve(); await flush();
  const caller = session.startTurn(turn); await caller.outputs[Symbol.asyncIterator]().return?.();
  await session.close({ reason: "idle" }); await fixture.dispose();
});

test("a host callback rejection and wrong prepared execution identity cannot dispatch an answer", async (t) => {
  for (const wrongIdentity of [false, true]) await t.test(String(wrongIdentity), async () => {
    const fixture = await continuationFixture({ ...(wrongIdentity ? { createExecution: () => parseAgentTurnId("wrong-turn") } : {}) });
    let interaction!: AgentSessionInteraction;
    const failure = new Error("Host cannot own this reader.");
    const session = await fixture.adapter.createSession({ ...fixture.input,
      interactions: { onRequest(value) { interaction = value; } },
      nativeContinuations: { onExecution() { throw failure; } },
    });
    await flush();
    await assert.rejects(interaction.respond(approve(fixture.request())), hasContractCode(wrongIdentity ? "invalid_native_continuation" : "native_continuation_reader_not_ready"));
    assert.equal(fixture.counts().dispatches, 0); assert.equal(fixture.counts().cancels, 1);
    await Promise.resolve(session.close({ reason: "idle" })).catch((cause: unknown) => { assert.ok(wrongIdentity && cause instanceof AgentProviderContractError); }); await fixture.dispose();
  });
});

test("failed prepared cancellation retains an exact cleanup retry without replaying dispatch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let cancellationFails = true;
  const fixture = await continuationFixture({ cancel: async () => { if (cancellationFails) throw new Error("Prepared drain is still owned."); } });
  let interaction!: AgentSessionInteraction;
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { humanWait: { kind: "until_withdrawn_or_closed" }, onRequest(value) { interaction = value; } },
    nativeContinuations: { onExecution() {} },
  });
  await flush();
  const response = interaction.respond(approve(fixture.request()));
  let retained!: AgentProviderSessionCleanupError;
  const rejected = assert.rejects(response, (cause: unknown) => {
    assert.ok(cause instanceof AgentProviderSessionCleanupError); retained = cause; return true;
  });
  await flush(); t.mock.timers.tick(30_000); await rejected; await flush();
  assert.equal(fixture.counts().dispatches, 0);
  assert.throws(() => session.startTurn(turn), (cause: unknown) => cause instanceof AgentProviderContractError);
  cancellationFails = false;
  await retained.retryCleanup();
  await Promise.resolve(session.close({ reason: "idle" })).catch((cause: unknown) => { assert.ok(cause instanceof Error); });
  assert.equal(fixture.counts().dispatches, 0);
  await fixture.dispose();
});

test("malformed and rejected postdispatch outcomes preserve the delivered receipt and fail the host outcome", async (t) => {
  for (const invalid of ["malformed", "reject"] as const) await t.test(invalid, async () => {
    const fixture = await continuationFixture({ outcome: invalid });
    let interaction!: AgentSessionInteraction;
    let continuation!: AgentNativeContinuation;
    const session = await fixture.adapter.createSession({ ...fixture.input,
      interactions: { onRequest(value) { interaction = value; } },
      nativeContinuations: { async onExecution(value) { continuation = value; for await (const _entry of value.execution.outputs) {} } },
    });
    await flush();
    const receipt = await interaction.respond(approve(fixture.request()));
    assert.deepEqual(receipt, { status: "delivered" });
    await assert.rejects(continuation.outcome);
    await flush(); assert.equal(fixture.counts().nativeCloses, 1);
    await Promise.resolve(session.close({ reason: "idle" })).catch((cause: unknown) => { assert.ok(cause instanceof Error); });
    await fixture.dispose();
  });
});

test("concurrent openings reusing the same caller input return only their own session request generation", async () => {
  const fake = createFakeAgentProvider();
  const instance = await fake.driver.materialize(fake.definition);
  const fixture = await continuationFixture();
  const gates = [deferred<void>(), deferred<void>()];
  const offered = [deferred<void>(), deferred<void>()];
  const terminals = [deferred<AgentSessionInteractionTerminal>(), deferred<AgentSessionInteractionTerminal>()];
  const requests: AgentSessionInteraction[] = [];
  let entries = 0;
  let dispatched = 0;
  const adapter = validateAgentProviderAdapter(instance.capabilities, {
    ...instance.adapter,
    sessionInteractions: { kind: "supported", mappings: [{ openingOperation: "create", requestKind: "plan_review" }], humanWait: ["bounded"], producerOwnership: "exclusive" },
    nativeContinuations: { kind: "supported", mappings: [{ openingOperation: "create", requestKind: "plan_review", timing: "after_open_return" }], producerOwnership: "exclusive" },
    async createSession(input: AgentProviderCreateSessionInput) {
      const index = entries++;
      const native = await instance.adapter.createSession(input);
      const request = parseAgentSessionPlanReviewRequest({ kind: "plan_review", requestId: `opening-${index}`, sessionId: input.sessionId,
        title: `Opening ${index}`, plan: { planId: "plan", revision: `revision-${index}`, title: "Exact original plan", content: { kind: "text", format: "plain_text", text: "Review the exact opening." } },
        choices: [{ choiceId: "abandon", action: "abandon", label: "Abandon" }] });
      const terminal = terminals[index]!;
      const publication = input.interactions!.onRequest({ kind: "prepared", request, signal: new AbortController().signal, terminal: terminal.promise,
        prepareResponse() { return { kind: "no_continuation", async dispatch() { dispatched += 1; return { status: "delivered" }; }, async cancel() {} }; } });
      void Promise.resolve(publication).catch(() => {});
      offered[index]!.resolve();
      await gates[index]!.promise;
      return { ...native, async close(close: Parameters<typeof native.close>[0]) { terminal.resolve({ kind: "session_closed" }); await native.close(close); } };
    },
  });
  const input = { ...fixture.input, interactions: { onRequest(value: AgentSessionInteraction) { requests.push(value); } }, nativeContinuations: { onExecution() {} } };
  const first = adapter.createSession(input);
  const second = adapter.createSession(input);
  await Promise.all(offered.map((offer) => offer.promise));
  gates[0]!.resolve(); const firstSession = await first; await flush();
  assert.deepEqual(requests.map((value) => value.request.requestId), ["opening-0"]);
  assert.equal(dispatched, 0);
  gates[1]!.resolve(); const secondSession = await second; await flush();
  assert.deepEqual(requests.map((value) => value.request.requestId), ["opening-0", "opening-1"]);
  await firstSession.close({ reason: "idle" }); await secondSession.close({ reason: "idle" });
  await instance.dispose(); await fixture.dispose();
});


test("an entered native reader can await return while session close joins that same host callback", async () => {
  const fixture = await continuationFixture();
  let interaction!: AgentSessionInteraction;
  const returned = deferred<void>();
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { onRequest(value) { interaction = value; } },
    nativeContinuations: { async onExecution(value) {
      const iterator = value.execution.outputs[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(first.done, false);
      assert.equal(first.value?.kind === "event" ? first.value.event.type : undefined, "turn.started");
      await iterator.return?.();
      returned.resolve();
    } },
  });
  await flush();
  assert.deepEqual(await interaction.respond(approve(fixture.request())), { status: "delivered" });
  await returned.promise;
  await session.close({ reason: "idle" });
  assert.equal(fixture.counts().nativeCloses, 1);
  assert.equal(fixture.events.includes("native_closed"), true);
  assert.equal(fixture.counts().dispatches, 1);
  await fixture.dispose();
});


test("delivered session answers leave their native execution alive until real completion or session close", { timeout: 5_000 }, async (t) => {
  for (const closeEarly of [false, true]) await t.test(closeEarly ? "close" : "complete", async (t) => {
    const laterOutput = deferred<void>();
    const fixture = await continuationFixture({ afterStarted: laterOutput.promise, close: async () => { laterOutput.resolve(); } });
    const started = deferred<void>();
    const consumed = deferred<void>();
    const outputs: AgentProviderOutput[] = [];
    let interaction!: AgentSessionInteraction;
    const session = await fixture.adapter.createSession({ ...fixture.input,
      interactions: { onRequest(value) { interaction = value; } },
      nativeContinuations: { async onExecution(value) {
        try {
          for await (const output of value.execution.outputs) { outputs.push(output); if (outputs.length === 1) started.resolve(); }
        } catch (cause) {
          if (!(cause instanceof DOMException && cause.name === "AbortError" && fixture.executionSignal().aborted)) throw cause;
        }
        consumed.resolve();
      } },
    });
    t.after(async () => { laterOutput.resolve(); await Promise.resolve(session.close({ reason: "shutdown" })).catch(() => {}); await fixture.dispose(); });
    await flush();
    const receipt = await interaction.respond(approve(fixture.request()));
    assert.deepEqual(receipt, { status: "delivered" });
    assert.equal((await interaction.terminal).kind, "answered");
    await started.promise;
    assert.equal(fixture.executionSignal().aborted, false, "Answer presentation retirement must not cancel the owned native execution.");
    if (closeEarly) {
      await session.close({ reason: "shutdown" });
      assert.equal(fixture.executionSignal().aborted, true);
    } else laterOutput.resolve();
    await consumed.promise;
    assert.deepEqual(outputs.map((output) => output.kind === "event" ? output.event.type : output.kind), closeEarly ? ["turn.started"] : ["turn.started", "turn.completed"]);
    assert.equal(fixture.counts().dispatches, 1);
    assert.equal(fixture.counts().callerTurns, 0);
  });
});
