import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { parseAgentArtifactId, parseAgentTurnId, type AgentError } from "@agen-ai/agent-protocol";

import {
  AgentProviderContractError,
  AgentProviderDelegatedOperationError,
  createAgentArtifactOutput,
  createAgentEventOutput,
  createAgentLifecycleOutput,
} from "../src/index.js";
import {
  acceptedInputReceipt as accepted,
  executionInputFixture,
  finishInputTurn,
  inputItemId,
  inputMessage,
  inputRefusal as refusal,
  inputSupport,
  inputTurnEvent as event,
} from "./fixtures/executionInput.js";
import { deferred, hasContractCode } from "./fixtures/hostBindings/harness.js";

const uncertainError: AgentError = { category: "transport", code: "execution_input_delivery_uncertain",
  message: "The native execution-input receipt was not authoritatively observed.", recovery: { kind: "none" } };

test("terminal reconciliation rejects extra native output and source exhaustion failures after accepted consumption", async (t) => {
  for (const fault of ["post-terminal output", "source exhaustion failure"] as const) await t.test(fault, async (t) => {
    const failure = new Error("The native generator failed during normal exhaustion.");
    const fixture = await executionInputFixture({ outputs(source) {
      return (async function* () {
        let last;
        for await (const output of source) { last = output; yield output; }
        assert.ok(send); send.consume();
        if (fault === "source exhaustion failure") throw failure;
        assert.ok(last); yield last;
      })();
    } }); t.after(() => fixture.dispose());
    const session = await fixture.open(); const turn = await fixture.enter(session);
    const pending = turn.input.sendMessage(inputMessage("consumed-before-source-violation"));
    const send = turn.native.sends[0]!; send.accept();
    const receipt = accepted(await pending);
    turn.native.emit({ ...turn.native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } }); turn.native.end();
    const rejected = assert.rejects(turn.iterator.next(), fault === "post-terminal output"
      ? hasContractCode("invalid_turn_sequence") : (error: unknown) => error === failure);
    await rejected;
    assert.deepEqual(await receipt.settled, { status: "consumed", messageId: "consumed-before-source-violation",
      turnId: "input-turn", placement: "original_native_command" });
    await session.close({ reason: "error" });
    await assert.rejects(turn.input.sendMessage(inputMessage("after-source-violation")), hasContractCode("session_closed"));
    assert.equal(fixture.closes(), 1);
    assert.deepEqual(turn.native.sends.map((entry) => entry.input.messageId), ["consumed-before-source-violation"]);
  });
});

test("terminal reconciliation preserves bounded trailing output order and counts artifact bytes without JSON expansion", async (t) => {
  const cases = [
    { name: "32 lifecycle outputs", kind: "lifecycle", count: 32, overflow: false },
    { name: "33 lifecycle outputs", kind: "lifecycle", count: 33, overflow: true },
    { name: "one ten-MiB artifact", kind: "artifact", count: 1, overflow: false },
    { name: "two ten-MiB artifacts", kind: "artifact", count: 2, overflow: true },
  ] as const;
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const fixture = await executionInputFixture({ outputs(source) {
      return (async function* () {
        yield* source;
        for (let index = 0; index < scenario.count; index += 1) {
          yield scenario.kind === "lifecycle"
            ? createAgentLifecycleOutput({ type: "process.exited", occurredAt: "2026-10-23T12:00:00.000Z", message: `tail:${index}`, exitCode: index })
            : createAgentArtifactOutput({ descriptor: { artifactId: parseAgentArtifactId(`tail:${index}`), kind: "diff", displayName: `Tail artifact ${index}` },
              source: { kind: "bytes", bytes: new Uint8Array(10 * 1_024 * 1_024).fill(91) }, delivery: "best_effort" });
        }
      })();
    } }); t.after(() => fixture.dispose());
    const session = await fixture.open(); const turn = await fixture.enter(session);
    const terminal = { ...turn.native.base, type: "turn.completed" as const,
      payload: { outcome: "completed" as const, structuredOutput: { kind: "not_requested" as const } } };
    turn.native.emit(terminal); turn.native.end();
    if (scenario.overflow) {
      await assert.rejects(turn.iterator.next(), hasContractCode("invalid_operation_result"));
      await session.close({ reason: "error" });
      assert.equal(fixture.closes(), 1);
    } else {
      assert.deepEqual(await turn.iterator.next(), { done: false, value: createAgentEventOutput(terminal) });
      const observed: string[] = [];
      for (;;) {
        const output = await turn.iterator.next(); if (output.done) break;
        if (scenario.kind === "lifecycle" && output.value.kind === "lifecycle") {
          observed.push(`${output.value.lifecycle.message}:${output.value.lifecycle.exitCode}`);
        } else if (scenario.kind === "artifact" && output.value.kind === "artifact" && output.value.candidate.source.kind === "bytes") {
          const bytes = output.value.candidate.source.bytes;
          assert.equal(bytes.byteLength, 10 * 1_024 * 1_024);
          assert.deepEqual([bytes[0], bytes[bytes.byteLength - 1]], [91, 91]);
          observed.push(output.value.candidate.descriptor.artifactId);
        } else assert.fail("Expected the exact native trailing output kind.");
      }
      assert.deepEqual(observed, Array.from({ length: scenario.count }, (_, index) => scenario.kind === "lifecycle" ? `tail:${index}:${index}` : `tail:${index}`));
      assert.deepEqual(await turn.iterator.next(), { done: true, value: undefined });
    }
    assert.deepEqual(turn.native.sends, []);
  });
});

test("terminal drain has a thirty-second ceiling and resolves public observations before retaining cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const nativeCloseEntered = deferred<void>();
  const fixture = await executionInputFixture({ nativeClose: async () => { nativeCloseEntered.resolve(); } }); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  const pending = turn.input.sendMessage(inputMessage("never-observed"));
  turn.native.sends[0]!.accept(); const receipt = accepted(await pending);
  turn.native.emit({ ...turn.native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } }); turn.native.end();
  let published = false;
  const terminal = turn.iterator.next().then((output) => { published = true; return output; });
  const rejected = assert.rejects(terminal, hasContractCode("invalid_operation_result"));
  await turn.native.terminalRead.promise; await setImmediate();
  t.mock.timers.tick(29_999); await setImmediate(); assert.equal(published, false);
  t.mock.timers.tick(1); await rejected;
  assert.deepEqual(await receipt.settled, { status: "unconfirmed", messageId: "never-observed", reason: "correlation_lost" });
  await nativeCloseEntered.promise;
  assert.equal(fixture.closes(), 1);
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["never-observed"]);
});

test("a hanging post-terminal source step has the same bounded drain and native cleanup owner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const releaseNative = deferred<void>(); const nativeCloseEntered = deferred<void>();
  const fixture = await executionInputFixture({
    outputs(source) { return (async function* () { yield* source; await releaseNative.promise; })(); },
    async nativeClose() { nativeCloseEntered.resolve(); releaseNative.resolve(); },
  }); t.after(() => fixture.dispose());
  const session = await fixture.open(); const turn = await fixture.enter(session);
  const pending = turn.input.sendMessage(inputMessage("consumed-before-stalled-exhaustion"));
  turn.native.sends[0]!.accept(); const receipt = accepted(await pending);
  turn.native.sends[0]!.consume();
  assert.deepEqual(await receipt.settled, { status: "consumed", messageId: "consumed-before-stalled-exhaustion",
    turnId: "input-turn", placement: "original_native_command" });
  turn.native.emit({ ...turn.native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } }); turn.native.end();
  let published = false;
  const terminal = turn.iterator.next().then((output) => { published = true; return output; });
  const rejected = assert.rejects(terminal, hasContractCode("invalid_operation_result"));
  void rejected.catch(() => {});
  await turn.native.terminalRead.promise; await setImmediate();
  t.mock.timers.tick(29_999); await setImmediate(); assert.equal(published, false);
  t.mock.timers.tick(1); await rejected; await nativeCloseEntered.promise;
  await session.close({ reason: "error" });
  assert.equal(fixture.closes(), 1);
  assert.deepEqual(await receipt.settled, { status: "consumed", messageId: "consumed-before-stalled-exhaustion",
    turnId: "input-turn", placement: "original_native_command" });
});

test("native output failure preserves acceptance and resolves consumption observation as native_failed", async (t) => {
  const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  const pending = turn.input.sendMessage(inputMessage("accepted-before-native-failure"));
  turn.native.sends[0]!.accept(); const receipt = accepted(await pending);
  const failure = new Error("The original native output stream failed.");
  turn.native.fail(failure);
  await assert.rejects(turn.iterator.next(), (error: unknown) => error === failure);
  assert.deepEqual(await receipt.settled, { status: "unconfirmed", messageId: "accepted-before-native-failure", reason: "native_failed" });
  assert.equal(receipt.status, "accepted");
  await assert.rejects(turn.input.sendMessage(inputMessage("after-native-failure")), hasContractCode("session_unusable"));
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["accepted-before-native-failure"]);
});

test("post-entry abort and the thirty-second receipt deadline fence mutation while the original reader drains", async (t) => {
  for (const trigger of ["abort", "deadline"] as const) await t.test(trigger, async (t) => {
    if (trigger === "deadline") t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
    const session = await fixture.open();
    const turn = await fixture.enter(session);
    const controller = new AbortController();
    const pending = turn.input.sendMessage({ ...inputMessage("entered"), signal: controller.signal });
    assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["entered"]);
    if (trigger === "abort") controller.abort(new Error("Caller left after native entry."));
    else t.mock.timers.tick(30_000);
    const receipt = await pending;
    const expected = { status: "delivery_uncertain", messageId: "entered", error: uncertainError };
    assert.deepEqual(receipt, expected);
    assert.equal(Object.isFrozen(receipt), true);
    await assert.rejects(turn.input.sendMessage(inputMessage("never-replay")), hasContractCode("session_unusable"));
    assert.throws(() => session.startTurn({ turnId: parseAgentTurnId("overlap"), interactionMode: "default", parts: [{ type: "text", text: "Do not start another native turn." }] }), hasContractCode("session_unusable"));
    turn.native.sends[0]!.accept(); turn.native.sends[0]!.consume();
    await event(turn, { ...turn.native.base, type: "item.started", payload: { itemId: inputItemId, itemKind: "assistant_message", status: "in_progress" } });
    await event(turn, { ...turn.native.base, type: "content.delta", payload: { itemId: inputItemId, streamKind: "assistant_text", delta: "Original output remains readable after uncertainty." } });
    await event(turn, { ...turn.native.base, type: "item.completed", payload: { itemId: inputItemId, itemKind: "assistant_message", status: "completed" } });
    await finishInputTurn(turn);
    assert.deepEqual(receipt, expected, "A late native acceptance and consumption cannot rewrite the returned uncertainty.");
    assert.throws(() => session.startTurn({ turnId: parseAgentTurnId("after-drain"), interactionMode: "default", parts: [{ type: "text", text: "The drained reader cannot restore mutation authority." }] }), hasContractCode("session_unusable"));
    assert.equal(fixture.closes(), 0);
    await session.close({ reason: "error" });
    assert.equal(fixture.closes(), 1);
    assert.equal(fixture.turns.length, 1);
  });
});

test("native rejection and native uncertainty return their exact AgentError and preserve the active output owner", async (t) => {
  for (const status of ["rejected", "delivery_uncertain"] as const) await t.test(status, async (t) => {
    const fixture = await executionInputFixture({ send: async ({ input }) => ({ status, messageId: input.messageId, error: refusal }) });
    t.after(() => fixture.dispose());
    const session = await fixture.open(); const turn = await fixture.enter(session);
    assert.deepEqual(await turn.input.sendMessage(inputMessage("native-result")), { status, messageId: "native-result", error: refusal });
    if (status === "rejected") {
      await assert.rejects(turn.input.sendMessage(inputMessage("native-result")), hasContractCode("execution_input_identity_reused"));
      assert.deepEqual(await turn.input.sendMessage(inputMessage("after-refusal")), { status: "rejected", messageId: "after-refusal", error: refusal });
    } else await assert.rejects(turn.input.sendMessage(inputMessage("after-uncertainty")), hasContractCode("session_unusable"));
    await finishInputTurn(turn);
    assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), status === "rejected" ? ["native-result", "after-refusal"] : ["native-result"]);
  });
});

test("a synchronous native invocation failure immediately fences sibling sends and reports started delegation", async (t) => {
  const cause = new Error("The native send entered and threw.");
  const fixture = await executionInputFixture({ send() { throw cause; } }); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  const first = turn.input.sendMessage(inputMessage("throwing-send"));
  const sibling = turn.input.sendMessage(inputMessage("same-tick-sibling"));
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof AgentProviderDelegatedOperationError);
    assert.deepEqual({ operation: error.operation, providerExecution: error.providerExecution, cause: error.cause },
      { operation: "send_execution_input", providerExecution: "started", cause });
    return true;
  });
  await assert.rejects(sibling, hasContractCode("session_unusable"));
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["throwing-send"]);
});

test("lost, invalid or rejected native settlement always resolves public acceptance as unconfirmed and suppresses successful terminal output", async (t) => {
  for (const fault of ["message identity", "turn identity", "rejected promise", "native correlation lost"] as const) await t.test(fault, async (t) => {
    const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
    const turn = await fixture.enter(await fixture.open());
    const pending = turn.input.sendMessage(inputMessage("accepted-once"));
    const send = turn.native.sends[0]!; send.accept();
    const receipt = accepted(await pending);
    if (fault === "rejected promise") send.settlement.reject(new Error("Native consumption observation failed."));
    else if (fault === "native correlation lost") send.settlement.resolve({ status: "unconfirmed", messageId: send.input.messageId, reason: "correlation_lost" });
    else send.settlement.resolve({ status: "consumed", messageId: fault === "message identity" ? inputMessage("foreign-message").messageId : send.input.messageId,
      turnId: parseAgentTurnId(fault === "turn identity" ? "foreign-turn" : "input-turn"), placement: "original_native_command" });
    assert.deepEqual(await receipt.settled, { status: "unconfirmed", messageId: "accepted-once", reason: "correlation_lost" });
    assert.equal(receipt.status, "accepted");
    await assert.rejects(turn.input.sendMessage(inputMessage("after-invalid-evidence")), hasContractCode("session_unusable"));
    turn.native.emit({ ...turn.native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } }); turn.native.end();
    await assert.rejects(turn.iterator.next(), hasContractCode(fault === "native correlation lost" ? "execution_input_correlation_lost" : "invalid_operation_result"));
    assert.deepEqual(turn.native.sends.map((entry) => entry.input.messageId), ["accepted-once"]);
    assert.deepEqual(await receipt.settled, { status: "unconfirmed", messageId: "accepted-once", reason: "correlation_lost" });
  });
});

test("invalid receipt correlation is a delegated failure rather than an accepted public receipt", async (t) => {
  const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  const pending = turn.input.sendMessage(inputMessage("exact-message"));
  turn.native.sends[0]!.receipt.resolve({ status: "rejected", messageId: inputMessage("foreign-message").messageId, error: refusal });
  await assert.rejects(pending, (error: unknown) => error instanceof AgentProviderDelegatedOperationError
    && error.operation === "send_execution_input" && error.providerExecution === "started"
    && error.cause instanceof AgentProviderContractError && error.cause.code === "invalid_operation_result");
  await assert.rejects(turn.input.sendMessage(inputMessage("after-invalid-receipt")), hasContractCode("session_unusable"));
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["exact-message"]);
});

test("declared unavailable consumption reporting returns unconfirmed without inventing consumption or failing terminal output", async (t) => {
  const fixture = await executionInputFixture({ support: { ...inputSupport, consumptionReporting: "unavailable" } }); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  const pending = turn.input.sendMessage(inputMessage("unreported"));
  turn.native.sends[0]!.accept(); const receipt = accepted(await pending);
  turn.native.sends[0]!.settlement.resolve({ status: "unconfirmed", messageId: inputMessage("unreported").messageId, reason: "provider_does_not_report_consumption" });
  assert.deepEqual(await receipt.settled, { status: "unconfirmed", messageId: "unreported", reason: "provider_does_not_report_consumption" });
  await finishInputTurn(turn);
  assert.equal(receipt.status, "accepted");
});

test("close enters native quiescence before joining an unresolved native send", async (t) => {
  const nativeCloseEntered = deferred<void>();
  const releaseClose = deferred<void>();
  const fixture = await executionInputFixture({ nativeClose: async () => { nativeCloseEntered.resolve(); await releaseClose.promise; } });
  t.after(() => fixture.dispose());
  const session = await fixture.open(); const turn = await fixture.enter(session);
  const pending = turn.input.sendMessage(inputMessage("entered-at-close"));
  const closing = session.close({ reason: "shutdown" });
  await nativeCloseEntered.promise;
  assert.equal(fixture.closes(), 1);
  assert.deepEqual(await pending, { status: "delivery_uncertain", messageId: "entered-at-close", error: uncertainError });
  await assert.rejects(turn.input.sendMessage(inputMessage("after-close-started")), hasContractCode("session_unusable"));
  assert.equal(turn.native.sends[0]!.input.signal?.aborted, true);
  turn.native.sends[0]!.receipt.resolve({ status: "rejected", messageId: inputMessage("entered-at-close").messageId, error: refusal });
  releaseClose.resolve(); await closing;
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["entered-at-close"]);
  await assert.rejects(turn.input.sendMessage(inputMessage("after-close")), hasContractCode("session_closed"));
});

test("close cancels a pending terminal pull and preserves acceptance before native cleanup finishes", async (t) => {
  const nativeCloseEntered = deferred<void>(); const releaseClose = deferred<void>();
  t.after(() => releaseClose.resolve());
  const fixture = await executionInputFixture({ nativeClose: async () => { nativeCloseEntered.resolve(); await releaseClose.promise; } });
  t.after(() => fixture.dispose());
  const session = await fixture.open(); const turn = await fixture.enter(session);
  const pending = turn.input.sendMessage(inputMessage("accepted-at-close"));
  turn.native.sends[0]!.accept(); const receipt = accepted(await pending);
  const settlement = receipt.settled;
  turn.native.emit({ ...turn.native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } }); turn.native.end();
  let terminalRejected = false;
  const terminal = turn.iterator.next();
  const stopped = assert.rejects(terminal, (error: unknown) => {
    terminalRejected = true;
    return error instanceof DOMException && error.name === "AbortError";
  });
  void stopped.catch(() => {});
  await turn.native.terminalRead.promise; await setImmediate();
  const closing = session.close({ reason: "shutdown" }); await nativeCloseEntered.promise;
  assert.deepEqual(await settlement, { status: "unconfirmed", messageId: "accepted-at-close", reason: "closed" });
  await setImmediate();
  assert.equal(terminalRejected, true, "Closing must reject the pending terminal pull while native cleanup remains held.");
  await stopped;
  turn.native.sends[0]!.consume("owned_native_continuation");
  assert.deepEqual(await receipt.settled, { status: "unconfirmed", messageId: "accepted-at-close", reason: "closed" });
  assert.equal(receipt.status, "accepted"); assert.equal(receipt.messageId, "accepted-at-close");
  assert.equal(receipt.settled, settlement); assert.equal(Object.isFrozen(receipt), true);
  releaseClose.resolve(); await closing;
  assert.equal(fixture.closes(), 1);
});

test("failed native cleanup retains the stopped send owner for an explicit close retry", async (t) => {
  const failure = new Error("The native producer is still live.");
  const fixture = await executionInputFixture({ nativeClose: async (attempt) => { if (attempt === 1) throw failure; } });
  t.after(() => fixture.dispose());
  const session = await fixture.open(); const turn = await fixture.enter(session);
  const pending = turn.input.sendMessage(inputMessage("retained-through-close-failure"));
  turn.native.sends[0]!.accept(); const receipt = accepted(await pending);
  await assert.rejects(async () => session.close({ reason: "shutdown" }), (error: unknown) => error === failure);
  assert.deepEqual(await receipt.settled, { status: "unconfirmed", messageId: "retained-through-close-failure", reason: "closed" });
  await assert.rejects(turn.input.sendMessage(inputMessage("cannot-reenter")), hasContractCode("session_unusable"));
  await session.close({ reason: "shutdown" });
  assert.equal(fixture.closes(), 2);
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["retained-through-close-failure"]);
  await assert.rejects(turn.input.sendMessage(inputMessage("closed-after-retry")), hasContractCode("session_closed"));
});
