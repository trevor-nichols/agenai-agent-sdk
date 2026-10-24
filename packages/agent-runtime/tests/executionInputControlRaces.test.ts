import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import {
  parseAgentSessionFormRequest,
  parseAgentSessionPlanReviewRequest,
  parseAgentSessionResponse,
  type AgentSessionRequest,
} from "@agen-ai/agent-protocol";

import {
  type AgentExecutionInputReceipt,
  type AgentProviderSessionContext,
  type AgentProviderTurnInterruptionResult,
  type AgentRequestResolutionResult,
  type AgentSessionInteraction,
} from "../src/index.js";
import {
  acceptedInputReceipt,
  executionInputFixture,
  finishInputTurn,
  inputMessage,
  inputRefusal,
} from "./fixtures/executionInput.js";
import {
  deferred,
  hasContractCode,
  invoke,
  makeBinding,
  supportedBinding,
} from "./fixtures/hostBindings/harness.js";
import { nativeOffer } from "./fixtures/sessionInteractions.js";

test("interruption settles before an entered input receipt without replacing its native delivery evidence", { timeout: 5_000 }, async (t) => {
  for (const interruptStatus of ["accepted", "failed"] as const) {
    for (const inputStatus of ["accepted", "rejected"] as const) await t.test(`${interruptStatus}/${inputStatus}`, async (t) => {
      const interruptReceipt = deferred<AgentProviderTurnInterruptionResult>();
      const fixture = await executionInputFixture({ interruption: {
        kind: "supported", interruptTurn: () => interruptReceipt.promise,
      } });
      t.after(async () => {
        interruptReceipt.resolve({ status: "failed", error: inputRefusal });
        await fixture.dispose();
      });
      const session = await fixture.open();
      const turn = await fixture.enter(session);
      const sending = turn.input.sendMessage(inputMessage("entered-before-interrupt"));
      const send = turn.native.sends[0]!;
      assert.equal(session.interruption.kind, "supported");
      if (session.interruption.kind !== "supported") throw new Error("Expected interruption support.");
      const interrupting = session.interruption.interruptTurn({ turnId: turn.execution.turnId, reason: "user_requested" });
      const nativeInterrupt = interruptStatus === "accepted"
        ? { status: interruptStatus } : { status: interruptStatus, error: inputRefusal };
      interruptReceipt.resolve(nativeInterrupt);
      assert.deepEqual(await interrupting, nativeInterrupt);
      await assert.rejects(turn.input.sendMessage(inputMessage("after-interrupt")), hasContractCode("active_turn_mismatch"));
      assert.equal(send.input.signal?.aborted, false, "An interrupt request must preserve the entered send's receipt owner.");

      if (inputStatus === "accepted") {
        send.accept();
        const receipt = acceptedInputReceipt(await sending);
        const outcome = interruptStatus === "accepted"
          ? { status: "unconfirmed" as const, messageId: send.input.messageId, reason: "interrupted" as const }
          : { status: "consumed" as const, messageId: send.input.messageId, turnId: turn.execution.turnId,
            placement: "original_native_command" as const };
        send.settlement.resolve(outcome);
        assert.deepEqual(await receipt.settled, outcome);
      } else {
        send.receipt.resolve({ status: "rejected", messageId: send.input.messageId, error: inputRefusal });
        assert.deepEqual(await sending, { status: "rejected", messageId: "entered-before-interrupt", error: inputRefusal });
      }
      await finishInputTurn(turn);
      assert.deepEqual(turn.native.sends.map((entry) => entry.input.messageId), ["entered-before-interrupt"]);
      assert.equal(fixture.turns.length, 1);
    });
  }
});

function humanRequest(context: AgentProviderSessionContext, kind: "form" | "plan_review"): AgentSessionRequest {
  if (kind === "form") return parseAgentSessionFormRequest({
    kind, sessionId: context.sessionId, requestId: "input-race-form", title: "Delivery details",
    fields: [{ kind: "text", fieldId: "address", label: "Address", required: true,
      sensitivity: "sensitive", multiline: false, maxLength: 100 }],
    choices: [{ action: "submit", choiceId: "submit", label: "Send details" },
      { action: "cancel", choiceId: "cancel", label: "Cancel" }],
  });
  return parseAgentSessionPlanReviewRequest({
    kind, sessionId: context.sessionId, requestId: "input-race-review", title: "Review the work",
    plan: { planId: "input-race-plan", revision: "revision-one", title: "Reviewed work",
      content: { kind: "text", format: "markdown", text: "Inspect the approved file." } },
    choices: [{ action: "approve", choiceId: "approve", label: "Approve" },
      { action: "abandon", choiceId: "abandon", label: "Abandon" }],
  });
}

test("forms and plan reviews opening after input entry retain independent answer and admission ownership", { timeout: 5_000 }, async (t) => {
  for (const kind of ["form", "plan_review"] as const) await t.test(kind, async (t) => {
    const presented = deferred<AgentSessionInteraction>();
    const responseReceipt = deferred<AgentRequestResolutionResult>();
    const fixture = await executionInputFixture({ transformAdapter: (adapter) => ({
      ...adapter, sessionInteractions: { kind: "supported", producerOwnership: "exclusive", humanWait: ["bounded"],
        mappings: [{ openingOperation: "create", requestKind: kind }] },
    }) });
    let offer: ReturnType<typeof nativeOffer> | undefined = undefined;
    t.after(async () => {
      responseReceipt.resolve({ status: "delivered" });
      try { await offer?.stop(); }
      finally { await fixture.dispose(); }
    });
    const session = await fixture.open({ interactions: { onRequest: (interaction) => { presented.resolve(interaction); } } });
    const turn = await fixture.enter(session);
    const sending = turn.input.sendMessage(inputMessage("before-human-opening"));
    const context = fixture.contexts[0]!;
    assert.ok(context.interactions);
    offer = nativeOffer(context, { request: (value) => humanRequest(value, kind), respond: () => responseReceipt.promise });
    const publication = Promise.resolve(context.interactions.onRequest(offer.handle));
    const interaction = await presented.promise;
    await assert.rejects(turn.input.sendMessage(inputMessage("after-human-answer")), hasContractCode("request_pending"));
    turn.native.sends[0]!.accept();
    const receipt = acceptedInputReceipt(await sending);
    turn.native.sends[0]!.consume();
    assert.deepEqual(await receipt.settled, { status: "consumed", messageId: "before-human-opening",
      turnId: "input-turn", placement: "original_native_command" });
    assert.deepEqual(offer.responses, [], "Consumption cannot answer the independently opened human request.");
    await assert.rejects(turn.input.sendMessage(inputMessage("after-human-answer")), hasContractCode("request_pending"));

    const response = parseAgentSessionResponse(kind === "form"
      ? { kind, action: "submit", choiceId: "submit", answers: [{ kind: "text", fieldId: "address", value: "42 Example Street" }] }
      : { kind, action: "approve", choiceId: "approve", planId: "input-race-plan", revision: "revision-one" });
    const answering = interaction.respond(response);
    await offer.entered;
    await assert.rejects(turn.input.sendMessage(inputMessage("after-human-answer")), hasContractCode("request_pending"));
    assert.deepEqual(turn.native.sends.map((entry) => entry.input.messageId), ["before-human-opening"]);
    responseReceipt.resolve({ status: "delivered" });
    assert.deepEqual(await answering, { status: "delivered" });
    assert.deepEqual(offer.responses, [response]);
    assert.deepEqual(await interaction.terminal, { kind: "answered", response: kind === "form"
      ? { kind, action: "submit", choiceId: "submit" }
      : { kind, action: "approve", choiceId: "approve", planId: "input-race-plan", revision: "revision-one" } });
    await publication;
    const next = turn.input.sendMessage(inputMessage("after-human-answer"));
    turn.native.sends[1]!.accept();
    const nextReceipt = acceptedInputReceipt(await next);
    turn.native.sends[1]!.consume();
    assert.deepEqual(await nextReceipt.settled, { status: "consumed", messageId: "after-human-answer",
      turnId: "input-turn", placement: "original_native_command" });
    await finishInputTurn(turn);
    assert.equal(fixture.turns.length, 1);
    assert.deepEqual(turn.native.answers, [], "Session responses must retain their direct response port.");
  });
});

test("reader abandonment retains input and an entered host callback until native close and callback drain", { timeout: 5_000 }, async (t) => {
  for (const receiptState of ["entered", "accepted"] as const) await t.test(receiptState, async (t) => {
    const callbackEntered = deferred<void>();
    const releaseCallback = deferred<void>();
    const closeEntered = deferred<void>();
    const releaseClose = deferred<void>();
    const host = makeBinding({ async invoke() {
      callbackEntered.resolve();
      await releaseCallback.promise;
      return { kind: "success", value: "host inspection completed" };
    } });
    const fixture = await executionInputFixture({
      transformAdapter: (adapter) => ({ ...adapter, hostBinding: supportedBinding }),
      async nativeClose() { closeEntered.resolve(); await releaseClose.promise; },
    });
    t.after(async () => { releaseClose.resolve(); releaseCallback.resolve(); await fixture.dispose(); });
    const session = await fixture.open({ hostBinding: host.binding });
    const turn = await fixture.enter(session);
    const facade = fixture.contexts[0]!.hostBinding;
    assert.ok(facade);
    const callback = invoke(facade);
    await callbackEntered.promise;
    const sending = turn.input.sendMessage(inputMessage("during-host-callback"));
    assert.deepEqual(turn.native.sends.map((entry) => entry.input.parts), [[{ type: "text", text: "Use the corrected requirement." }]]);
    let accepted: Extract<AgentExecutionInputReceipt, { status: "accepted" }> | undefined;
    if (receiptState === "accepted") {
      turn.native.sends[0]!.accept();
      accepted = acceptedInputReceipt(await sending);
    }
    const pendingOutput = turn.iterator.next();
    const canceledOutput = assert.rejects(pendingOutput, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    let returned = false;
    const returning = turn.iterator.return!().then((value) => { returned = true; return value; });
    await closeEntered.promise;
    await canceledOutput;
    assert.deepEqual([host.invocations[0]!.signal?.aborted, turn.native.sends[0]!.input.signal?.aborted], [true, true]);
    await assert.rejects(turn.input.sendMessage(inputMessage("after-reader-return")), hasContractCode("session_unusable"));
    await assert.rejects(invoke(facade, { invocationId: "late-callback" }), hasContractCode("host_binding_closed"));
    if (accepted) {
      assert.deepEqual(await accepted.settled, { status: "unconfirmed", messageId: "during-host-callback", reason: "closed" });
    } else {
      const receipt = await sending;
      assert.equal(receipt.status, "delivery_uncertain");
      if (receipt.status !== "delivery_uncertain") throw new Error("Reader return must not claim an unobserved receipt.");
      assert.deepEqual({ messageId: receipt.messageId, code: receipt.error.code },
        { messageId: "during-host-callback", code: "execution_input_delivery_uncertain" });
      turn.native.sends[0]!.accept();
    }
    turn.native.sends[0]!.consume("owned_native_continuation");
    releaseClose.resolve();
    await setImmediate();
    assert.deepEqual([returned, host.releaseCount()], [false, 0], "Reader return must keep the entered callback's binding leased.");
    releaseCallback.resolve();
    assert.deepEqual(await callback, { kind: "success", value: "host inspection completed" });
    assert.deepEqual(await returning, { done: true, value: undefined });
    assert.deepEqual(await turn.iterator.return!(), { done: true, value: undefined });
    await session.close({ reason: "shutdown" });
    assert.deepEqual({ nativeCloses: fixture.closes(), hostReleases: host.releaseCount(), nativeTurns: fixture.turns.length },
      { nativeCloses: 1, hostReleases: 1, nativeTurns: 1 });
    if (accepted) assert.deepEqual(await accepted.settled, { status: "unconfirmed", messageId: "during-host-callback", reason: "closed" });
  });
});

test("execution messages cannot replace the schema, tools, permissions or source authority", async (t) => {
  const host = makeBinding();
  const fixture = await executionInputFixture({ transformAdapter: (adapter) => ({ ...adapter, hostBinding: supportedBinding }) });
  t.after(() => fixture.dispose());
  const turn = await fixture.enter(await fixture.open({ hostBinding: host.binding }));
  for (const extra of [
    { output: { kind: "json_schema", schema: { type: "object" } } },
    { tools: [{ name: "Write", inputSchema: { type: "object" } }] },
    { permissions: { mode: "allow_all" } },
    { hostBinding: { bindingId: "replacement-binding" } },
    { workingDirectory: "/different/source" },
    { configuration: { kind: "selected", selections: [] } },
  ]) await assert.rejects(turn.input.sendMessage(Object.assign(inputMessage("same-valid-identity"), extra)),
    { name: "TypeError", message: "Invalid execution-input message envelope." });
  const sending = turn.input.sendMessage(inputMessage("same-valid-identity", "Use Write only if the host already authorized it."));
  turn.native.sends[0]!.accept();
  const receipt = acceptedInputReceipt(await sending);
  turn.native.sends[0]!.consume();
  assert.deepEqual(await receipt.settled, { status: "consumed", messageId: "same-valid-identity",
    turnId: "input-turn", placement: "original_native_command" });
  const facade = fixture.contexts[0]!.hostBinding;
  assert.ok(facade);
  await assert.rejects(invoke(facade, { toolName: "Write" }), hasContractCode("host_tool_input_invalid"));
  assert.deepEqual(await invoke(facade), { kind: "success", value: { accepted: true } });
  assert.deepEqual(host.invocations.map((entry) => ({ toolName: entry.toolName, arguments: entry.arguments })),
    [{ toolName: "Inspect", arguments: {} }]);
  assert.deepEqual(turn.native.sends.map((entry) => ({ messageId: entry.input.messageId, parts: entry.input.parts })),
    [{ messageId: "same-valid-identity", parts: [{ type: "text", text: "Use Write only if the host already authorized it." }] }]);
  assert.equal(fixture.contexts[0]!.workingDirectory, "/fixture/workspace");
  await finishInputTurn(turn);
});
