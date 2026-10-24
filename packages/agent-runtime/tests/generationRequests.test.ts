import assert from "node:assert/strict";
import { setImmediate, setTimeout } from "node:timers/promises";
import test from "node:test";
import { parseAgentIsoDateTime, type AgentRequestResolution, type AgentTurnCompletedPayload } from "@agen-ai/agent-protocol";
import { AgentGenerationError, generateObject } from "../src/generation/index.js";
import type { AgentRequestResolutionResult } from "../src/index.js";
import { answer, approval, deferred, event, generationFixture, itemId, terminal } from "./fixtures/generation/harness.js";

async function flush() { await setImmediate(); }
const failure = { category: "permission" as const, code: "answer_refused", message: "Native answer delivery failed.", recovery: { kind: "none" as const } };

test("generation delivers answers for unexpired requests within and beyond its lifetime", async (t) => {
  for (const expiryMs of [2_000, 30 * 24 * 60 * 60 * 1_000]) await t.test(`${expiryMs} ms provider expiry`, async () => {
    const request = approval();
    const delivered = deferred<void>();
    const handlerSignals: boolean[] = [];
    const f = await generationFixture({
      async resolveRequest() { delivered.resolve(); return { status: "delivered" }; },
      async *outputs(context, turn, closed) {
        yield event(context, turn, "turn.started", {});
        yield event(context, turn, "item.started", { itemId, itemKind: "assistant_message", status: "in_progress" });
        yield event(context, turn, "request.opened", {
          request: { ...request, expiresAt: parseAgentIsoDateTime(new Date(Date.now() + expiryMs).toISOString()) },
        });
        await Promise.race([delivered.promise, closed]);
        yield event(context, turn, "item.completed", { itemId, itemKind: "assistant_message", status: "completed" });
        yield terminal(context, turn);
      },
    });
    try {
      const result = await generateObject({ ...f.input, timeoutMs: 5_000, async onRequest(opened, { signal }) {
        // Real timers exercise Node's overflow behavior, which mocked timers do not reproduce.
        await setTimeout(20);
        handlerSignals.push(signal.aborted);
        return answer(opened);
      } });
      assert.deepEqual(result.value, { title: "A useful title" });
      assert.deepEqual(handlerSignals, [false]);
      assert.deepEqual(f.resolutions.map((input) => input.resolution), [answer(request)]);
      assert.deepEqual([f.turns.length, f.counts.readers, f.counts.settledReaders, f.counts.closes], [1, 1, 1, 1]);
    } finally { await f.registry.dispose(); }
  });
});

test("provider expiry before the generation deadline aborts its handler and discards a late answer", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const first = { ...approval("generation:expired"), expiresAt: parseAgentIsoDateTime(new Date(Date.now() + 100).toISOString()) };
  const second = approval("generation:remaining");
  const entered = deferred<AbortSignal>();
  const release = deferred<void>();
  const delivered = deferred<void>();
  const f = await generationFixture({
    async resolveRequest() { delivered.resolve(); return { status: "delivered" }; },
    async *outputs(context, turn) {
      yield event(context, turn, "turn.started", {});
      yield event(context, turn, "item.started", { itemId, itemKind: "assistant_message", status: "in_progress" });
      yield event(context, turn, "request.opened", { request: first });
      await release.promise;
      yield event(context, turn, "request.unavailable", { requestId: first.requestId, reason: "expired" });
      yield event(context, turn, "request.opened", { request: second });
      await delivered.promise;
      yield event(context, turn, "item.completed", { itemId, itemKind: "assistant_message", status: "completed" });
      yield terminal(context, turn);
    },
  });
  const pending = generateObject({ ...f.input, timeoutMs: 1_000, async onRequest(request, { signal }) {
    if (request.requestId === first.requestId) { entered.resolve(signal); await release.promise; }
    return answer(request);
  } });
  const signal = await entered.promise;
  t.mock.timers.tick(99);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  release.resolve();
  assert.deepEqual((await pending).value, { title: "A useful title" });
  assert.deepEqual(f.resolutions.map((input) => input.resolution), [answer(second)]);
  assert.deepEqual([f.turns.length, f.counts.readers, f.counts.settledReaders, f.counts.closes], [1, 1, 1, 1]);
  await f.registry.dispose();
});

test("a missing generation request handler fails without approval while owning interruption and the original reader to close", async () => {
  const request = approval();
  const f = await generationFixture({ async *outputs(context, turn, closed) {
    yield event(context, turn, "turn.started", {});
    yield event(context, turn, "item.started", { itemId, itemKind: "assistant_message", status: "in_progress" });
    yield event(context, turn, "request.opened", { request });
    await closed;
    yield terminal(context, turn, { outcome: "canceled", structuredOutput: { kind: "unavailable", reason: "incomplete" } });
  } });
  await assert.rejects(generateObject(f.input), (error) => error instanceof AgentGenerationError && error.code === "interaction_required");
  assert.deepEqual([f.turns.length, f.counts.readers, f.counts.settledReaders, f.counts.interrupts, f.counts.closes, f.resolutions.length, f.disposed()], [1, 1, 1, 1, 1, 0, 0]);
  await f.registry.dispose();
});

test("withdrawn generation handlers are aborted, their late answers discarded, and another request succeeds while output keeps flowing", async () => {
  const first = approval("generation:A"), second = approval("generation:B");
  const lateAnswer = deferred<AgentRequestResolution>();
  const withdrawn = deferred<void>();
  const receipt = deferred<void>();
  let firstSignal: AbortSignal | undefined;
  const observed: string[] = [];
  const handled: string[] = [];
  const f = await generationFixture({
    async resolveRequest() { receipt.resolve(); return { status: "delivered" }; },
    async *outputs(context, turn) {
      yield event(context, turn, "turn.started", {});
      yield event(context, turn, "item.started", { itemId, itemKind: "assistant_message", status: "in_progress" });
      yield event(context, turn, "request.opened", { request: first });
      yield event(context, turn, "content.delta", { itemId, streamKind: "assistant_text", delta: "Output while A waits." });
      yield event(context, turn, "request.unavailable", { requestId: first.requestId, reason: "withdrawn" });
      withdrawn.resolve();
      yield event(context, turn, "request.opened", { request: second });
      yield event(context, turn, "content.delta", { itemId, streamKind: "assistant_text", delta: "Output while B waits." });
      await receipt.promise;
      yield event(context, turn, "item.completed", { itemId, itemKind: "assistant_message", status: "completed" });
      yield terminal(context, turn);
    },
  });
  const pending = generateObject({ ...f.input,
    onOutput(output) { if (output.kind === "event" && output.event.type === "content.delta") observed.push(output.event.payload.delta); },
    onRequest(request, context) {
      handled.push(request.requestId);
      if (request.requestId === first.requestId) { firstSignal = context.signal; return lateAnswer.promise; }
      return answer(request);
    },
  });
  await withdrawn.promise; await flush();
  assert.equal(firstSignal?.aborted, true);
  lateAnswer.resolve(answer(first));
  assert.deepEqual((await pending).value, { title: "A useful title" });
  assert.deepEqual(handled, ["generation:A", "generation:B"]);
  assert.deepEqual(observed, ["Output while A waits.", "Output while B waits."]);
  assert.deepEqual(f.resolutions.map((input) => input.resolution), [answer(second)]);
  assert.deepEqual([f.turns.length, f.counts.readers, f.counts.settledReaders, f.counts.closes], [1, 1, 1, 1]); await f.registry.dispose();
});

test("generation retains rejected and uncertain response receipts as failures without replaying an answer or model turn", async (t) => {
  const receipts: readonly AgentRequestResolutionResult[] = [
    { status: "rejected", requestState: "pending", error: failure },
    { status: "rejected", requestState: "unavailable", error: failure },
    { status: "delivery_uncertain", error: failure },
  ];
  for (const receipt of receipts) await t.test(`${receipt.status}${receipt.status === "rejected" ? `/${receipt.requestState}` : ""}`, async () => {
    const request = approval();
    const entered = deferred<void>();
    const releaseReceipt = deferred<AgentRequestResolutionResult>();
    const continuation = deferred<void>();
    const observed: string[] = [];
    const f = await generationFixture({
      async resolveRequest() { entered.resolve(); return releaseReceipt.promise; },
      async *outputs(context, turn, closed) {
        yield event(context, turn, "turn.started", {});
        yield event(context, turn, "item.started", { itemId, itemKind: "assistant_message", status: "in_progress" });
        yield event(context, turn, "request.opened", { request });
        await entered.promise;
        yield event(context, turn, "content.delta", { itemId, streamKind: "assistant_text", delta: "Output while the receipt waits." });
        continuation.resolve();
        await closed;
        const payload: AgentTurnCompletedPayload = { outcome: "canceled", structuredOutput: { kind: "unavailable", reason: "incomplete" } };
        yield terminal(context, turn, payload);
      },
    });
    const pending = generateObject({ ...f.input, onRequest: answer, onOutput(output) {
      if (output.kind === "event" && output.event.type === "content.delta") observed.push(output.event.payload.delta);
    } });
    const rejected = assert.rejects(pending, (error) => {
      assert.ok(error instanceof AgentGenerationError); assert.equal(error.code, "request_failed");
      assert.deepEqual(error.receipt, receipt); return true;
    });
    await continuation.promise;
    assert.deepEqual(observed, ["Output while the receipt waits."]);
    releaseReceipt.resolve(receipt); await rejected;
    assert.deepEqual(f.resolutions.map((input) => input.resolution), [answer(request)]);
    assert.deepEqual([f.turns.length, f.counts.readers, f.counts.settledReaders, f.counts.closes, f.disposed()], [1, 1, 1, 1, 0]); await f.registry.dispose();
  });
});

test("a rejected application request handler fails locally and closes without dispatching a resolution", async () => {
  const local = new Error("Host policy cannot answer this request.");
  const f = await generationFixture({ async *outputs(context, turn, closed) {
    yield event(context, turn, "turn.started", {});
    yield event(context, turn, "item.started", { itemId, itemKind: "assistant_message", status: "in_progress" });
    yield event(context, turn, "request.opened", { request: approval() }); await closed;
    yield terminal(context, turn, { outcome: "canceled", structuredOutput: { kind: "unavailable", reason: "incomplete" } });
  } });
  await assert.rejects(generateObject({ ...f.input, onRequest() { throw local; } }), (error) => error instanceof AgentGenerationError && error.code === "request_failed" && error.cause === local);
  assert.deepEqual([f.turns.length, f.resolutions.length, f.counts.settledReaders, f.counts.closes], [1, 0, 1, 1]); await f.registry.dispose();
});

test("eight retired but unfinished handlers keep their capacity until settlement and a ninth cannot start", async () => {
  const release = deferred<void>();
  const handled: string[] = [];
  const signals: AbortSignal[] = [];
  const f = await generationFixture({ async close() { release.resolve(); }, async *outputs(context, turn, closed) {
    yield event(context, turn, "turn.started", {});
    yield event(context, turn, "item.started", { itemId, itemKind: "assistant_message", status: "in_progress" });
    for (let index = 1; index <= 9; index += 1) {
      const request = approval(`capacity:${index}`);
      yield event(context, turn, "request.opened", { request });
      yield event(context, turn, "request.unavailable", { requestId: request.requestId, reason: "withdrawn" });
    }
    await closed; yield terminal(context, turn, { outcome: "canceled", structuredOutput: { kind: "unavailable", reason: "incomplete" } });
  } });
  await assert.rejects(generateObject({ ...f.input, async onRequest(request, { signal }) {
    handled.push(request.requestId); signals.push(signal); await release.promise; return answer(request);
  } }), (error) => error instanceof AgentGenerationError && error.code === "request_failed");
  assert.deepEqual(handled, ["capacity:1", "capacity:2", "capacity:3", "capacity:4", "capacity:5", "capacity:6", "capacity:7", "capacity:8"]);
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true, true, true, true, true, true, true]);
  assert.deepEqual([f.turns.length, f.resolutions.length, f.counts.readers, f.counts.settledReaders, f.counts.closes], [1, 0, 1, 1, 1]); await f.registry.dispose();
});
