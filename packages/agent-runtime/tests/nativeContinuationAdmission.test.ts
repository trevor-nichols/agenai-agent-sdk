// ------------------------------------------------------------------------------------------------
//                nativeContinuationAdmission.test.ts - Opening and preparation refusal boundaries
// ------------------------------------------------------------------------------------------------
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseAgentConfigurationRevisionId, parseAgentSessionId, parseAgentTurnId } from "@agen-ai/agent-protocol";
import {
  AgentProviderSessionCleanupError, isAgentProviderSessionCleanupErrorFor, validateAgentProviderAdapter,
  type AgentCreateSessionInput, type AgentProviderAdapter, type AgentProviderSession, type AgentRequestResolutionResult, type AgentSessionInteraction,
} from "../src/index.js";
import { createFakeAgentProvider } from "../src/testing/index.js";
import { deferred, hasContractCode, makeBinding, supportedBinding } from "./fixtures/hostBindings/harness.js";
import { approve, continuationFixture } from "./fixtures/nativeContinuations.js";
import { includesCause, refusal } from "./fixtures/sessionInteractions.js";

const now = Date.parse("2026-10-16T12:00:00.000Z");
const turn = { turnId: parseAgentTurnId("after-refused-continuation"), interactionMode: "default" as const,
  parts: [{ type: "text" as const, text: "Start a real caller turn." }] };

test("missing interaction ownership and unsupported continuations refuse before candidate opening", { timeout: 5_000 }, async (t) => {
  for (const missing of ["interactions", "support"] as const) await t.test(missing, async () => {
    const fake = createFakeAgentProvider();
    const instance = await fake.driver.materialize(fake.definition);
    t.after(() => instance.dispose());
    let entries = 0;
    let executions = 0;
    const candidate: AgentProviderAdapter = { ...instance.adapter,
      sessionInteractions: { kind: "supported", mappings: [{ openingOperation: "create", requestKind: "plan_review" }],
        producerOwnership: "exclusive", humanWait: ["bounded"] },
      ...(missing === "interactions" ? { nativeContinuations: { kind: "supported" as const,
        mappings: [{ openingOperation: "create" as const, requestKind: "plan_review" as const, timing: "after_open_return" as const }] as const,
        producerOwnership: "exclusive" as const } } : {}),
      createSession(input) { entries += 1; return instance.adapter.createSession(input); },
    };
    const adapter = validateAgentProviderAdapter(instance.capabilities, candidate);
    const input: AgentCreateSessionInput = {
      sessionId: parseAgentSessionId(`missing-${missing}`), workingDirectory: "/fixture/workspace",
      configuration: { kind: "selected", revision: parseAgentConfigurationRevisionId("fixture-config"), catalogRevision: 1, selections: [] },
      onBindingCreated() {},
      ...(missing === "support" ? { interactions: { onRequest() { throw new Error("No candidate may publish a request."); } } } : {}),
      nativeContinuations: { onExecution() { executions += 1; } },
    };
    await assert.rejects(async () => adapter.createSession(input), hasContractCode("native_continuations_unsupported"));
    assert.deepEqual([entries, executions], [0, 0]);
  });
});

test("a prepared offer without a continuation handler is rejected before presentation or answer dispatch", { timeout: 5_000 }, async (t) => {
  const fixture = await continuationFixture();
  t.after(() => fixture.dispose());
  let presentations = 0;
  await assert.rejects(async () => fixture.adapter.createSession({ ...fixture.input,
    interactions: { onRequest() { presentations += 1; } },
  }), hasContractCode("native_continuations_unsupported"));
  assert.deepEqual([presentations, fixture.events.filter((event) => event === "candidate_open").length], [0, 1]);
  assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 0, callerTurns: 0, nativeCloses: 1 });
  assert.ok(fixture.events.includes("native_closed"));
});

test("sixteen prebinding offers bind to their exact opening while the seventeenth retains failed-opening cleanup", { timeout: 5_000 }, async (t) => {
  for (const offerCount of [16, 17]) await t.test(String(offerCount), async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
    const binding = deferred<void>();
    const fixture = await continuationFixture({ timing: "before_binding", beforeBinding: true, delayBinding: binding.promise, offerCount });
    t.after(() => { binding.resolve(); fixture.controller.abort(); fixture.terminal.resolve({ kind: "session_closed" }); return fixture.dispose(); });
    const presented: AgentSessionInteraction[] = [];
    const input: AgentCreateSessionInput = { ...fixture.input,
      interactions: { humanWait: { kind: "until_withdrawn_or_closed" }, limits: { maxRetainedRequests: 32, cleanupTimeoutMs: 1_000 },
        onRequest(value) { presented.push(value); } },
      nativeContinuations: { onExecution() { throw new Error("An unanswered review cannot create an execution."); } },
    };
    const opening = Promise.resolve(fixture.adapter.createSession(input));
    let retained: AgentProviderSessionCleanupError | undefined;
    const refused = offerCount === 17 ? assert.rejects(opening, (cause: unknown) => {
      assert.ok(isAgentProviderSessionCleanupErrorFor(cause, input));
      assert.ok(cause.errors.some(hasContractCode("native_continuation_limit_exceeded")));
      retained = cause;
      return true;
    }) : undefined;
    await fixture.opened;
    await setImmediate();
    assert.deepEqual([presented.length, fixture.counts().dispatches, fixture.events.includes("provider_binding")], [0, 0, false]);
    if (offerCount === 16) {
      binding.resolve();
      const session = await opening;
      await setImmediate();
      assert.equal(fixture.events.includes("provider_binding"), true);
      assert.equal(presented.length, 16);
      assert.equal(new Set(presented.map((handle) => handle.request.requestId)).size, 16);
      assert.deepEqual([presented[0]!.request.requestId, presented[15]!.request.requestId], ["native-plan-review:0", "native-plan-review:15"]);
      await session.close({ reason: "idle" });
      assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 0, callerTurns: 0, nativeCloses: 1 });
    } else {
      t.mock.timers.tick(1_000);
      await refused;
      assert.ok(retained);
      assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 0, callerTurns: 0, nativeCloses: 0 });
      let joined = false;
      const retry = retained.retryCleanup().then(() => { joined = true; });
      await setImmediate();
      assert.equal(joined, false);
      binding.resolve();
      fixture.controller.abort();
      fixture.terminal.resolve({ kind: "session_closed" });
      await retry;
      assert.deepEqual([joined, presented.length, fixture.events.filter((event) => event === "candidate_open").length], [true, 0, 1]);
      assert.equal(fixture.counts().dispatches, 0);
    }
  });
});

test("prebinding association timeout retains the exact blocked opening until its producer really settles", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const binding = deferred<void>();
  const fixture = await continuationFixture({ timing: "before_binding", beforeBinding: true, delayBinding: binding.promise });
  t.after(() => { binding.resolve(); fixture.controller.abort(); fixture.terminal.resolve({ kind: "session_closed" }); return fixture.dispose(); });
  let presentations = 0;
  const input: AgentCreateSessionInput = { ...fixture.input,
    interactions: { humanWait: { kind: "until_withdrawn_or_closed" }, limits: { cleanupTimeoutMs: 1_000 }, onRequest() { presentations += 1; } },
    nativeContinuations: { onExecution() { throw new Error("Unbound work cannot acquire output ownership."); } },
  };
  let retained: AgentProviderSessionCleanupError | undefined;
  const refused = assert.rejects(Promise.resolve(fixture.adapter.createSession(input)), (cause: unknown) => {
    assert.ok(isAgentProviderSessionCleanupErrorFor(cause, input));
    assert.ok(cause.errors.some(hasContractCode("invalid_native_continuation")));
    retained = cause;
    return true;
  });
  await fixture.opened;
  t.mock.timers.tick(29_999);
  await setImmediate();
  assert.deepEqual([presentations, fixture.producer().signal?.aborted, fixture.counts().dispatches], [0, false, 0]);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(fixture.producer().signal?.aborted, true);
  t.mock.timers.tick(1_000);
  await refused;
  assert.ok(retained);
  let joined = false;
  const retry = retained.retryCleanup().then(() => { joined = true; });
  await setImmediate();
  assert.deepEqual([joined, presentations, fixture.events.includes("provider_binding")], [false, 0, false]);
  binding.resolve();
  fixture.controller.abort();
  fixture.terminal.resolve({ kind: "session_closed" });
  await retry;
  assert.deepEqual([joined, presentations, fixture.events.filter((event) => event === "candidate_open").length], [true, 0, 1]);
  assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 0, callerTurns: 0, nativeCloses: 0 });
});

test("a started outcome before dispatch fences the owner and cannot enter a native answer", { timeout: 5_000 }, async (t) => {
  const fixture = await continuationFixture();
  t.after(() => fixture.dispose());
  let interaction!: AgentSessionInteraction;
  let executions = 0;
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { onRequest(value) { interaction = value; } },
    nativeContinuations: { onExecution() { executions += 1; } },
  });
  await setImmediate();
  fixture.outcome.resolve({ kind: "started" });
  await assert.rejects(interaction.respond(approve(fixture.request())), (cause: unknown) => {
    assert.ok(cause instanceof AgentProviderSessionCleanupError);
    assert.ok(cause.errors.some(hasContractCode("invalid_native_continuation")));
    return true;
  });
  await setImmediate();
  assert.deepEqual([executions, fixture.counts().dispatches, fixture.counts().callerTurns], [0, 0, 0]);
  assert.throws(() => session.startTurn(turn), hasContractCode("invalid_native_continuation"));
  await assert.rejects(async () => session.close({ reason: "idle" }), (cause: unknown) => cause instanceof AgentProviderSessionCleanupError);
  assert.equal(fixture.counts().nativeCloses, 1);
});

test("preparation rejection retains the actual native close owner without replaying a response", { timeout: 5_000 }, async (t) => {
  for (const timing of ["after_open_return", "before_open_return"] as const) await t.test(timing, async (t) => {
    const preparation = deferred<void>();
    const openingGate = deferred<void>();
    const nativeClosed = deferred<void>();
    const callbackGate = deferred<void>();
    const failure = new Error("Native preparation failed after allocation.");
    const fixture = await continuationFixture({ timing, preparation: preparation.promise, close: () => nativeClosed.promise,
      ...(timing === "before_open_return" ? { delayOpening: openingGate.promise } : {}) });
    t.after(() => { preparation.resolve(); openingGate.resolve(); nativeClosed.resolve(); callbackGate.resolve(); return fixture.dispose(); });
    let interaction!: AgentSessionInteraction;
    let callbackJoined = false;
    const opening = Promise.resolve(fixture.adapter.createSession({ ...fixture.input,
      interactions: { async onRequest(value) { interaction = value; await callbackGate.promise; callbackJoined = true; } },
      nativeContinuations: { onExecution() { throw new Error("Rejected preparation cannot create an execution."); } },
    }));
    const rejectedOpening = timing === "before_open_return"
      ? assert.rejects(opening, (cause: unknown) => includesCause(cause, failure)) : undefined;
    let session: AgentProviderSession | undefined;
    if (timing === "after_open_return") session = await opening;
    await fixture.opened;
    await setImmediate();
    assert.ok(interaction);
    assert.equal(fixture.events.includes("candidate_return"), timing === "after_open_return");
    let retained: AgentProviderSessionCleanupError | undefined;
    const refused = assert.rejects(interaction.respond(approve(fixture.request())), (cause: unknown) => {
      assert.ok(cause instanceof AgentProviderSessionCleanupError);
      assert.ok(cause.errors.some(hasContractCode("native_continuation_preparation_failed")));
      assert.ok(includesCause(cause, failure));
      retained = cause;
      return true;
    });
    await fixture.preparationEntered;
    preparation.reject(failure);
    await refused;
    await setImmediate();
    assert.ok(retained);
    assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 0, callerTurns: 0, nativeCloses: timing === "after_open_return" ? 1 : 0 });
    assert.equal(fixture.events.includes("native_closed"), false);
    let joined = false;
    const retry = retained.retryCleanup().then(() => { joined = true; });
    await setImmediate();
    assert.equal(joined, false);
    openingGate.resolve();
    await setImmediate();
    assert.deepEqual([joined, callbackJoined, fixture.counts().nativeCloses], [false, false, 1]);
    nativeClosed.resolve();
    await setImmediate();
    assert.deepEqual([joined, callbackJoined, fixture.events.includes("native_closed")], [false, false, true]);
    callbackGate.resolve();
    await retry;
    await rejectedOpening;
    await retained.retryCleanup();
    assert.deepEqual([joined, callbackJoined, fixture.events.filter((event) => event === "candidate_open").length,
      fixture.events.filter((event) => event === "prepare").length], [true, true, 1, 1]);
    assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 0, callerTurns: 0, nativeCloses: 1 });
    if (session) {
      await assert.rejects(async () => session.close({ reason: "idle" }), (cause: unknown) => includesCause(cause, failure));
      await session.close({ reason: "idle" });
    }
  });
});

test("preparation timeout retains its late cancellation owner until native and cancellation work drain", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const preparation = deferred<void>();
  const nativeClosed = deferred<void>();
  const cancellation = deferred<void>();
  const fixture = await continuationFixture({ preparation: preparation.promise, close: () => nativeClosed.promise, cancel: () => cancellation.promise });
  t.after(() => { preparation.resolve(); nativeClosed.resolve(); cancellation.resolve(); return fixture.dispose(); });
  let interaction!: AgentSessionInteraction;
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { humanWait: { kind: "until_withdrawn_or_closed" }, limits: { cleanupTimeoutMs: 1_000 }, onRequest(value) { interaction = value; } },
    nativeContinuations: { onExecution() { throw new Error("Timed-out preparation cannot create an execution."); } },
  });
  await setImmediate();
  let retained: AgentProviderSessionCleanupError | undefined;
  const refused = assert.rejects(interaction.respond(approve(fixture.request())), (cause: unknown) => {
    assert.ok(cause instanceof AgentProviderSessionCleanupError);
    assert.ok(cause.errors.some(hasContractCode("native_continuation_preparation_failed")));
    retained = cause;
    return true;
  });
  await fixture.preparationEntered;
  t.mock.timers.tick(30_000);
  await setImmediate();
  t.mock.timers.tick(1_000);
  await refused;
  await setImmediate();
  assert.ok(retained);
  assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 0, callerTurns: 0, nativeCloses: 1 });
  let joined = false;
  const retry = retained.retryCleanup().then(() => { joined = true; });
  preparation.resolve();
  await setImmediate();
  assert.deepEqual([joined, fixture.counts().cancels, fixture.counts().dispatches], [false, 1, 0]);
  nativeClosed.resolve();
  await setImmediate();
  assert.equal(joined, false);
  cancellation.resolve();
  await retry;
  assert.deepEqual([joined, fixture.events.filter((event) => event === "prepare").length], [true, 1]);
  assert.deepEqual(fixture.counts(), { dispatches: 0, cancels: 1, callerTurns: 0, nativeCloses: 1 });
  await assert.rejects(async () => session.close({ reason: "idle" }), hasContractCode("native_continuation_preparation_failed"));
  await session.close({ reason: "idle" });
});

test("a failed opening retains its actual native output pull before releasing the original host binding", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const openingGate = deferred<void>();
  const nativePull = deferred<void>();
  const hostReturned = deferred<void>();
  const wrapperStopped = deferred<unknown>();
  const fixture = await continuationFixture({ timing: "before_open_return", outcome: "missing",
    delayOpening: openingGate.promise, afterStarted: nativePull.promise, hostBindingSupport: supportedBinding });
  const binding = makeBinding({ events: fixture.events });
  let receipt: Promise<AgentRequestResolutionResult> | undefined;
  const input: AgentCreateSessionInput = { ...fixture.input, hostBinding: binding.binding,
    interactions: { humanWait: { kind: "until_withdrawn_or_closed" }, limits: { cleanupTimeoutMs: 1_000 },
      onRequest(value) { receipt = value.respond(approve(value.request)); } },
    nativeContinuations: { async onExecution(value) {
      const iterator = value.execution.outputs[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(first.value?.kind === "event" ? first.value.event.type : undefined, "turn.started");
      void iterator.next().catch((cause: unknown) => { wrapperStopped.resolve(cause); });
      hostReturned.resolve();
    } },
  };
  const opening = Promise.resolve(fixture.adapter.createSession(input));
  let openingSettled = false;
  void opening.then(() => { openingSettled = true; }, () => { openingSettled = true; });
  let retained: AgentProviderSessionCleanupError | undefined;
  const refused = assert.rejects(opening, (cause: unknown) => {
    assert.ok(isAgentProviderSessionCleanupErrorFor(cause, input));
    assert.ok(cause.errors.some(hasContractCode("invalid_native_continuation")));
    retained = cause;
    return true;
  });
  void refused.catch(() => {});
  t.after(async () => {
    openingGate.resolve(); nativePull.resolve();
    await refused.catch(() => {});
    await fixture.dispose();
  });
  await hostReturned.promise;
  await setImmediate();
  assert.ok(fixture.events.includes("source_waiting"));
  assert.deepEqual(await receipt, { status: "delivered" });
  fixture.outcome.reject(new Error("The exact native outcome failed while its original pull remained active."));
  const stopped = await wrapperStopped.promise;
  assert.ok(stopped instanceof DOMException && stopped.name === "AbortError");
  openingGate.resolve();
  await setImmediate();
  assert.deepEqual([fixture.events.includes("native_closed"), fixture.events.includes("source_released"), binding.releaseCount(), openingSettled], [true, false, 0, false]);
  t.mock.timers.tick(1_000);
  await refused;
  assert.ok(retained);
  let joined = false;
  const retry = retained.retryCleanup().then(() => { joined = true; });
  await setImmediate();
  assert.deepEqual([joined, binding.releaseCount()], [false, 0]);
  nativePull.resolve();
  await retry;
  await retained.retryCleanup();
  assert.deepEqual([joined, binding.releaseCount(), fixture.events.includes("source_released")], [true, 1, true]);
  assert.equal(fixture.events.indexOf("source_released") < fixture.events.indexOf("host_release"), true);
  assert.deepEqual(fixture.counts(), { dispatches: 1, cancels: 0, callerTurns: 0, nativeCloses: 1 });
  assert.equal(fixture.events.filter((event) => event === "candidate_open").length, 1);
  assert.equal(fixture.events.filter((event) => event === "prepare").length, 1);
});

test("a late actual prepared receipt remains joined and checks contradictory terminal evidence after observation timeout", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const actualReceipt = deferred<AgentRequestResolutionResult>();
  const drained = deferred<void>();
  const fixture = await continuationFixture({ receipt: actualReceipt.promise });
  t.after(() => { actualReceipt.resolve({ status: "delivered" }); return fixture.dispose(); });
  let interaction!: AgentSessionInteraction;
  const session = await fixture.adapter.createSession({ ...fixture.input,
    interactions: { limits: { responseTimeoutMs: 1_000 }, onRequest(value) { interaction = value; } },
    nativeContinuations: { async onExecution(value) {
      for await (const _entry of value.execution.outputs) {}
      drained.resolve();
    } },
  });
  await setImmediate();
  const answer = interaction.respond(approve(fixture.request()));
  await fixture.responseEntered;
  await drained.promise;
  assert.ok(fixture.events.includes("source_complete"));
  fixture.terminal.resolve({ kind: "rejected", error: refusal });
  assert.deepEqual(await interaction.terminal, { kind: "rejected", error: refusal });
  t.mock.timers.tick(1_000);
  const receipt = await answer;
  assert.equal(receipt.status, "delivery_uncertain");
  if (receipt.status !== "delivery_uncertain") throw new Error("Expected uncertain response observation.");
  assert.equal(receipt.error.code, "session_interaction_delivery_uncertain");
  const originalReceipt = structuredClone(receipt);
  let closed = false;
  const closing = Promise.resolve(session.close({ reason: "idle" })).then(() => { closed = true; });
  const rejectedClose = assert.rejects(closing, hasContractCode("invalid_session_interaction"));
  await setImmediate();
  assert.deepEqual([closed, fixture.events.includes("native_closed"), fixture.counts().dispatches], [false, true, 1]);
  actualReceipt.resolve({ status: "delivered" });
  await rejectedClose;
  assert.deepEqual(receipt, originalReceipt);
  assert.deepEqual(await interaction.terminal, { kind: "rejected", error: refusal });
  assert.deepEqual(fixture.counts(), { dispatches: 1, cancels: 0, callerTurns: 0, nativeCloses: 1 });
  await session.close({ reason: "idle" });
});
