import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import {
  parseAgentApprovalOptionId,
  parseAgentCapabilities,
  parseAgentEffectiveContentId,
  parseAgentEnvironmentId,
  parseAgentOutputSchema,
  parseAgentRequestId,
  parseAgentSessionPlanReviewRequest,
  parseAgentTurnId,
  type AgentRequest,
  type AgentRequestResolution,
} from "@agen-ai/agent-protocol";

import {
  createAgentEventOutput,
  type AgentExecutionInputMessage,
  type AgentExecutionInputReceipt,
  type AgentNativeContinuation,
  type AgentNativeContinuationOutcome,
  type AgentProviderPreparedSessionInteraction,
  type AgentProviderTurnInterruptionResult,
  type AgentRequestResolutionResult,
  type AgentSessionInteraction,
  type AgentSessionInteractionTerminal,
} from "../src/index.js";
import { createFakeAgentProvider } from "../src/testing/index.js";
import {
  acceptedInputReceipt as accepted,
  executionInputFixture,
  finishInputTurn,
  inputItemId,
  inputMessage,
  inputRefusal as refusal,
  inputTurnEvent as event,
  inputSupport,
  nativeInputTurn,
  type NativeInputSend,
} from "./fixtures/executionInput.js";
import { deferred, hasContractCode } from "./fixtures/hostBindings/harness.js";
import { approve } from "./fixtures/nativeContinuations.js";
import { grant, nativeOffer, supported as interactionSupport } from "./fixtures/sessionInteractions.js";

async function consume(send: NativeInputSend, pending: Promise<AgentExecutionInputReceipt>, placement: "original_native_command" | "owned_native_continuation" = "original_native_command") {
  send.accept();
  const receipt = accepted(await pending);
  send.consume(placement);
  assert.deepEqual(await receipt.settled, { status: "consumed", messageId: send.input.messageId,
    turnId: parseAgentTurnId("input-turn"), placement });
  return receipt;
}

test("input requires the sole reader to enter, snapshots text, and correlates both native placements", async (t) => {
  const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
  const session = await fixture.open();
  const execution = session.startTurn({ turnId: parseAgentTurnId("input-turn"), interactionMode: "default", parts: [{ type: "text", text: "Original requirement." }] });
  const input = execution.input;
  if (input?.kind !== "supported") throw new Error("Expected input support before lazy entry.");
  await assert.rejects(input.sendMessage(inputMessage("before-reader")), hasContractCode("active_turn_mismatch"));
  const iterator = execution.outputs[Symbol.asyncIterator]();
  await assert.rejects(input.sendMessage(inputMessage("before-pull")), hasContractCode("active_turn_mismatch"));
  assert.equal(fixture.turns.length, 0);
  const first = await iterator.next();
  assert.equal(!first.done && first.value.kind === "event" ? first.value.event.type : null, "turn.started");
  const native = fixture.turns[0]!;
  const turn = { execution, iterator, native, input };
  const mutable = { ...inputMessage("correction:α"), parts: [{ type: "text" as const, text: "Keep the exact original text." }], summary: "Correct the original requirement" };
  const pending = input.sendMessage(mutable);
  mutable.parts[0]!.text = "Changed by the caller after send.";
  assert.deepEqual(native.sends.map((send) => ({ messageId: send.input.messageId, parts: send.input.parts, summary: send.input.summary })),
    [{ messageId: "correction:α", parts: [{ type: "text", text: "Keep the exact original text." }], summary: "Correct the original requirement" }]);
  assert.equal(Object.isFrozen(native.sends[0]!.input.parts[0]), true);
  const receipt = await consume(native.sends[0]!, pending);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(await receipt.settled), true);
  const continuation = input.sendMessage(inputMessage("correction:continuation"));
  await consume(native.sends[1]!, continuation, "owned_native_continuation");
  assert.throws(() => execution.outputs[Symbol.asyncIterator](), hasContractCode("concurrent_turn"));
  await finishInputTurn(turn);
  await assert.rejects(input.sendMessage(inputMessage("after-terminal")), hasContractCode("active_turn_mismatch"));
  assert.equal(native.sends.length, 2);
});

test("synchronous reservation holds two outstanding slots through acceptance and frees only settled ownership", async (t) => {
  const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  const first = turn.input.sendMessage(inputMessage("one"));
  const second = turn.input.sendMessage(inputMessage("two"));
  const third = turn.input.sendMessage(inputMessage("three"));
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["one", "two"]);
  await assert.rejects(third, hasContractCode("execution_input_capacity_exhausted"));
  turn.native.sends[0]!.accept();
  const receipt = accepted(await first);
  await assert.rejects(turn.input.sendMessage(inputMessage("three")), hasContractCode("execution_input_capacity_exhausted"));
  turn.native.sends[0]!.consume();
  assert.deepEqual(await receipt.settled, { status: "consumed", messageId: "one", turnId: "input-turn", placement: "original_native_command" });
  const admittedThird = turn.input.sendMessage(inputMessage("three"));
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["one", "two", "three"]);
  await consume(turn.native.sends[1]!, second);
  await consume(turn.native.sends[2]!, admittedThird);
  await finishInputTurn(turn);
});

function sizedMessage(id: string, byteSize: number): AgentExecutionInputMessage {
  const messageId = inputMessage(id).messageId;
  const parts = Array.from({ length: 18 }, () => ({ type: "text" as const, text: "" }));
  let remaining = byteSize - Buffer.byteLength(JSON.stringify({ messageId, parts }), "utf8");
  for (let index = 0; index < parts.length; index += 1) {
    const bytes = Math.floor(remaining / (parts.length - index));
    parts[index]!.text = "界".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
    remaining -= bytes;
  }
  assert.equal(Buffer.byteLength(JSON.stringify({ messageId, parts }), "utf8"), byteSize);
  return { messageId, parts };
}

test("retained canonical UTF-8 bytes accept exactly one MiB and reject excess before native entry", async (t) => {
  const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  await assert.rejects(turn.input.sendMessage(sizedMessage("over-limit", 1_048_577)), hasContractCode("execution_input_capacity_exhausted"));
  const pending = turn.input.sendMessage(sizedMessage("at-limit", 1_048_576));
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["at-limit"]);
  turn.native.sends[0]!.accept(); const receipt = accepted(await pending);
  await assert.rejects(turn.input.sendMessage(inputMessage("after-limit")), hasContractCode("execution_input_capacity_exhausted"));
  turn.native.sends[0]!.consume(); await receipt.settled;
  const next = turn.input.sendMessage(inputMessage("after-limit"));
  await consume(turn.native.sends[1]!, next);
  await finishInputTurn(turn);
});

test("definite native refusals retain IDs and each entered message counts toward the sixteen-message execution ceiling", async (t) => {
  const fixture = await executionInputFixture({ send: async ({ input }) => ({ status: "rejected", messageId: input.messageId, error: refusal }) });
  t.after(() => fixture.dispose());
  const session = await fixture.open();
  const turn = await fixture.enter(session);
  for (let index = 0; index < 16; index += 1) {
    assert.deepEqual(await turn.input.sendMessage(inputMessage(`refused:${index}`)), { status: "rejected", messageId: `refused:${index}`, error: refusal });
    if (index === 0) await assert.rejects(turn.input.sendMessage(inputMessage("refused:0")), hasContractCode("execution_input_identity_reused"));
  }
  await assert.rejects(turn.input.sendMessage(inputMessage("seventeenth")), hasContractCode("execution_input_capacity_exhausted"));
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), Array.from({ length: 16 }, (_, index) => `refused:${index}`));
  await finishInputTurn(turn);
  const next = await fixture.enter(session, "next-turn");
  await assert.rejects(next.input.sendMessage(inputMessage("refused:0")), hasContractCode("execution_input_identity_reused"));
  assert.deepEqual(await next.input.sendMessage(inputMessage("fresh-in-next-turn")), { status: "rejected", messageId: "fresh-in-next-turn", error: refusal });
  assert.deepEqual(next.native.sends.map((send) => send.input.messageId), ["fresh-in-next-turn"]);
  await finishInputTurn(next);
});

test("settled IDs survive execution retirement while resumed and branched sessions receive a fresh census", async (t) => {
  const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
  const source = await fixture.open();
  const first = await fixture.enter(source);
  const pending = first.input.sendMessage(inputMessage("retained"));
  await consume(first.native.sends[0]!, pending);
  await finishInputTurn(first);
  const second = await fixture.enter(source, "later-execution");
  await assert.rejects(first.input.sendMessage(inputMessage("stale-handle")), hasContractCode("active_turn_mismatch"));
  await assert.rejects(second.input.sendMessage(inputMessage("retained")), hasContractCode("execution_input_identity_reused"));
  assert.equal(second.native.sends.length, 0);
  await finishInputTurn(second);
  await source.close({ reason: "idle" });
  for (const opening of [fixture.resume, fixture.branch]) {
    const restored = await opening(source);
    const turn = await fixture.enter(restored);
    const next = turn.input.sendMessage(inputMessage("retained"));
    await consume(turn.native.sends[0]!, next);
    assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["retained"]);
    await finishInputTurn(turn);
  }
});

test("session count and UTF-8 identity ceilings initiate owned cleanup without entering the overflowing message", async (t) => {
  const cases = [
    { name: "4096 identities", count: 4_096, identity: (index: number) => `identity:${index}` },
    { name: "one MiB of UTF-8 IDs", count: 1_387, identity: (index: number) => `${String(index).padStart(6, "0")}${"界".repeat(250)}` },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const closeEntered = deferred<void>();
    const fixture = await executionInputFixture({
      send: async ({ input }) => ({ status: "rejected", messageId: input.messageId, error: refusal }),
      nativeClose: async () => { closeEntered.resolve(); },
    }); t.after(() => fixture.dispose());
    const session = await fixture.open();
    let turn = await fixture.enter(session, "census:0");
    for (let index = 0; index < scenario.count; index += 1) {
      if (index > 0 && index % 16 === 0) {
        await finishInputTurn(turn);
        turn = await fixture.enter(session, `census:${index / 16}`);
      }
      const message = inputMessage(scenario.identity(index));
      assert.deepEqual(await turn.input.sendMessage(message), { status: "rejected", messageId: message.messageId, error: refusal });
    }
    if (scenario.count % 16 === 0) {
      await finishInputTurn(turn);
      turn = await fixture.enter(session, "census:overflow");
    }
    await assert.rejects(turn.input.sendMessage(inputMessage(scenario.identity(scenario.count))), hasContractCode("execution_input_identity_limit_exceeded"));
    await closeEntered.promise;
    await session.close({ reason: "error" });
    assert.equal(fixture.turns.reduce((count, native) => count + native.sends.length, 0), scenario.count);
    assert.equal(fixture.closes(), 1);
    assert.throws(() => session.startTurn({ turnId: parseAgentTurnId("after-census-close"), interactionMode: "default", parts: [{ type: "text", text: "Cannot reopen retired authority." }] }), hasContractCode("session_closed"));
  });
});

test("terminal publication waits for admitted receipt and consumption while completion closes further admission", async (t) => {
  const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  const pending = turn.input.sendMessage(inputMessage("admitted-before-completion"));
  turn.native.emit({ ...turn.native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } });
  turn.native.end();
  let published = false;
  const terminal = turn.iterator.next().then((output) => { published = true; return output; });
  await turn.native.terminalRead.promise;
  await setImmediate();
  assert.equal(published, false);
  await assert.rejects(turn.input.sendMessage(inputMessage("completion-won")), hasContractCode("active_turn_mismatch"));
  turn.native.sends[0]!.accept();
  const receipt = accepted(await pending);
  await setImmediate();
  assert.equal(published, false, "Native acceptance alone cannot publish a successful terminal event.");
  turn.native.sends[0]!.consume("owned_native_continuation");
  assert.deepEqual(await receipt.settled, { status: "consumed", messageId: "admitted-before-completion", turnId: "input-turn", placement: "owned_native_continuation" });
  assert.deepEqual(await terminal, { done: false, value: createAgentEventOutput({ ...turn.native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } }) });
  assert.deepEqual(await turn.iterator.next(), { done: true, value: undefined });
  await assert.rejects(turn.input.sendMessage(inputMessage("after-completion")), hasContractCode("active_turn_mismatch"));
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["admitted-before-completion"]);
});

test("the original reader reaches normal provider exhaustion before accepted input and terminal publication settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let readers = 0;
  let normalExhaustions = 0;
  const fixture = await executionInputFixture({ outputs(source) {
    return { [Symbol.asyncIterator]() {
      readers += 1;
      return (async function* () {
        yield* source;
        normalExhaustions += 1;
        assert.ok(send); send.consume();
      })();
    } };
  } }); t.after(() => fixture.dispose());
  const session = await fixture.open();
  const turn = await fixture.enter(session);
  const pending = turn.input.sendMessage(inputMessage("consumed-in-epilogue"));
  const send = turn.native.sends[0]!; send.accept();
  const receipt = accepted(await pending);
  const terminalEvent = { ...turn.native.base, type: "turn.completed" as const,
    payload: { outcome: "completed" as const, structuredOutput: { kind: "not_requested" as const } } };
  turn.native.emit(terminalEvent); turn.native.end();
  const terminal = turn.iterator.next();
  void terminal.catch(() => {});
  await turn.native.terminalRead.promise; await setImmediate();
  t.mock.timers.tick(30_000);
  assert.deepEqual(await terminal, { done: false, value: createAgentEventOutput(terminalEvent) });
  assert.deepEqual(await receipt.settled, { status: "consumed", messageId: "consumed-in-epilogue",
    turnId: "input-turn", placement: "original_native_command" });
  assert.deepEqual(await turn.iterator.next(), { done: true, value: undefined });
  assert.deepEqual({ readers, normalExhaustions }, { readers: 1, normalExhaustions: 1 });
  const next = session.startTurn({ turnId: parseAgentTurnId("after-epilogue"), interactionMode: "default",
    parts: [{ type: "text", text: "The settled execution released its session slot." }] });
  assert.equal(next.turnId, "after-epilogue");
  assert.deepEqual(await next.outputs[Symbol.asyncIterator]().return?.(), { done: true, value: undefined });
  await session.close({ reason: "idle" });
  assert.deepEqual({ nativeTurns: fixture.turns.length, closes: fixture.closes() }, { nativeTurns: 1, closes: 1 });
});

test("pre-entry abort and unsupported input preserve original failures and leave the message identity available", async (t) => {
  const fixture = await executionInputFixture(); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  const controller = new AbortController();
  const reason = new Error("The caller withdrew this message before entry."); controller.abort(reason);
  await assert.rejects(turn.input.sendMessage({ ...inputMessage("reusable"), signal: controller.signal }), (error: unknown) => error === reason);
  const nonText: readonly AgentExecutionInputMessage[] = [
    { ...inputMessage("reusable"), parts: [{ type: "image", source: { type: "url", url: "https://example.com/image.png", mediaType: "image/png", byteSize: 4, widthPixels: 1, heightPixels: 1 } }] },
    { ...inputMessage("reusable"), parts: [{ type: "content_reference", environmentId: parseAgentEnvironmentId("input-environment"), environmentRevision: 1, contentCatalogRevision: 1, contentId: parseAgentEffectiveContentId("input-content"), contentRevision: 1 }] },
  ];
  for (const message of nonText) await assert.rejects(turn.input.sendMessage(message), /accepts text parts only/u);
  assert.equal(turn.native.sends.length, 0);
  const pending = turn.input.sendMessage(inputMessage("reusable"));
  await consume(turn.native.sends[0]!, pending);
  assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["reusable"]);
  await finishInputTurn(turn);
});

const approvalOption = parseAgentApprovalOptionId("allow-once");
const approvalRequestId = parseAgentRequestId("input-approval");
const approval: AgentRequest = {
  requestKind: "approval", requestId: approvalRequestId, prompt: "Allow the operation?",
  subject: { kind: "other", itemId: inputItemId, title: "Observed operation" },
  options: [{ optionId: approvalOption, label: "Allow once", decision: "approved",
    consequence: { kind: "scoped", persistence: "once", scope: { kind: "exact_action" } } }],
};
const approvalAnswer: AgentRequestResolution = { requestKind: "approval", requestId: approvalRequestId, disposition: "selected", optionId: approvalOption };

test("pending human authority and a claimed but unsettled answer both refuse input before native entry", async (t) => {
  const answerReceipt = deferred<AgentRequestResolutionResult>();
  const fixture = await executionInputFixture({ answer: () => answerReceipt.promise }); t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open());
  await event(turn, { ...turn.native.base, type: "item.started", payload: { itemId: inputItemId, itemKind: "assistant_message", status: "in_progress" } });
  await event(turn, { ...turn.native.base, type: "request.opened", payload: { request: approval } });
  await assert.rejects(turn.input.sendMessage(inputMessage("after-human-answer")), hasContractCode("request_pending"));
  const answer = turn.execution.resolveRequest({ resolution: approvalAnswer });
  await event(turn, { ...turn.native.base, type: "request.unavailable", payload: { requestId: approvalRequestId, reason: "withdrawn" } });
  await assert.rejects(turn.input.sendMessage(inputMessage("after-human-answer")), hasContractCode("request_pending"));
  assert.equal(turn.native.sends.length, 0);
  answerReceipt.resolve({ status: "delivered" }); assert.deepEqual(await answer, { status: "delivered" });
  const pending = turn.input.sendMessage(inputMessage("after-human-answer"));
  await consume(turn.native.sends[0]!, pending);
  assert.deepEqual(turn.native.answers.map((answer) => answer.resolution), [approvalAnswer]);
  await event(turn, { ...turn.native.base, type: "item.completed", payload: { itemId: inputItemId, itemKind: "assistant_message", status: "completed" } });
  await finishInputTurn(turn);
});

test("interruption closes new admission while preserving authoritative settlement after native acceptance or refusal", async (t) => {
  for (const status of ["accepted", "failed"] as const) await t.test(status, async (t) => {
    const interruptReceipt = deferred<AgentProviderTurnInterruptionResult>();
    const fixture = await executionInputFixture({ interruption: { kind: "supported", interruptTurn: () => interruptReceipt.promise } });
    t.after(() => fixture.dispose());
    const session = await fixture.open(); const turn = await fixture.enter(session);
    const pending = turn.input.sendMessage(inputMessage("before-interruption"));
    turn.native.sends[0]!.accept(); const receipt = accepted(await pending);
    let observed = false;
    void receipt.settled.then(() => { observed = true; });
    if (session.interruption.kind !== "supported") throw new Error("Expected interruption support.");
    const interruption = session.interruption.interruptTurn({ turnId: turn.execution.turnId, reason: "user_requested" });
    await assert.rejects(turn.input.sendMessage(inputMessage("during-interruption")), hasContractCode("active_turn_mismatch"));
    await setImmediate(); assert.equal(observed, false);
    const nativeReceipt = status === "accepted" ? { status } : { status, error: refusal };
    interruptReceipt.resolve(nativeReceipt); assert.deepEqual(await interruption, nativeReceipt);
    await assert.rejects(turn.input.sendMessage(inputMessage("after-interruption")), hasContractCode("active_turn_mismatch"));
    assert.equal(observed, false);
    const outcome = status === "accepted"
      ? { status: "unconfirmed" as const, messageId: inputMessage("before-interruption").messageId, reason: "interrupted" as const }
      : { status: "consumed" as const, messageId: inputMessage("before-interruption").messageId, turnId: turn.execution.turnId, placement: "original_native_command" as const };
    turn.native.sends[0]!.settlement.resolve(outcome);
    assert.deepEqual(await receipt.settled, outcome);
    await finishInputTurn(turn);
    assert.deepEqual(await receipt.settled, outcome);
    assert.deepEqual(turn.native.sends.map((send) => send.input.messageId), ["before-interruption"]);
  });
});

test("session human authority blocks input until native response and terminal settle, while app callback retention adds no extra block", async (t) => {
  const appRelease = deferred<void>(); const appEntered = deferred<AgentSessionInteraction>();
  const nativeReceipt = deferred<AgentRequestResolutionResult>();
  const fixture = await executionInputFixture({ transformAdapter: (adapter) => ({ ...adapter, sessionInteractions: interactionSupport }) });
  t.after(() => fixture.dispose());
  const session = await fixture.open({ interactions: { async onRequest(interaction) { appEntered.resolve(interaction); await appRelease.promise; } } });
  const turn = await fixture.enter(session);
  const context = fixture.contexts[0]!; assert.ok(context.interactions);
  const offer = nativeOffer(context, { respond: () => nativeReceipt.promise });
  const publication = Promise.resolve(context.interactions.onRequest(offer.handle));
  const interaction = await appEntered.promise;
  await assert.rejects(turn.input.sendMessage(inputMessage("after-session-human")), hasContractCode("request_pending"));
  const response = interaction.respond({ kind: "decision", choiceId: grant }); await offer.entered;
  offer.settle({ kind: "answered", response: { kind: "decision", choiceId: grant } });
  await assert.rejects(turn.input.sendMessage(inputMessage("after-session-human")), hasContractCode("request_pending"));
  assert.equal(turn.native.sends.length, 0);
  nativeReceipt.resolve({ status: "delivered" }); assert.deepEqual(await response, { status: "delivered" });
  assert.deepEqual(await interaction.terminal, { kind: "answered", response: { kind: "decision", choiceId: grant } });
  const pending = turn.input.sendMessage(inputMessage("after-session-human"));
  await consume(turn.native.sends[0]!, pending);
  assert.deepEqual(offer.answers, ["trust-workspace"]);
  appRelease.resolve(); await publication;
  await finishInputTurn(turn);
});

test("effective turn and session output schemas both reject execution input before native message entry", async (t) => {
  const output = { kind: "json_schema" as const, schema: parseAgentOutputSchema({ type: "object", properties: {}, required: [], additionalProperties: false }) };
  for (const scope of ["turn", "session"] as const) await t.test(scope, async (t) => {
    const defaults = createFakeAgentProvider().capabilities;
    const capabilities = parseAgentCapabilities({ ...defaults, turns: { ...defaults.turns, structuredOutput: {
      kind: "supported", mechanism: "native", scope, schemaProfile: "agenai.output-schema.v1", maxSchemaBytes: 16_384, maxOutputBytes: 16_384, resume: false, branch: false,
    } } });
    const fixture = await executionInputFixture({ capabilities }); t.after(() => fixture.dispose());
    const session = await fixture.open(scope === "session" ? { output } : {});
    const turn = await fixture.enter(session, "input-turn", scope === "turn" ? { output } : {});
    await assert.rejects(turn.input.sendMessage(inputMessage("cannot-change-schema-task")), hasContractCode("structured_output_unsupported"));
    assert.equal(turn.native.sends.length, 0);
    await finishInputTurn(turn, true);
  });
});

test("optional input absence preserves the ordinary execution path", async (t) => {
  const fixture = await executionInputFixture({ support: null }); t.after(() => fixture.dispose());
  const session = await fixture.open();
  const execution = session.startTurn({ turnId: parseAgentTurnId("ordinary"), interactionMode: "default", parts: [{ type: "text", text: "Complete the original task." }] });
  assert.equal(execution.input, undefined);
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const started = await iterator.next();
  const native = fixture.turns[0]!;
  assert.deepEqual(started, { done: false, value: createAgentEventOutput({ ...native.base, type: "turn.started", payload: {} }) });
  native.emit({ ...native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } }); native.end();
  assert.deepEqual(await iterator.next(), { done: false, value: createAgentEventOutput({ ...native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } }) });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.equal(native.sends.length, 0);
});

test("prepared native continuations expose input as unsupported while their raw candidates still require exact declared ports", async (t) => {
  for (const candidatePort of ["matching", "missing", "drifted"] as const) await t.test(candidatePort, async (t) => {
    const fixture = await executionInputFixture({ transformAdapter: (adapter) => ({ ...adapter,
      sessionInteractions: { kind: "supported", mappings: [{ openingOperation: "create", requestKind: "plan_review" }], producerOwnership: "exclusive", humanWait: ["bounded"] },
      nativeContinuations: { kind: "supported", mappings: [{ openingOperation: "create", requestKind: "plan_review", timing: "after_open_return" }], producerOwnership: "exclusive" },
    }) }); t.after(() => fixture.dispose());
    const presented = deferred<AgentSessionInteraction>();
    const drained = deferred<void>();
    const nativeOutcome = deferred<AgentNativeContinuationOutcome>();
    const terminal = deferred<AgentSessionInteractionTerminal>();
    const controller = new AbortController();
    const outputs: string[] = [];
    let continuation: AgentNativeContinuation | undefined;
    let native: ReturnType<typeof nativeInputTurn> | undefined;
    let dispatches = 0; let cancels = 0;
    await fixture.open({
      interactions: { onRequest(interaction) { presented.resolve(interaction); } },
      nativeContinuations: { async onExecution(value) {
        continuation = value;
        assert.deepEqual(value.execution.input, { kind: "unsupported" });
        for await (const output of value.execution.outputs) {
          assert.deepEqual(value.execution.input, { kind: "unsupported" });
          outputs.push(output.kind === "event" ? output.event.type : output.kind);
        }
        drained.resolve();
      } },
    });
    const context = fixture.contexts[0]!; assert.ok(context.interactions);
    const request = parseAgentSessionPlanReviewRequest({ kind: "plan_review", requestId: "input-native-review", sessionId: context.sessionId,
      title: "Review native work", plan: { planId: "input-native-plan", revision: "revision-one", title: "Native plan", content: { kind: "text", format: "markdown", text: "Perform the reviewed native work." } },
      choices: [{ choiceId: "approve", action: "approve", label: "Approve" }] });
    const candidate: AgentProviderPreparedSessionInteraction = {
      kind: "prepared", request, signal: controller.signal, terminal: terminal.promise,
      prepareResponse() {
        return {
          kind: "native_continuation", outcome: nativeOutcome.promise,
          createExecution({ turnId, signal }) {
            const support = candidatePort === "missing" ? null : candidatePort === "drifted"
              ? { ...inputSupport, limits: { ...inputSupport.limits, maxOutstandingMessages: 1 } } : inputSupport;
            native = nativeInputTurn(context, { turnId, signal, interactionMode: "default", parts: [{ type: "text", text: "Native continuation." }] }, { support });
            return native.execution;
          },
          async dispatch() {
            dispatches += 1; nativeOutcome.resolve({ kind: "started" });
            assert.ok(native);
            native.emit({ ...native.base, type: "turn.completed", payload: { outcome: "completed", structuredOutput: { kind: "not_requested" } } }); native.end();
            terminal.resolve({ kind: "answered", response: { kind: "plan_review", action: "approve", choiceId: request.choices[0]!.choiceId, planId: request.plan.planId, revision: request.plan.revision } });
            return { status: "delivered" };
          },
          async cancel() {
            cancels += 1; nativeOutcome.resolve({ kind: "not_started" });
            native?.close(); controller.abort(); terminal.resolve({ kind: "withdrawn" });
          },
        };
      },
    };
    const publication = Promise.resolve(context.interactions.onRequest(candidate));
    const interaction = await presented.promise;
    if (candidatePort === "matching") {
      assert.deepEqual(await interaction.respond(approve(request)), { status: "delivered" });
      await drained.promise;
      assert.ok(continuation); assert.deepEqual(await continuation.outcome, { kind: "started" });
      assert.deepEqual(outputs, ["turn.started", "turn.completed"]);
      assert.deepEqual([dispatches, cancels, native?.sends.length], [1, 0, 0]);
    } else {
      await assert.rejects(interaction.respond(approve(request)), hasContractCode("capability_port_mismatch"));
      assert.deepEqual([dispatches, cancels, outputs], [0, 1, []]);
      assert.equal(continuation, undefined);
    }
    await publication;
  });
});
