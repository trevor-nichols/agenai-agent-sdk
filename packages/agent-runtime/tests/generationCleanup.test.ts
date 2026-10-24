import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseAgentProviderKey } from "@agen-ai/agent-protocol";
import { AgentGenerationCleanupError, AgentGenerationError, generateObject } from "../src/generation/index.js";
import { createAgentProviderSessionCleanupError, type AgentProviderSessionCleanupError, type AgentRequestResolutionResult } from "../src/index.js";
import { approval, answer, deferred, event, generationFixture, itemId, terminal } from "./fixtures/generation/harness.js";

async function flush() { await setImmediate(); }

test("an opening failure keeps its original retained cleanup error and does not invoke that retry while propagating", async () => {
  let retained: AgentProviderSessionCleanupError | undefined;
  let publicFailure: unknown;
  let retries = 0;
  const f = await generationFixture({ async beforeOpen(context) {
    retained = createAgentProviderSessionCleanupError({ providerKey: parseAgentProviderKey("fake-provider"), openingInput: context,
      errors: [new Error("Native opening cleanup remains owned.")], async retryCleanup() { retries += 1; } });
    throw retained;
  } });
  const instance = { ...f.instance, adapter: { ...f.instance.adapter, async createSession(context: Parameters<typeof f.instance.adapter.createSession>[0]) {
    try { return await f.instance.adapter.createSession(context); }
    catch (error) { publicFailure = error; throw error; }
  } } };
  await assert.rejects(generateObject({ ...f.input, instance }), (error) => error === publicFailure);
  assert.deepEqual([f.counts.opens, f.turns.length, f.counts.closes, retries, f.disposed()], [1, 0, 0, 0, 0]);
  assert.ok(retained); await retained.retryCleanup(); await retained.retryCleanup();
  assert.equal(retries, 1); await f.registry.dispose();
});

test("caller abort or an earlier turn deadline during native running closes once and preserves cancellation classification", async (t) => {
  for (const mode of ["abort", "deadline"] as const) await t.test(mode, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const controller = new AbortController();
    const reason = new DOMException("Caller stopped title generation.", "AbortError");
    const f = await generationFixture({ async *outputs(context, turn, closed) { yield event(context, turn, "turn.started", {}); await closed; yield terminal(context, turn); } });
    const pending = generateObject({ ...f.input, signal: controller.signal, timeoutMs: 10_000,
      ...(mode === "deadline" ? { turn: { ...f.input.turn, deadlineAt: new Date(Date.now() + 100).toISOString() } } : {}),
    });
    const rejected = assert.rejects(pending, (error) => mode === "abort" ? error === reason : error instanceof AgentGenerationError && error.code === "timeout");
    await f.started; await flush();
    if (mode === "abort") controller.abort(reason); else t.mock.timers.tick(100);
    await rejected;
    assert.deepEqual([f.counts.opens, f.turns.length, f.counts.readers, f.counts.settledReaders, f.counts.interrupts, f.counts.closes, f.resolutions.length, f.disposed()], [1, 1, 1, 1, 1, 1, 0, 0]);
    await f.registry.dispose();
  });
});

test("a canceled or expired pending opening retains late session cleanup and never starts a turn", async (t) => {
  for (const mode of ["abort", "timeout"] as const) await t.test(mode, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const gate = deferred<void>();
    const controller = new AbortController();
    const reason = new DOMException("Canceled while opening.", "AbortError");
    const f = await generationFixture({ beforeOpen: () => gate.promise, ignoreOpeningAbort: true });
    let retained: AgentGenerationCleanupError | undefined;
    const rejected = assert.rejects(generateObject({ ...f.input, signal: controller.signal, timeoutMs: 100 }), (error) => {
      assert.ok(error instanceof AgentGenerationCleanupError); retained = error;
      if (mode === "abort") assert.equal(error.primaryError, reason);
      else assert.ok(error.primaryError instanceof AgentGenerationError && error.primaryError.code === "timeout");
      return true;
    });
    await f.opened;
    if (mode === "abort") controller.abort(reason); else t.mock.timers.tick(100);
    await flush(); t.mock.timers.tick(30_000); await rejected;
    assert.deepEqual([f.turns.length, f.counts.closes, f.disposed()], [0, 0, 0]);
    gate.resolve(); await flush();
    assert.ok(retained); await retained.retryCleanup(); await retained.retryCleanup();
    assert.deepEqual([f.counts.opens, f.turns.length, f.counts.readers, f.counts.closes, f.disposed()], [1, 0, 0, 1, 0]);
    await f.registry.dispose();
  });
});

test("a failed close retains either the validated result or primary local failure and concurrent cleanup retries never replay generation", async (t) => {
  for (const localFailure of [false, true]) await t.test(localFailure ? "observer failure" : "validated result", async () => {
    const nativeFailure = new Error("Native cleanup is incomplete.");
    const observerFailure = new Error("Observer failed.");
    const f = await generationFixture({ async close(attempt) { if (attempt <= 2) throw nativeFailure; } });
    let retained: AgentGenerationCleanupError | undefined;
    await assert.rejects(generateObject({ ...f.input, ...(localFailure ? { onOutput() { throw observerFailure; } } : {}) }), (error) => {
      assert.ok(error instanceof AgentGenerationCleanupError); retained = error;
      if (localFailure) {
        assert.ok(error.primaryError instanceof AgentGenerationError); assert.equal(error.primaryError.code, "observer_failed");
        assert.equal(error.primaryError.cause, observerFailure); assert.equal(error.result, undefined);
      } else {
        assert.deepEqual(error.result, { value: { title: "A useful title" }, sessionId: f.input.session.sessionId, turnId: f.input.turn.turnId });
        assert.equal(error.primaryError, undefined);
      }
      return true;
    });
    assert.ok(retained); assert.equal(f.disposed(), 0);
    await assert.rejects(retained.retryCleanup(), (error) => error === nativeFailure);
    await Promise.all([retained.retryCleanup(), retained.retryCleanup()]); await retained.retryCleanup();
    assert.deepEqual([f.counts.opens, f.turns.length, f.counts.readers, f.counts.closes, f.disposed()], [1, 1, 1, 3, 0]);
    await f.registry.dispose();
  });
});

test("a non-settling observer or request handler has bounded waiting and retains callback ownership until cleanup can prove settlement", async (t) => {
  for (const callback of ["observer", "request"] as const) await t.test(callback, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const release = deferred<void>();
    const entered = deferred<void>();
    const f = await generationFixture({ async *outputs(context, turn, closed) {
      yield event(context, turn, "turn.started", {});
      if (callback === "request") {
        yield event(context, turn, "item.started", { itemId, itemKind: "assistant_message", status: "in_progress" });
        yield event(context, turn, "request.opened", { request: approval() });
      }
      await closed; yield terminal(context, turn);
    } });
    let retained: AgentGenerationCleanupError | undefined;
    const pending = generateObject({ ...f.input, timeoutMs: 600_000,
      ...(callback === "observer" ? { async onOutput() { entered.resolve(); await release.promise; } }
        : { async onRequest(request: ReturnType<typeof approval>) { entered.resolve(); await release.promise; return answer(request); } }),
    });
    const rejected = assert.rejects(pending, (error) => {
      assert.ok(error instanceof AgentGenerationCleanupError); retained = error;
      assert.ok(error.primaryError instanceof AgentGenerationError);
      assert.equal(error.primaryError.code, callback === "observer" ? "observer_failed" : "request_failed"); return true;
    });
    await entered.promise;
    t.mock.timers.tick(callback === "observer" ? 30_000 : 300_000);
    await flush(); t.mock.timers.tick(30_000); await rejected;
    assert.equal(f.counts.closes, 1); assert.equal(f.resolutions.length, 0); assert.equal(f.disposed(), 0);
    release.resolve(); assert.ok(retained); await retained.retryCleanup();
    assert.deepEqual([f.turns.length, f.counts.readers, f.counts.settledReaders, f.counts.closes, f.resolutions.length], [1, 1, 1, 1, 0]); await f.registry.dispose();
  });
});

test("an unfinished native close is bounded and its exact in-flight ownership survives retry until closure", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const release = deferred<void>();
  const closing = deferred<void>();
  const f = await generationFixture({ async close() { closing.resolve(); await release.promise; } });
  let retained: AgentGenerationCleanupError | undefined;
  const rejected = assert.rejects(generateObject(f.input), (error) => {
    assert.ok(error instanceof AgentGenerationCleanupError); retained = error;
    assert.deepEqual(error.result?.value, { title: "A useful title" }); return true;
  });
  await closing.promise; await flush(); t.mock.timers.tick(30_000); await rejected;
  release.resolve(); assert.ok(retained); await Promise.all([retained.retryCleanup(), retained.retryCleanup()]); await retained.retryCleanup();
  assert.deepEqual([f.counts.opens, f.turns.length, f.counts.readers, f.counts.closes, f.disposed()], [1, 1, 1, 1, 0]); await f.registry.dispose();
});

test("a non-settling entered answer times out without replay and remains owned until its original receipt settles", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const receipt = deferred<AgentRequestResolutionResult>();
  const entered = deferred<void>();
  const f = await generationFixture({ async resolveRequest() { entered.resolve(); return receipt.promise; }, async *outputs(context, turn, closed) {
    yield event(context, turn, "turn.started", {});
    yield event(context, turn, "item.started", { itemId, itemKind: "assistant_message", status: "in_progress" });
    yield event(context, turn, "request.opened", { request: approval() });
    await closed; yield terminal(context, turn, { outcome: "canceled", structuredOutput: { kind: "unavailable", reason: "incomplete" } });
  } });
  let retained: AgentGenerationCleanupError | undefined;
  const rejected = assert.rejects(generateObject({ ...f.input, onRequest: answer }), (error) => {
    assert.ok(error instanceof AgentGenerationCleanupError); retained = error;
    assert.ok(error.primaryError instanceof AgentGenerationError); assert.equal(error.primaryError.code, "request_failed"); return true;
  });
  await entered.promise; await flush(); t.mock.timers.tick(30_000);
  await flush(); t.mock.timers.tick(30_000); await rejected;
  assert.deepEqual([f.turns.length, f.resolutions.length, f.counts.closes, f.disposed()], [1, 1, 1, 0]);
  receipt.resolve({ status: "delivered" }); assert.ok(retained); await retained.retryCleanup(); await retained.retryCleanup();
  assert.deepEqual([f.turns.length, f.resolutions.length, f.counts.readers, f.counts.settledReaders, f.counts.closes], [1, 1, 1, 1, 1]); await f.registry.dispose();
});
