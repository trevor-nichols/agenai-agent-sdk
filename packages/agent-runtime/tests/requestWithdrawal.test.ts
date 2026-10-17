import assert from "node:assert/strict";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import test from "node:test";
import {
  parseAgentApprovalOptionId, parseAgentIsoDateTime, parseAgentItemId, parseAgentRequestId, parseAgentTurnId,
  type AgentError, type AgentEvent, type AgentRequest, type AgentRequestResolution,
} from "@agen-ai/agent-protocol";
import {
  createAgentEventOutput, type AgentProviderOutput, type AgentProviderResolveRequestInput,
  type AgentProviderSession, type AgentRequestResolutionResult,
} from "../src/index.js";
import { createHarness, deferred, hasContractCode } from "./fixtures/hostBindings/harness.js";

const turnId = parseAgentTurnId("withdrawal-turn");
const itemId = parseAgentItemId("withdrawal-item");
const optionId = parseAgentApprovalOptionId("allow-once");
const refusal: AgentError = { category: "permission", code: "native_refusal", message: "The native callback refused the answer.", recovery: { kind: "none" } };
const turnInput = { turnId, interactionMode: "default" as const, parts: [{ type: "text" as const, text: "Observe request ownership." }] };
const approval = (id: string): AgentRequest => ({ requestKind: "approval", requestId: parseAgentRequestId(id), prompt: "Allow this operation?",
  subject: { kind: "other", itemId, title: "Observed operation" },
  options: [{ optionId, label: "Allow once", decision: "approved", consequence: { kind: "scoped", persistence: "once", scope: { kind: "exact_action" } } }] });
const answer = (id: string): AgentRequestResolution => ({ requestKind: "approval", requestId: parseAgentRequestId(id), disposition: "selected", optionId });

async function scenario(options: {
  answer?: (input: AgentProviderResolveRequestInput) => Promise<AgentRequestResolutionResult>;
  interruption?: AgentProviderSession["interruption"];
  close?: (attempt: number) => void;
} = {}) {
  let controller: ReadableStreamDefaultController<AgentProviderOutput> | undefined;
  let ended = true;
  let starts = 0;
  let closes = 0;
  const closed = deferred<void>();
  const answers: AgentRequestResolution[] = [];
  const harness = await createHarness({ transformSession(native) {
    return { ...native,
      startTurn(input) {
        starts += 1;
        ended = false;
        const outputs = new ReadableStream<AgentProviderOutput>({ start(value) { controller = value; } });
        return { turnId: input.turnId, outputs, async resolveRequest(input) {
          answers.push(input.resolution);
          const receipt = options.answer?.(input) ?? Promise.resolve({ status: "delivered" as const });
          return Promise.race([receipt, closed.promise.then((): never => { throw new DOMException("Native owner closed.", "AbortError"); })]);
        } };
      },
      ...(options.interruption === undefined ? {} : { interruption: options.interruption }),
      async close(input) {
        closes += 1;
        options.close?.(closes);
        closed.resolve();
        if (!ended) { ended = true; controller?.close(); }
        await native.close(input);
      },
    };
  } });
  const session = await harness.open("create");
  const context = harness.contexts[0];
  assert.ok(context);
  const base = { protocolVersion: 12 as const, sessionId: context.sessionId, turnId,
    occurredAt: parseAgentIsoDateTime("2026-10-16T00:00:00.000Z") };
  const execution = session.startTurn(turnInput);
  const iterator = execution.outputs[Symbol.asyncIterator]();
  function emit(event: AgentEvent) { assert.ok(controller); controller.enqueue(createAgentEventOutput(event)); }
  async function next(event: AgentEvent) {
    const pull = iterator.next(); emit(event);
    const output = await pull;
    assert.equal(output.done, false);
    if (output.done || output.value.kind !== "event") throw new Error("Expected the emitted canonical event.");
    assert.deepEqual(output.value.event, event);
    return output.value.event;
  }
  async function finish() {
    await next({ ...base, type: "item.completed", payload: { itemId, itemKind: "assistant_message", status: "completed" } });
    await next({ ...base, type: "turn.completed", payload: { outcome: "completed" } });
    ended = true; controller!.close();
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  }
  await next({ ...base, type: "turn.started", payload: {} });
  await next({ ...base, type: "item.started", payload: { itemId, itemKind: "assistant_message", status: "in_progress" } });
  return { session, execution, iterator, next, emit, base, answers, finish, starts: () => starts, closes: () => closes,
    open: (id: string) => next({ ...base, type: "request.opened", payload: { request: approval(id) } }),
    withdraw: (id: string) => next({ ...base, type: "request.unavailable", payload: { requestId: parseAgentRequestId(id), reason: "withdrawn" } }),
    async dispose() { await session.close({ reason: "idle" }); await harness.registry.dispose(); },
  };
}

test("SDK04: withdrawal removes only A while B is answered once on the original continuous execution", async (t) => {
  const fixture = await scenario(); t.after(() => fixture.dispose());
  await fixture.open("A");
  await fixture.next({ ...fixture.base, type: "content.delta", payload: { itemId, streamKind: "assistant_text", delta: "Output continues while A waits." } });
  await fixture.withdraw("A");
  await assert.rejects(fixture.execution.resolveRequest({ resolution: answer("A") }), hasContractCode("request_resolution_mismatch"));
  await fixture.open("B");
  const reading = fixture.iterator.next();
  assert.deepEqual(await fixture.execution.resolveRequest({ resolution: answer("B") }), { status: "delivered" });
  fixture.emit({ ...fixture.base, type: "content.delta", payload: { itemId, streamKind: "assistant_text", delta: "B was accepted." } });
  const observed = await reading;
  assert.equal(!observed.done && observed.value.kind === "event" && observed.value.event.type === "content.delta" ? observed.value.event.payload.delta : null, "B was accepted.");
  assert.deepEqual(fixture.answers, [answer("B")]);
  assert.equal(fixture.starts(), 1);
  assert.throws(() => fixture.execution.outputs[Symbol.asyncIterator](), hasContractCode("concurrent_turn"));
  await fixture.finish();
});

test("A retirement preserves each entered A receipt and never changes the surviving B request", async (t) => {
  const receipts: readonly AgentRequestResolutionResult[] = [
    { status: "delivered" }, { status: "rejected", requestState: "pending", error: refusal },
    { status: "rejected", requestState: "unavailable", error: refusal }, { status: "delivery_uncertain", error: refusal },
  ];
  for (const receipt of receipts) await t.test(`${receipt.status}${receipt.status === "rejected" ? `/${receipt.requestState}` : ""}`, async (t) => {
    const nativeReceipt = deferred<AgentRequestResolutionResult>();
    const entered = deferred<void>();
    const fixture = await scenario({ answer: async (input) => {
      if (input.resolution.requestId === "A") { entered.resolve(); return nativeReceipt.promise; }
      return { status: "delivered" };
    } }); t.after(() => fixture.dispose());
    await fixture.open("A");
    const answering = fixture.execution.resolveRequest({ resolution: answer("A") });
    await entered.promise;
    await fixture.withdraw("A");
    await fixture.open("B");
    nativeReceipt.resolve(receipt);
    assert.deepEqual(await answering, receipt);
    if (receipt.status === "delivery_uncertain") {
      await assert.rejects(fixture.execution.resolveRequest({ resolution: answer("B") }), hasContractCode("session_unusable"));
      await fixture.withdraw("B");
      assert.deepEqual(fixture.answers, [answer("A")]);
    } else {
      await assert.rejects(fixture.execution.resolveRequest({ resolution: answer("A") }), hasContractCode("request_resolution_mismatch"));
      assert.deepEqual(await fixture.execution.resolveRequest({ resolution: answer("B") }), { status: "delivered" });
      assert.deepEqual(fixture.answers, [answer("A"), answer("B")]);
    }
    await fixture.finish();
  });
});

test("canonical retirement can follow a native unavailable receipt but cannot be repeated or target another execution", async (t) => {
  for (const violation of ["duplicate", "foreign", "reuse"] as const) await t.test(violation, async (t) => {
    const fixture = await scenario({ answer: async () => ({ status: "rejected", requestState: "unavailable", error: refusal }) });
    t.after(() => fixture.dispose());
    await fixture.open("A");
    assert.deepEqual(await fixture.execution.resolveRequest({ resolution: answer("A") }), { status: "rejected", requestState: "unavailable", error: refusal });
    await fixture.withdraw("A");
    const failed = violation === "reuse" ? fixture.open("A") : fixture.withdraw(violation === "foreign" ? "never-opened" : "A");
    await assert.rejects(failed, hasContractCode("invalid_turn_sequence"));
    assert.deepEqual(fixture.answers, [answer("A")]);
    assert.throws(() => fixture.session.startTurn(turnInput), hasContractCode("session_unusable"));
  });
});

test("withdrawal wins over failed interruption and a late pending refusal in either settlement order", async (t) => {
  for (const order of ["answer first", "interruption first"] as const) await t.test(order, async (t) => {
    const nativeReceipt = deferred<AgentRequestResolutionResult>();
    const interrupted = deferred<{ status: "failed"; error: AgentError }>();
    const entered = deferred<void>();
    const fixture = await scenario({ answer: async (input) => {
      if (input.resolution.requestId === "A") { entered.resolve(); return nativeReceipt.promise; }
      return { status: "delivered" };
    }, interruption: { kind: "supported", interruptTurn: () => interrupted.promise } });
    t.after(() => fixture.dispose());
    await fixture.open("A");
    const answering = fixture.execution.resolveRequest({ resolution: answer("A") });
    await entered.promise;
    assert.equal(fixture.session.interruption.kind, "supported");
    if (fixture.session.interruption.kind !== "supported") throw new Error("Missing fixture interruption port.");
    const interruption = fixture.session.interruption.interruptTurn({ turnId, reason: "user_requested" });
    await fixture.withdraw("A");
    await fixture.open("B");
    const pending = { status: "rejected", requestState: "pending", error: refusal } as const;
    const failed = { status: "failed", error: refusal } as const;
    if (order === "answer first") {
      nativeReceipt.resolve(pending); assert.deepEqual(await answering, pending);
      interrupted.resolve(failed); assert.deepEqual(await interruption, failed);
    } else {
      interrupted.resolve(failed); assert.deepEqual(await interruption, failed);
      nativeReceipt.resolve(pending); assert.deepEqual(await answering, pending);
    }
    await assert.rejects(fixture.execution.resolveRequest({ resolution: answer("A") }), hasContractCode("request_resolution_mismatch"));
    assert.deepEqual(await fixture.execution.resolveRequest({ resolution: answer("B") }), { status: "delivered" });
    assert.deepEqual(fixture.answers, [answer("A"), answer("B")]);
    await fixture.finish();
  });
});

test("request identity exhaustion fails the incoming request and initiates native cleanup without presenting it", async (t) => {
  const fixture = await scenario(); t.after(() => fixture.dispose());
  for (let index = 0; index < 4_096; index += 1) {
    await fixture.open(`request-${index}`);
    await fixture.withdraw(`request-${index}`);
  }
  await assert.rejects(fixture.open("request-overflow"), hasContractCode("request_identity_limit_exceeded"));
  await fixture.session.close({ reason: "error" });
  assert.deepEqual([fixture.starts(), fixture.closes(), fixture.answers], [1, 1, []]);
  assert.throws(() => fixture.session.startTurn(turnInput), hasContractCode("session_closed"));
});

test("withdrawal during overlapping interruptions prevents restoration after both refusals", async (t) => {
  const interruptions = [deferred<{ status: "failed"; error: AgentError }>(), deferred<{ status: "failed"; error: AgentError }>()];
  let entered = 0;
  const fixture = await scenario({ interruption: { kind: "supported", interruptTurn: () => interruptions[entered++]!.promise } });
  t.after(() => fixture.dispose());
  await fixture.open("A");
  assert.equal(fixture.session.interruption.kind, "supported");
  if (fixture.session.interruption.kind !== "supported") throw new Error("Missing interruption fixture.");
  const first = fixture.session.interruption.interruptTurn({ turnId, reason: "user_requested" });
  const second = fixture.session.interruption.interruptTurn({ turnId, reason: "user_requested" });
  await fixture.withdraw("A");
  await fixture.open("B");
  const refusalReceipt = { status: "failed", error: refusal } as const;
  interruptions[1]!.resolve(refusalReceipt); assert.deepEqual(await second, refusalReceipt);
  interruptions[0]!.resolve(refusalReceipt); assert.deepEqual(await first, refusalReceipt);
  await assert.rejects(fixture.execution.resolveRequest({ resolution: answer("A") }), hasContractCode("request_resolution_mismatch"));
  assert.deepEqual(await fixture.execution.resolveRequest({ resolution: answer("B") }), { status: "delivered" });
  assert.deepEqual(fixture.answers, [answer("B")]);
  await fixture.finish();
});

test("temporarily withheld approval must retire before its item or turn completes", async (t) => {
  for (const completion of ["item", "turn"] as const) await t.test(completion, async (t) => {
    const interruptionReceipt = deferred<{ status: "failed"; error: AgentError }>();
    const fixture = await scenario({ interruption: { kind: "supported", interruptTurn: () => interruptionReceipt.promise } });
    t.after(() => fixture.dispose());
    await fixture.open("A");
    if (fixture.session.interruption.kind !== "supported") throw new Error("Missing interruption fixture.");
    const interruption = fixture.session.interruption.interruptTurn({ turnId, reason: "user_requested" });
    const invalid = completion === "item"
      ? fixture.next({ ...fixture.base, type: "item.completed", payload: { itemId, itemKind: "assistant_message", status: "completed" } })
      : fixture.next({ ...fixture.base, type: "turn.completed", payload: { outcome: "completed" } });
    await assert.rejects(invalid, hasContractCode("invalid_turn_sequence"));
    interruptionReceipt.resolve({ status: "failed", error: refusal });
    assert.deepEqual(await interruption, { status: "failed", error: refusal });
    await assert.rejects(fixture.execution.resolveRequest({ resolution: answer("A") }), hasContractCode("session_unusable"));
    assert.deepEqual(fixture.answers, []);
  });
});

test("a late pending refusal is preserved without restoring an approval for a completed item", async (t) => {
  const nativeReceipt = deferred<AgentRequestResolutionResult>();
  const entered = deferred<void>();
  const fixture = await scenario({ answer: async () => { entered.resolve(); return nativeReceipt.promise; } });
  t.after(() => fixture.dispose());
  await fixture.open("A");
  const answering = fixture.execution.resolveRequest({ resolution: answer("A") }); await entered.promise;
  await fixture.next({ ...fixture.base, type: "item.completed", payload: { itemId, itemKind: "assistant_message", status: "completed" } });
  const receipt = { status: "rejected", requestState: "pending", error: refusal } as const;
  nativeReceipt.resolve(receipt);
  assert.deepEqual(await answering, receipt);
  await assert.rejects(fixture.execution.resolveRequest({ resolution: answer("A") }), hasContractCode("request_resolution_mismatch"));
  await fixture.withdraw("A");
  await fixture.next({ ...fixture.base, type: "turn.completed", payload: { outcome: "completed" } });
  assert.deepEqual(fixture.answers, [answer("A")]);
});

test("UTF-8 identity exhaustion retains the native cleanup owner after cleanup fails", async (t) => {
  const firstClose = deferred<void>();
  const fixture = await scenario({ close(attempt) {
    if (attempt === 1) { firstClose.resolve(); throw new Error("Native workload still owns cleanup."); }
  } });
  t.after(() => fixture.dispose());
  const identity = (index: number) => `${String(index).padStart(4, "0")}${"界".repeat(252)}`;
  const accepted = Math.floor(1_048_576 / Buffer.byteLength(identity(0), "utf8"));
  assert.ok(accepted < 4_096);
  for (let index = 0; index < accepted; index += 1) {
    await fixture.open(identity(index)); await fixture.withdraw(identity(index));
  }
  await assert.rejects(fixture.open(identity(accepted)), hasContractCode("request_identity_limit_exceeded"));
  await firstClose.promise;
  assert.throws(() => fixture.session.startTurn(turnInput), hasContractCode("session_unusable"));
  // Drain the automatic attempt before explicitly retrying the same owner.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await fixture.session.close({ reason: "error" });
  assert.deepEqual([fixture.starts(), fixture.closes(), fixture.answers], [1, 2, []]);
});
