// ------------------------------------------------------------------------------------------------
//                executionCleanup.test.ts - Exact cleanup ownership, bounded retries and shutdown
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAgentEventOutput } from "@agen-ai/agent-runtime";
import type { DelegationOperationRecord } from "../src/index.js";
import { createExecutionHarness, waitFor } from "./fixtures/execution/harness.js";
import { bindingSupport, ownedBinding } from "./fixtures/execution/binding.js";
import { completedTurn, eventBase, mapTurnOutputs } from "./fixtures/execution/provider.js";

test("paired cleanup intents precede the exact runtime close and complete only after native quiescence", { timeout: 10_000 }, async (t) => {
  const events: string[] = [];
  const binding = ownedBinding(events);
  let closes = 0;
  const harness = await createExecutionHarness({ binding: () => binding.binding, provider: {
    transformAdapter(adapter) { return { ...adapter, hostBinding: bindingSupport }; },
    transformSession(session, context) {
      const candidate = { ...session, startTurn: mapTurnOutputs(session, (input: Parameters<typeof session.startTurn>[0]) => completedTurn(context, input.turnId)), async close(input: Parameters<typeof session.close>[0]) {
        assert.equal(this, candidate);
        await assertIntents();
        closes += 1;
        events.push(`native_close_${closes}`);
        if (closes === 1) throw new Error("Native producer is still draining");
        await session.close(input);
        events.push("native_quiesced");
      } };
      return candidate;
    },
  } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  const assertIntents = async () => {
    const operations = await harness.store.read({ kind: "operations", taskId: admitted.taskId, runId: admitted.runId });
    assert.equal(operations.kind, "operations");
    for (const kind of ["session_close", "binding_cleanup"]) {
      assert.equal(operations.page.items.find((operation) => operation.kind === kind)?.disposition, "intent");
    }
    assert.equal(binding.releases(), 0);
    assert.equal(harness.resourceReleases(), 0);
  };
  await waitFor(() => harness.resourceReleases() === 1, "Both cleanup stages should finish on the second explicit attempt.");
  assert.equal(closes, 2);
  assert.equal(binding.releases(), 1);
  assert.deepEqual(events, ["native_close_1", "native_close_2", "native_quiesced", "binding_released"]);
  const operations = await harness.store.read({ kind: "operations", taskId: admitted.taskId, runId: admitted.runId });
  assert.equal(operations.kind, "operations");
  for (const kind of ["session_close", "binding_cleanup"]) {
    const operation: DelegationOperationRecord | undefined = operations.page.items.find((item) => item.kind === kind);
    assert.equal(operation?.disposition, "completed");
    assert.equal(operation?.attempts, 2);
  }
});

test("failed cleanup overrides classified terminal failure and retains both stages within the two-attempt budget", { timeout: 10_000 }, async () => {
  const binding = ownedBinding();
  let closes = 0;
  const harness = await createExecutionHarness({ limits: { maxActiveRuns: 1 }, binding: () => binding.binding, provider: {
    transformAdapter(adapter) { return { ...adapter, hostBinding: bindingSupport }; },
    transformSession(session, context) { return { ...session,
      startTurn: mapTurnOutputs(session, async function* (input) {
        const base = eventBase(context, input.turnId);
        yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
        yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "failed", error: {
          category: "authentication", code: "login_required", message: "Authentication is required.", recovery: { kind: "user_action", action: "authenticate" },
        } } });
      }),
      async close() { closes += 1; throw new Error("Native producers cannot be quiesced"); },
    }; },
  } });
  const admitted = await harness.spawn();
  await waitFor(() => closes === 2, "Cleanup must use at most two actual attempts.");
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "recovery_required", reason: "cancellation_uncertain" });
  const queued = await harness.spawn();
  assert.equal((await harness.client.inspect({ taskId: queued.taskId })).runs.items[0]?.phase, "queued");
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal(harness.provider.contexts.length, 1);
  await harness.client.cancel({ operationId: randomUUID(), taskId: queued.taskId });
  assert.deepEqual((await harness.client.wait({ taskId: queued.taskId, timeoutMs: 1_000 })).task.runs.items[0]?.outcome,
    { kind: "canceled", confirmation: "not_dispatched" });
  for (let index = 0; index < 2; index += 1) {
    const shutdown = await harness.coordinator.dispose({ mode: "cancel", timeoutMs: 50 });
    assert.equal(shutdown.status, "recovery_required");
    assert.deepEqual(shutdown.retainedTaskIds, [admitted.taskId]);
  }
  assert.equal(closes, 2);
  assert.equal(binding.releases(), 0);
  assert.equal(harness.resourceReleases(), 0);
  assert.equal(harness.grantReleases(), 0);
  const operations = await harness.store.read({ kind: "operations", taskId: admitted.taskId, runId: admitted.runId });
  assert.equal(operations.kind, "operations");
  for (const kind of ["session_close", "binding_cleanup"]) {
    const operation: DelegationOperationRecord | undefined = operations.page.items.find((item) => item.kind === kind);
    assert.equal(operation?.attempts, 2);
    assert.notEqual(operation?.disposition, "completed");
  }
});

test("a rejected opening's failed native cleanup counts as the first attempt on its retained runtime handle", { timeout: 10_000 }, async (t) => {
  for (const withBinding of [true, false]) await t.test(withBinding ? "bound opening" : "unbound opening", async () => {
    const binding = ownedBinding();
    let closes = 0;
    const harness = await createExecutionHarness({ ...(withBinding ? { binding: () => binding.binding } : {}), provider: {
      transformAdapter(adapter) { return { ...adapter, hostBinding: bindingSupport }; },
      transformSession(session) {
        return Object.assign({ ...session, async close() { closes += 1; throw new Error("Rejected session still has native producers"); } }, { invalidExtraPort: true });
      },
    } });
    const admitted = await harness.spawn();
    await waitFor(() => closes === 2, "The coordinator may retry the retained opening cleanup only once.");
    const shutdown = await harness.coordinator.dispose({ mode: "cancel", timeoutMs: 50 });
    assert.equal(shutdown.status, "recovery_required");
    assert.deepEqual(shutdown.retainedTaskIds, [admitted.taskId]);
    assert.equal(closes, 2);
    assert.equal(binding.releases(), 0);
    assert.equal(harness.resourceReleases(), 0);
    assert.equal(harness.provider.calls.turns.length, 0);
    const facade = harness.provider.contexts[0]?.hostBinding;
    if (withBinding) {
      assert.ok(facade);
      await assert.rejects(async () => facade.invoke({ invocationId: "after-rejected-opening", toolName: "Inspect", arguments: {} }));
    } else assert.equal(facade, undefined);
  });
});

test("drain shutdown lets an exact waiting host request finish within its grace period", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness();
  t.after(() => harness.close());
  await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The child should reach a waiting request.");
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected fake approval");
  const shutdown = harness.coordinator.dispose({ mode: "drain", timeoutMs: 1_000 });
  const resolved = await harness.coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval", requestId: request.request.requestId, disposition: "selected", optionId: request.request.options[0]!.optionId,
  } });
  assert.equal(resolved.status, "delivered");
  assert.deepEqual(await shutdown, { status: "closed", retainedTaskIds: [] });
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  assert.equal(harness.provider.calls.close, 1);
  assert.equal(harness.resourceReleases(), 1);
  assert.equal(harness.grantReleases(), 1);
});

for (const queuedCount of [0, 3]) test(`drain shutdown retains every task across ${queuedCount} queued pages without canceling a waiting request`, { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ limits: { maxActiveRuns: 1, maxPageRecords: 1 } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The request should remain active.");
  const retained = [admitted.taskId];
  for (let index = 0; index < queuedCount; index += 1) retained.push((await harness.spawn()).taskId);
  const shutdown = await harness.coordinator.dispose({ mode: "drain", timeoutMs: 20 });
  assert.equal(shutdown.status, "recovery_required");
  assert.deepEqual(shutdown.retainedTaskIds, retained.sort());
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  assert.equal(harness.provider.calls.close, 0);
  assert.equal(harness.resourceReleases(), 0);
});
