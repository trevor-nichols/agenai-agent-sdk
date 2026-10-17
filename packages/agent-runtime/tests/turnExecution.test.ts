// ------------------------------------------------------------------------------------------------
//                turnExecution.test.ts - Observable continuous-output and concurrent-response contracts
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import {
  AgentProtocolValidationError, parseAgentApprovalOptionId, parseAgentIsoDateTime,
  parseAgentItemId, parseAgentRequestId, parseAgentTurnId,
  type AgentError, type AgentRequest, type AgentRequestResolution,
} from "@agen-ai/agent-protocol";

import {
  AgentProviderDelegatedOperationError, createAgentEventOutput, throwIfAgentOperationAborted,
  type AgentProviderOutput, type AgentProviderResolveRequestInput, type AgentProviderSession,
  type AgentProviderStartTurnInput, type AgentProviderTurnExecution, type AgentProviderTurnInterruptionResult,
  type AgentRequestResolutionResult,
} from "../src/index.js";
import { createHarness, deferred, hasContractCode, invoke, makeBinding } from "./fixtures/hostBindings/harness.js";

const turnId = parseAgentTurnId("live-turn");
const itemId = parseAgentItemId("live-item");
const requestId = parseAgentRequestId("live-request");
const optionId = parseAgentApprovalOptionId("allow-once");
const request: AgentRequest = {
  requestKind: "approval", requestId, prompt: "Allow the observed operation?",
  subject: { kind: "other", itemId, title: "Observed operation" },
  options: [{ optionId, label: "Allow once", decision: "approved", consequence: { kind: 'scoped', persistence: "once", scope: { kind: "exact_action" } } }],
};
const resolution: AgentRequestResolution = { requestKind: "approval", requestId, disposition: "selected", optionId };
const refusal: AgentError = { category: "permission", code: "native_refusal", message: "The callback refused this answer.", recovery: { kind: "none" } };
const turnInput: AgentProviderStartTurnInput = { turnId, interactionMode: "default", parts: [{ type: "text", text: "Exercise the live turn." }] };

async function scenario(options: Readonly<{
  request?: AgentRequest;
  firstPull?: Promise<void>;
  answer?: (input: AgentProviderResolveRequestInput) => Promise<AgentRequestResolutionResult>;
  nativeClose?: () => Promise<void>;
  constructing?: () => void;
  interrupt?: AgentProviderSession["interruption"];
  steer?: AgentProviderSession["steering"];
}> = {}) {
  const terminal = deferred<void>();
  const answers: AgentProviderResolveRequestInput[] = [];
  let starts = 0;
  let produced = 0;
  let nativeClosed = false;
  const harness = await createHarness({ transformSession(session, context) {
    const candidate: AgentProviderSession = {
      ...session,
      startTurn(input) {
        assert.equal(this, candidate);
        assert.equal(input.onProviderExecutionStarted, undefined);
        starts += 1;
        options.constructing?.();
        input.signal?.addEventListener("abort", () => terminal.resolve(), { once: true });
        const base = { protocolVersion: 12 as const, sessionId: context.sessionId,
          turnId: input.turnId, occurredAt: parseAgentIsoDateTime("2026-10-12T00:00:00.000Z") };
        const outputs: AsyncIterable<AgentProviderOutput> = (async function* () {
          await options.firstPull;
          throwIfAgentOperationAborted(input.signal);
          produced += 1;
          yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
          produced += 1;
          yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId, itemKind: "assistant_message", status: "in_progress" } });
          produced += 1;
          yield createAgentEventOutput({ ...base, type: "request.opened", payload: { request: options.request ?? request } });
          produced += 1;
          yield createAgentEventOutput({ ...base, type: "turn.state_changed", payload: { state: "waiting_for_request", requestId } });
          produced += 1;
          yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId, streamKind: "assistant_text", delta: "Unrelated output while the answer is pending." } });
          await terminal.promise;
          throwIfAgentOperationAborted(input.signal);
          if (nativeClosed) return;
          produced += 1;
          yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "canceled" } });
        })();
        const execution: AgentProviderTurnExecution = {
          turnId: input.turnId, outputs,
          async resolveRequest(answer) {
            assert.equal(this, execution);
            answers.push(answer);
            return options.answer ? options.answer(answer) : { status: "delivered" };
          },
        };
        return execution;
      },
      async close(input) {
        await options.nativeClose?.();
        nativeClosed = true;
        terminal.resolve();
        await session.close(input);
      },
      ...(options.interrupt === undefined ? {} : { interruption: options.interrupt }),
      ...(options.steer === undefined ? {} : { steering: options.steer }),
    };
    return candidate;
  } });
  return { harness, terminal, answers, starts: () => starts, produced: () => produced };
}

async function openedRequest(execution: AgentProviderTurnExecution) {
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const outputs = [await iterator.next(), await iterator.next(), await iterator.next()];
  assert.deepEqual(outputs.map((entry) => !entry.done && entry.value.kind === "event" ? entry.value.event.type : "wrong"),
    ["turn.started", "item.started", "request.opened"]);
  return iterator;
}

async function drain(iterator: AsyncIterator<AgentProviderOutput>) {
  const outputs: AgentProviderOutput[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return outputs;
    outputs.push(next.value);
  }
}

test("A01: unrelated output arrives before any answer and the request remains answerable with a pending reader", async () => {
  const fixture = await scenario();
  const session = await fixture.harness.open("create");
  const execution = session.startTurn(turnInput);
  const iterator = await openedRequest(execution);
  const waiting = await iterator.next();
  const unrelated = await iterator.next();
  assert.deepEqual([waiting, unrelated].map((entry) => !entry.done && entry.value.kind === "event" ? entry.value.event.type : null),
    ["turn.state_changed", "content.delta"]);
  assert.deepEqual([fixture.starts(), fixture.produced(), fixture.answers.length], [1, 5, 0]);

  let readerSettled = false;
  const pending = iterator.next().then((entry) => { readerSettled = true; return entry; });
  await Promise.resolve();
  assert.equal(readerSettled, false);
  assert.deepEqual(await execution.resolveRequest({ resolution }), { status: "delivered" });
  assert.deepEqual(fixture.answers.map((answer) => answer.resolution), [resolution]);
  assert.deepEqual([fixture.starts(), fixture.produced(), readerSettled], [1, 5, false]);

  fixture.terminal.resolve();
  const terminal = await pending;
  assert.equal(!terminal.done && terminal.value.kind === "event" ? terminal.value.event.type : null, "turn.completed");
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.deepEqual([fixture.starts(), fixture.produced(), fixture.answers.length], [1, 6, 1]);
  await session.close({ reason: "idle" });
  await fixture.harness.registry.dispose();
});

test("A03/A04/A06: direct request answer overlaps the original pressured output and claims once", async () => {
  const acknowledgment = deferred<AgentRequestResolutionResult>();
  const fixture = await scenario({ answer: () => acknowledgment.promise });
  const session = await fixture.harness.open("create");
  const boundaries: string[] = [];
  const execution = session.startTurn({ ...turnInput, onProviderExecutionStarted: () => boundaries.push("turn_started") });
  assert.deepEqual([fixture.starts(), fixture.produced(), boundaries.length], [0, 0, 0]);
  assert.throws(() => session.startTurn(turnInput), hasContractCode("concurrent_turn"));
  const iterator = await openedRequest(execution);
  assert.deepEqual([fixture.starts(), fixture.produced(), boundaries], [1, 3, ["turn_started"]]);
  let settled = false;
  const answer = execution.resolveRequest({ resolution, onProviderExecutionStarted: () => boundaries.push("answer_started") })
    .then((receipt) => { settled = true; return receipt; });
  assert.deepEqual(boundaries, ["turn_started", "answer_started"]);
  assert.equal(fixture.answers.length, 1);
  assert.deepEqual(fixture.answers[0]?.resolution, resolution);
  assert.equal(fixture.answers[0]?.onProviderExecutionStarted, undefined);
  await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("request_resolution_mismatch"));
  const waiting = await iterator.next();
  assert.equal(!waiting.done && waiting.value.kind === "event" ? waiting.value.event.type : null, "turn.state_changed");
  const unrelated = await iterator.next();
  assert.equal(!unrelated.done && unrelated.value.kind === "event" ? unrelated.value.event.type : null, "content.delta");
  assert.equal(settled, false);
  await Promise.resolve();
  assert.equal(fixture.produced(), 5, "No output is read ahead while the consumer holds an output.");
  acknowledgment.resolve({ status: "delivered" });
  assert.deepEqual(await answer, { status: "delivered" });
  assert.equal(fixture.produced(), 5, "The answer acknowledgment does not require another output pull.");
  await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("request_resolution_mismatch"));
  fixture.terminal.resolve();
  const remaining = await drain(iterator);
  assert.deepEqual(remaining.map((output) => output.kind === "event" ? output.event.type : output.kind), ["turn.completed"]);
  assert.equal(fixture.answers.length, 1);
  await session.close({ reason: "idle" });
  await fixture.harness.registry.dispose();
});

test("A05/A07: precise response prechecks and a throwing observer preserve the live request", async (t) => {
  const abortReason = new DOMException("Response already canceled.", "AbortError");
  const observerFailure = new Error("The durable start boundary could not commit.");
  const controller = new AbortController();
  controller.abort(abortReason);
  const cases: readonly Readonly<{
    name: string; input: AgentProviderResolveRequestInput; expires?: boolean;
    matches: (error: unknown) => boolean;
  }>[] = [
    { name: "foreign ID", input: { resolution: { ...resolution, requestId: parseAgentRequestId("foreign-request") } }, matches: hasContractCode("request_resolution_mismatch") },
    { name: "wrong kind", input: { resolution: { requestKind: "elicitation", requestId, disposition: "canceled" } }, matches: hasContractCode("request_resolution_mismatch") },
    { name: "unoffered answer", input: { resolution: { ...resolution, optionId: parseAgentApprovalOptionId("not-offered") } }, matches: hasContractCode("request_resolution_mismatch") },
    { name: "malformed protocol", input: { resolution: { requestKind: "approval", requestId, disposition: "selected" } as AgentRequestResolution }, matches: (error) => error instanceof AgentProtocolValidationError },
    { name: "expired answer", expires: true, input: { resolution }, matches: hasContractCode("request_resolution_mismatch") },
    { name: "pre-aborted", input: { resolution, signal: controller.signal }, matches: (error) => error === abortReason },
    { name: "observer failed", input: { resolution, onProviderExecutionStarted() { throw observerFailure; } }, matches: (error) => error === observerFailure },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const fixture = await scenario({ ...(entry.expires ? { request: { ...request, expiresAt: parseAgentIsoDateTime("2000-01-01T00:00:00.000Z") } } : {}) });
    const session = await fixture.harness.open("create");
    const execution = session.startTurn(turnInput);
    const iterator = await openedRequest(execution);
    await assert.rejects(execution.resolveRequest(entry.input), entry.matches);
    assert.equal(fixture.answers.length, 0);
    const valid = entry.expires ? { requestKind: "approval" as const, requestId, disposition: "canceled" as const } : resolution;
    assert.deepEqual(await execution.resolveRequest({ resolution: valid }), { status: "delivered" });
    assert.deepEqual(fixture.answers.map((answer) => answer.resolution), [valid]);
    fixture.terminal.resolve();
    await drain(iterator);
    await session.close({ reason: "idle" });
    await fixture.harness.registry.dispose();
  });
});

test("A07: native refusal explicitly controls retry authority and uncertainty never permits replay", async (t) => {
  for (const disposition of ["pending", "unavailable", "uncertain", "throw", "inherited receipt"] as const) await t.test(disposition, async () => {
    const nativeFailure = new Error("Acknowledgment was lost after native entry.");
    let count = 0;
    const fixture = await scenario({ async answer() {
      count += 1;
      if (count > 1) return { status: "delivered" };
      if (disposition === "throw") throw nativeFailure;
      if (disposition === "inherited receipt") return Object.assign(Object.create({ status: "delivered" }), { unexpected: true });
      return disposition === "uncertain" ? { status: "delivery_uncertain", error: refusal }
        : { status: "rejected", requestState: disposition, error: refusal };
    } });
    const session = await fixture.harness.open("create");
    const execution = session.startTurn(turnInput);
    const iterator = await openedRequest(execution);
    if (disposition === "inherited receipt") {
      await assert.rejects(execution.resolveRequest({ resolution }), (error) => error instanceof AgentProviderDelegatedOperationError
        && error.operation === "resolve_request" && error.providerExecution === "started"
        && hasContractCode("invalid_operation_result")(error.cause));
    } else if (disposition === "throw") {
      await assert.rejects(execution.resolveRequest({ resolution }), (error) => error instanceof AgentProviderDelegatedOperationError
        && error.operation === "resolve_request" && error.providerExecution === "started" && error.cause === nativeFailure);
    } else {
      assert.deepEqual(await execution.resolveRequest({ resolution }), disposition === "uncertain"
        ? { status: "delivery_uncertain", error: refusal } : { status: "rejected", requestState: disposition, error: refusal });
    }
    if (disposition === "pending") {
      assert.deepEqual(await execution.resolveRequest({ resolution }), { status: "delivered" });
      assert.equal(count, 2);
    } else {
      await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode(disposition === "unavailable" ? "request_resolution_mismatch" : "session_unusable"));
      assert.equal(count, 1);
    }
    fixture.terminal.resolve();
    assert.deepEqual((await drain(iterator)).map((output) => output.kind === "event" ? output.event.type : output.kind),
      ["turn.state_changed", "content.delta", "turn.completed"]);
    if (disposition === "uncertain" || disposition === "throw" || disposition === "inherited receipt") {
      assert.throws(() => session.startTurn(turnInput), hasContractCode("session_unusable"));
    }
    await session.close({ reason: "idle" });
    await fixture.harness.registry.dispose();
  });
});

test("A07/A09: inherited execution ports cannot substitute unrelated own fields for the closed handle", async () => {
  let nativeStarts = 0;
  const harness = await createHarness({ transformSession(session) {
    return { ...session, startTurn(input) {
      nativeStarts += 1;
      return Object.assign(Object.create(session.startTurn(input)), {
        unexpectedTurn: true, unexpectedOutput: true, unexpectedResponse: true,
      });
    } };
  } });
  const session = await harness.open("create");
  const execution = session.startTurn(turnInput);
  await assert.rejects(execution.outputs[Symbol.asyncIterator]().next(), hasContractCode("invalid_operation_result"));
  assert.equal(nativeStarts, 1);
  assert.throws(() => session.startTurn(turnInput), hasContractCode("session_unusable"));
  await session.close({ reason: "shutdown" });
  await harness.registry.dispose();
});

test("A08: terminal output fences an admitted answer until its receipt settles and never revives it", async () => {
  const acknowledgment = deferred<AgentRequestResolutionResult>();
  const fixture = await scenario({ answer: () => acknowledgment.promise });
  const session = await fixture.harness.open("create");
  const execution = session.startTurn(turnInput);
  const iterator = await openedRequest(execution);
  const answer = execution.resolveRequest({ resolution });
  fixture.terminal.resolve();
  await iterator.next();
  await iterator.next();
  const completed = await iterator.next();
  assert.equal(!completed.done && completed.value.kind === "event" ? completed.value.event.type : null, "turn.completed");
  let ended = false;
  const finish = iterator.next().then((entry) => { ended = true; return entry; });
  await Promise.resolve();
  assert.equal(ended, false);
  assert.throws(() => session.startTurn(turnInput), hasContractCode("concurrent_turn"));
  await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("request_resolution_mismatch"));
  acknowledgment.resolve({ status: "rejected", requestState: "pending", error: refusal });
  assert.deepEqual(await answer, { status: "rejected", requestState: "pending", error: refusal });
  assert.deepEqual(await finish, { done: true, value: undefined });
  await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("request_resolution_mismatch"));
  const fresh = session.startTurn({ ...turnInput, turnId: parseAgentTurnId("fresh-turn") });
  await fresh.outputs[Symbol.asyncIterator]().return?.();
  assert.equal(fixture.starts(), 1);
  await session.close({ reason: "idle" });
  await fixture.harness.registry.dispose();
});

test("A09/A10: aborting the final receipt wait lets the consumer close its native owner", async (t) => {
  const acknowledgment = deferred<AgentRequestResolutionResult>();
  const receipt: AgentRequestResolutionResult = { status: "delivery_uncertain", error: refusal };
  let nativeCloses = 0;
  const fixture = await scenario({ answer: () => acknowledgment.promise, async nativeClose() {
    nativeCloses += 1;
    acknowledgment.resolve(receipt);
  } });
  const session = await fixture.harness.open("create");
  t.after(async () => {
    await session.close({ reason: "shutdown" });
    await fixture.harness.registry.dispose();
  });
  const controller = new AbortController();
  const execution = session.startTurn({ ...turnInput, signal: controller.signal });
  const iterator = await openedRequest(execution);
  const answer = execution.resolveRequest({ resolution });
  fixture.terminal.resolve();
  await iterator.next();
  await iterator.next();
  const terminal = await iterator.next();
  assert.equal(!terminal.done && terminal.value.kind === "event" ? terminal.value.event.type : null, "turn.completed");

  let cleanupEntered = false;
  const reading = (async () => {
    try { return await iterator.next(); }
    finally {
      cleanupEntered = true;
      await session.close({ reason: "shutdown" });
    }
  })();
  const abortReason = new DOMException("The output consumer was canceled.", "AbortError");
  const rejected = assert.rejects(reading, (error) => error === abortReason);
  await setImmediate();
  assert.equal(cleanupEntered, false, "Normal completion still owns the entered receipt.");
  controller.abort(abortReason);
  await setImmediate();
  assert.equal(cleanupEntered, true, "Cancellation must let caller cleanup initiate native close.");
  await rejected;
  assert.deepEqual(await answer, receipt);
  assert.equal(nativeCloses, 1);
  assert.throws(() => session.startTurn(turnInput), hasContractCode("session_closed"));
});

test("A09: reserved abort/return releases without native entry; entered abort and duplicate ownership are fenced", async () => {
  const fixture = await scenario();
  const session = await fixture.harness.open("create");
  const controller = new AbortController();
  let observedStarts = 0;
  const abandoned = session.startTurn({ ...turnInput, signal: controller.signal, onProviderExecutionStarted: () => { observedStarts += 1; } });
  controller.abort(new DOMException("Unconsumed turn canceled.", "AbortError"));
  const returned = session.startTurn(turnInput);
  await returned.outputs[Symbol.asyncIterator]().return?.();
  assert.deepEqual([fixture.starts(), observedStarts], [0, 0]);
  await assert.rejects(abandoned.outputs[Symbol.asyncIterator]().next(), (error) => error instanceof Error && error.name === "AbortError");
  const execution = session.startTurn(turnInput);
  const iterator = execution.outputs[Symbol.asyncIterator]();
  assert.throws(() => execution.outputs[Symbol.asyncIterator](), hasContractCode("concurrent_turn"));
  const first = iterator.next();
  await assert.rejects(iterator.next(), hasContractCode("concurrent_turn"));
  assert.equal((await first).done, false);
  await iterator.return?.();
  assert.throws(() => session.startTurn(turnInput), hasContractCode("session_closed"));
  assert.equal(fixture.starts(), 1);
  await fixture.harness.registry.dispose();

  const gate = deferred<void>();
  const pendingFixture = await scenario({ firstPull: gate.promise, nativeClose: async () => { gate.resolve(); } });
  const pendingSession = await pendingFixture.harness.open("create");
  const pendingAbort = new AbortController();
  const pendingExecution = pendingSession.startTurn({ ...turnInput, signal: pendingAbort.signal });
  const pending = pendingExecution.outputs[Symbol.asyncIterator]().next();
  await Promise.resolve();
  pendingAbort.abort(new DOMException("First pull canceled.", "AbortError"));
  await assert.rejects(pending, (error) => error instanceof Error && error.name === "AbortError");
  assert.throws(() => pendingSession.startTurn(turnInput), hasContractCode("session_unusable"));
  await pendingSession.close({ reason: "shutdown" });
  assert.deepEqual([pendingFixture.starts(), pendingFixture.produced()], [1, 0]);
  await pendingFixture.harness.registry.dispose();
});

test("A08: failed interruption restores exact callback; accepted interruption keeps the original terminal owner", async () => {
  let interruptCount = 0;
  const fixture = await scenario({ interrupt: { kind: "supported", async interruptTurn() {
    interruptCount += 1;
    return interruptCount === 1 ? { status: "failed", error: refusal } : { status: "accepted" };
  } } });
  const session = await fixture.harness.open("create");
  const execution = session.startTurn(turnInput);
  const iterator = await openedRequest(execution);
  if (session.interruption.kind !== "supported") throw new Error("Missing interruption fixture.");
  assert.deepEqual(await session.interruption.interruptTurn({ turnId, reason: "user_requested" }), { status: "failed", error: refusal });
  assert.deepEqual(await execution.resolveRequest({ resolution }), { status: "delivered" });
  assert.deepEqual(await session.interruption.interruptTurn({ turnId, reason: "user_requested" }), { status: "accepted" });
  assert.throws(() => session.startTurn(turnInput), hasContractCode("concurrent_turn"));
  fixture.terminal.resolve();
  assert.deepEqual((await drain(iterator)).map((output) => output.kind === "event" ? output.event.type : output.kind),
    ["turn.state_changed", "content.delta", "turn.completed"]);
  assert.equal(interruptCount, 2);
  await session.close({ reason: "idle" });
  await fixture.harness.registry.dispose();
});

test("A08: interruption cannot transfer terminal or content output away from the original execution", async (t) => {
  for (const kind of ["terminal", "content"] as const) await t.test(kind, async () => {
    let interruptCount = 0;
    const foreignInterruption: AgentProviderSession["interruption"] = {
      kind: "supported",
      // @ts-expect-error Exercise an output-bearing foreign receipt at the provider boundary.
      async interruptTurn() {
        interruptCount += 1;
        return { status: "accepted" as const, outputs: [unexpectedOutput] };
      },
    };
    const fixture = await scenario({ interrupt: foreignInterruption });
    const session = await fixture.harness.open("create");
    const execution = session.startTurn(turnInput);
    const iterator = await openedRequest(execution);
    const context = fixture.harness.contexts[0];
    if (context === undefined) throw new Error("Missing native session context.");
    const base = { protocolVersion: 12 as const, sessionId: context.sessionId, turnId,
      occurredAt: parseAgentIsoDateTime("2026-10-12T00:00:00.000Z") };
    const unexpectedOutput = kind === "terminal"
      ? createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "canceled" } })
      : createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId, streamKind: "assistant_text", delta: "Output from the wrong owner." } });
    if (session.interruption.kind !== "supported") throw new Error("Missing interruption fixture.");

    await assert.rejects(Promise.resolve(session.interruption.interruptTurn({ turnId, reason: "user_requested" })), hasContractCode("invalid_operation_result"));
    assert.deepEqual([fixture.starts(), fixture.produced(), interruptCount, fixture.answers.length], [1, 3, 1, 0]);
    assert.throws(() => session.startTurn(turnInput), hasContractCode("session_unusable"));
    await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("session_unusable"));
    fixture.terminal.resolve();
    const remaining = await drain(iterator);
    assert.deepEqual(remaining.map((output) => output.kind === "event" ? output.event.type : output.kind),
      ["turn.state_changed", "content.delta", "turn.completed"]);
    assert.equal(remaining.some((output) => output.kind === "event" && output.event.type === "content.delta"
      && output.event.payload.delta === "Output from the wrong owner."), false);
    assert.deepEqual([fixture.starts(), fixture.produced(), interruptCount, fixture.answers.length], [1, 6, 1, 0]);
    await session.close({ reason: "idle" });
    await fixture.harness.registry.dispose();
  });
});

test("A08/A09: interruption rejects an acquired reservation and enters only after the first pull", async () => {
  const firstOutput = deferred<void>();
  let interruptCount = 0;
  const fixture = await scenario({ firstPull: firstOutput.promise,
    interrupt: { kind: "supported", async interruptTurn() {
      interruptCount += 1;
      return { status: "accepted" };
    } },
  });
  const session = await fixture.harness.open("create");
  const execution = session.startTurn(turnInput);
  const iterator = execution.outputs[Symbol.asyncIterator]();
  if (session.interruption.kind !== "supported") throw new Error("Missing interruption fixture.");
  await assert.rejects(Promise.resolve(session.interruption.interruptTurn({ turnId, reason: "user_requested" })), hasContractCode("active_turn_mismatch"));
  assert.deepEqual([fixture.starts(), fixture.produced(), interruptCount], [0, 0, 0]);

  const first = iterator.next();
  assert.deepEqual(await session.interruption.interruptTurn({ turnId, reason: "user_requested" }), { status: "accepted" });
  assert.deepEqual([fixture.starts(), fixture.produced(), interruptCount], [1, 0, 1]);
  assert.throws(() => session.startTurn(turnInput), hasContractCode("concurrent_turn"));
  firstOutput.resolve();
  const started = await first;
  assert.equal(!started.done && started.value.kind === "event" ? started.value.event.type : null, "turn.started");
  fixture.terminal.resolve();
  assert.deepEqual((await drain(iterator)).map((output) => output.kind === "event" ? output.event.type : output.kind),
    ["item.started", "request.opened", "turn.state_changed", "content.delta", "turn.completed"]);
  assert.deepEqual([fixture.starts(), fixture.produced(), interruptCount], [1, 6, 1]);
  await session.close({ reason: "idle" });
  await fixture.harness.registry.dispose();
});

test("A08/A09: steering refuses an unstarted reservation and enters during the first pending pull", async () => {
  const firstOutput = deferred<void>();
  let steeringCount = 0;
  const fixture = await scenario({ firstPull: firstOutput.promise,
    steer: { kind: "supported", async steerTurn() {
      steeringCount += 1;
      return { status: "delivered" };
    } },
  });
  const session = await fixture.harness.open("create");
  try {
    const execution = session.startTurn(turnInput);
    if (session.steering.kind !== "supported") throw new Error("Missing steering fixture.");
    const steeringInput = { turnId, parts: [{ type: "text" as const, text: "Use the updated direction." }] };
    await assert.rejects(Promise.resolve(session.steering.steerTurn(steeringInput)), hasContractCode("active_turn_mismatch"));
    const iterator = execution.outputs[Symbol.asyncIterator]();
    await assert.rejects(Promise.resolve(session.steering.steerTurn(steeringInput)), hasContractCode("active_turn_mismatch"));
    assert.deepEqual([fixture.starts(), fixture.produced(), steeringCount], [0, 0, 0]);

    const first = iterator.next();
    assert.deepEqual(await session.steering.steerTurn(steeringInput), { status: "delivered" });
    assert.deepEqual([fixture.starts(), fixture.produced(), steeringCount], [1, 0, 1]);
    firstOutput.resolve();
    const started = await first;
    assert.equal(!started.done && started.value.kind === "event" ? started.value.event.type : null, "turn.started");
    fixture.terminal.resolve();
    assert.deepEqual((await drain(iterator)).map((output) => output.kind === "event" ? output.event.type : output.kind),
      ["item.started", "request.opened", "turn.state_changed", "content.delta", "turn.completed"]);
    assert.deepEqual([fixture.starts(), fixture.produced(), steeringCount], [1, 6, 1]);
  } finally {
    firstOutput.resolve();
    fixture.terminal.resolve();
    await session.close({ reason: "idle" });
    await fixture.harness.registry.dispose();
  }
});

test("A08/A04: concurrent pending refusal is restored only after failed interruption in either completion order", async (t) => {
  for (const outcome of ["failed", "accepted"] as const) {
    for (const order of ["response first", "interruption first"] as const) await t.test(`${outcome}, ${order}`, async () => {
      const acknowledgment = deferred<AgentRequestResolutionResult>();
      const interruptionReceipt = deferred<AgentProviderTurnInterruptionResult>();
      let interruptCount = 0;
      const fixture = await scenario({ answer: () => fixture.answers.length === 1
        ? acknowledgment.promise : Promise.resolve({ status: "delivered" }),
        interrupt: { kind: "supported", async interruptTurn() {
          interruptCount += 1;
          return interruptionReceipt.promise;
        } },
      });
      const session = await fixture.harness.open("create");
      const execution = session.startTurn(turnInput);
      const iterator = await openedRequest(execution);
      let answerSettled = false;
      let interruptionSettled = false;
      const answer = execution.resolveRequest({ resolution }).then((receipt) => { answerSettled = true; return receipt; });
      if (session.interruption.kind !== "supported") throw new Error("Missing interruption fixture.");
      const interrupted = Promise.resolve(session.interruption.interruptTurn({ turnId, reason: "user_requested" }))
        .then((receipt) => { interruptionSettled = true; return receipt; });
      assert.deepEqual([fixture.produced(), fixture.answers.length, interruptCount, answerSettled, interruptionSettled], [3, 1, 1, false, false]);
      const refused: AgentRequestResolutionResult = { status: "rejected", requestState: "pending", error: refusal };
      const interruption: AgentProviderTurnInterruptionResult = outcome === "failed"
        ? { status: "failed", error: refusal } : { status: "accepted" };

      if (order === "response first") {
        acknowledgment.resolve(refused);
        assert.deepEqual(await answer, refused);
        assert.equal(interruptionSettled, false);
        await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("request_resolution_mismatch"));
        interruptionReceipt.resolve(interruption);
        assert.deepEqual(await interrupted, interruption);
      } else {
        interruptionReceipt.resolve(interruption);
        assert.deepEqual(await interrupted, interruption);
        assert.equal(answerSettled, false);
        await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("request_resolution_mismatch"));
        acknowledgment.resolve(refused);
        assert.deepEqual(await answer, refused);
      }
      assert.deepEqual([fixture.produced(), fixture.answers.length, interruptCount], [3, 1, 1]);
      if (outcome === "failed") {
        assert.deepEqual(await execution.resolveRequest({ resolution }), { status: "delivered" });
        assert.deepEqual(fixture.answers.map((input) => input.resolution), [resolution, resolution]);
      } else {
        await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("request_resolution_mismatch"));
        assert.deepEqual(fixture.answers.map((input) => input.resolution), [resolution]);
      }
      fixture.terminal.resolve();
      assert.deepEqual((await drain(iterator)).map((output) => output.kind === "event" ? output.event.type : output.kind),
        ["turn.state_changed", "content.delta", "turn.completed"]);
      assert.deepEqual([fixture.starts(), fixture.produced(), interruptCount], [1, 6, 1]);
      await session.close({ reason: "idle" });
      await fixture.harness.registry.dispose();
    });
  }
});

test("A08: overlapping interruptions restore only after every refusal and any acceptance prevents revival", async (t) => {
  for (const outcomes of [["failed", "failed"], ["accepted", "failed"], ["failed", "accepted"]] as const) await t.test(outcomes.join(" then "), async () => {
    const receipts = [deferred<AgentProviderTurnInterruptionResult>(), deferred<AgentProviderTurnInterruptionResult>()] as const;
    let interruptCount = 0;
    const fixture = await scenario({ interrupt: { kind: "supported", async interruptTurn() {
      const receipt = receipts[interruptCount];
      interruptCount += 1;
      if (receipt === undefined) throw new Error("Unexpected native interruption.");
      return receipt.promise;
    } } });
    const session = await fixture.harness.open("create");
    const execution = session.startTurn(turnInput);
    const iterator = await openedRequest(execution);
    if (session.interruption.kind !== "supported") throw new Error("Missing interruption fixture.");
    const first = session.interruption.interruptTurn({ turnId, reason: "user_requested" });
    const second = session.interruption.interruptTurn({ turnId, reason: "user_requested" });
    assert.deepEqual([fixture.produced(), fixture.answers.length, interruptCount], [3, 0, 2]);
    const firstResult: AgentProviderTurnInterruptionResult = outcomes[0] === "failed"
      ? { status: "failed", error: refusal } : { status: "accepted" };
    const secondResult: AgentProviderTurnInterruptionResult = outcomes[1] === "failed"
      ? { status: "failed", error: refusal } : { status: "accepted" };
    receipts[0].resolve(firstResult);
    assert.deepEqual(await first, firstResult);
    await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("request_resolution_mismatch"));
    assert.equal(fixture.answers.length, 0);
    receipts[1].resolve(secondResult);
    assert.deepEqual(await second, secondResult);
    if (outcomes.every((status) => status === "failed")) {
      assert.deepEqual(await execution.resolveRequest({ resolution }), { status: "delivered" });
      assert.deepEqual(fixture.answers.map((input) => input.resolution), [resolution]);
    } else {
      await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("request_resolution_mismatch"));
      assert.equal(fixture.answers.length, 0);
    }
    fixture.terminal.resolve();
    await drain(iterator);
    assert.deepEqual([fixture.starts(), fixture.produced(), interruptCount], [1, 6, 2]);
    await session.close({ reason: "idle" });
    await fixture.harness.registry.dispose();
  });
});

test("A09: synchronous cancellation during candidate construction retains cleanup without pulling native output", async () => {
  const controller = new AbortController();
  let nativeCloses = 0;
  const fixture = await scenario({ constructing() {
    controller.abort(new DOMException("Canceled during provider entry.", "AbortError"));
  }, async nativeClose() { nativeCloses += 1; } });
  const session = await fixture.harness.open("create");
  const execution = session.startTurn({ ...turnInput, signal: controller.signal });
  const iterator = execution.outputs[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), (error) => error instanceof Error && error.name === "AbortError");
  assert.throws(() => session.startTurn(turnInput), hasContractCode("session_unusable"));
  await session.close({ reason: "shutdown" });
  assert.deepEqual([fixture.starts(), fixture.produced(), nativeCloses], [1, 0, 1]);
  await fixture.harness.registry.dispose();
});

test("A10: close initiates native quiescence before joining response acknowledgment and host callbacks", async () => {
  const acknowledgment = deferred<AgentRequestResolutionResult>();
  const callbackFinish = deferred<void>();
  const callbackEntered = deferred<void>();
  const nativeClosed = deferred<void>();
  const events: string[] = [];
  let closeCount = 0;
  const fixture = await scenario({ answer: () => acknowledgment.promise, async nativeClose() {
    events.push("native_close");
    closeCount += 1;
    if (closeCount === 1) throw new Error("Native producers could not yet quiesce.");
    acknowledgment.resolve({ status: "delivery_uncertain", error: refusal });
    nativeClosed.resolve();
  } });
  const host = makeBinding({ events, async invoke() {
    callbackEntered.resolve();
    await callbackFinish.promise;
    events.push("host_callback_finished");
    return { kind: "success", value: { finished: true } };
  } });
  const session = await fixture.harness.open("create", host.binding);
  const callback = invoke(fixture.harness.facade());
  await callbackEntered.promise;
  const execution = session.startTurn(turnInput);
  await openedRequest(execution);
  const answer = execution.resolveRequest({ resolution });
  await assert.rejects(async () => session.close({ reason: "shutdown" }), /Native producers could not yet quiesce/);
  assert.equal(host.releaseCount(), 0);
  assert.throws(() => session.startTurn(turnInput), hasContractCode("session_unusable"));
  await assert.rejects(execution.resolveRequest({ resolution }), hasContractCode("session_unusable"));
  let closed = false;
  const closing = Promise.resolve(session.close({ reason: "shutdown" })).then(() => { closed = true; });
  await nativeClosed.promise;
  assert.deepEqual(await answer, { status: "delivery_uncertain", error: refusal });
  assert.equal(closed, false);
  assert.equal(host.releaseCount(), 0);
  callbackFinish.resolve();
  assert.deepEqual(await callback, { kind: "success", value: { finished: true } });
  await closing;
  await session.close({ reason: "shutdown" });
  assert.deepEqual(events, ["native_close", "native_close", "host_callback_finished", "host_release"]);
  assert.equal(host.releaseCount(), 1);
  await fixture.harness.registry.dispose();
});
