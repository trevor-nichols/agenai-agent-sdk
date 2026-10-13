// ------------------------------------------------------------------------------------------------
//                executionInteractions.test.ts - Steering delivery, queued turns and safe continuation
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseAgentCapabilities } from "@agen-ai/agent-protocol";
import { createAgentEventOutput } from "@agen-ai/agent-runtime";
import { createFakeAgentProvider } from "@agen-ai/agent-runtime/testing";
import { enabledPolicy } from "./fixtures.js";
import { createExecutionHarness, textInput, waitFor } from "./fixtures/execution/harness.js";
import { completedTurn, deferred, eventBase, mapTurnOutputs } from "./fixtures/execution/provider.js";
import { hasCode } from "./fixtures/execution/store.js";

test("steering delivers once across policy revisions and rechecks control authority at invocation", { timeout: 10_000 }, async (t) => {
  const finish = deferred<void>();
  const entered = deferred<void>();
  let revokeAtIntent = false;
  const harness = await createExecutionHarness({ store(store) { return { ...store, async commit(command) {
    const receipt = await store.commit(command);
    if (revokeAtIntent && command.kind === "dispatch_intent" && command.operationKind === "steer") revokeControl();
    return receipt;
  } }; }, provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.started", payload: {} });
      entered.resolve();
      await finish.promise;
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.completed", payload: { outcome: "completed" } });
    }) };
  } } });
  const revokeControl = () => harness.denyControlAccess();
  t.after(async () => { finish.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await entered.promise;
  const input = { operationId: randomUUID(), taskId: admitted.taskId, mode: "steer" as const,
    input: textInput("Also verify the edge case."), target: harness.target.reference, expectedPolicyRevision: 1 };
  const concurrent = await Promise.all([harness.client.send(input), harness.client.send(input)]);
  assert.equal(concurrent.every((receipt) => receipt.status === "delivered"), true);
  assert.deepEqual(new Set(concurrent.map((receipt) => receipt.duplicate)), new Set([false, true]));
  const receipt = concurrent.find((entry) => !entry.duplicate)!;
  assert.equal(receipt.status, "delivered");
  assert.deepEqual(await harness.client.send(input), { ...receipt, duplicate: true });
  assert.equal(harness.provider.fake.snapshot().steeringInputs.length, 1);
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).task.runCount, 1);
  await assert.rejects(harness.client.send({ ...input, mode: "next_turn" }), hasCode("operation_conflict"));
  harness.setPolicy({ ...enabledPolicy(), revision: 2 });
  assert.equal((await harness.client.targets()).policyRevision, 2);
  const refreshed = { ...input, operationId: randomUUID(), expectedPolicyRevision: 2 };
  assert.equal((await harness.client.send(refreshed)).status, "delivered");
  assert.equal(harness.provider.fake.snapshot().steeringInputs.length, 2);
  revokeAtIntent = true;
  const revoked = { ...refreshed, operationId: randomUUID() };
  assert.equal((await harness.client.send(revoked)).status, "rejected");
  assert.equal((await harness.client.send(revoked)).duplicate, true);
  assert.equal(harness.provider.fake.snapshot().steeringInputs.length, 2);
  finish.resolve();
  await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(harness.provider.calls.turns.length, 1);
});

test("unsupported steering rejects without creating a queued fallback", { timeout: 10_000 }, async (t) => {
  const entered = deferred<void>();
  const finish = deferred<void>();
  const capabilities = createFakeAgentProvider().capabilities;
  const harness = await createExecutionHarness({ provider: { fakeOptions: {
    capabilities: parseAgentCapabilities({ ...capabilities, turns: { ...capabilities.turns, steer: { kind: "unsupported" } } }),
  }, transformSession(session, context) { return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
    yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.started", payload: {} });
    entered.resolve();
    await finish.promise;
    yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.completed", payload: { outcome: "completed" } });
  }) }; } } });
  t.after(async () => { finish.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await entered.promise;
  await assert.rejects(harness.client.send({ operationId: randomUUID(), taskId: admitted.taskId, mode: "steer",
    input: textInput(), target: harness.target.reference, expectedPolicyRevision: 1 }), hasCode("unsupported_operation"));
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).task.runCount, 1);
  assert.equal(harness.provider.fake.snapshot().steeringInputs.length, 0);
});

test("next_turn reserves one queued run and resumes only after a definite terminal boundary", { timeout: 10_000 }, async (t) => {
  const finish = deferred<void>();
  const entered = deferred<void>();
  let turns = 0;
  const harness = await createExecutionHarness({ allowContinuation: true, provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
      turns += 1;
      if (turns > 1) { yield* completedTurn(context, input.turnId); return; }
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.started", payload: {} });
      entered.resolve();
      await finish.promise;
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.completed", payload: { outcome: "completed" } });
    }) };
  } } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await entered.promise;
  const input = { operationId: randomUUID(), taskId: admitted.taskId, mode: "next_turn" as const,
    input: textInput("Continue after the first turn."), target: harness.target.reference, expectedPolicyRevision: 1 };
  const queued = await harness.client.send(input);
  assert.equal(queued.status, "queued");
  await assert.rejects(harness.client.send({ ...input, operationId: randomUUID() }), hasCode("capacity_exceeded"));
  assert.equal(harness.provider.calls.turns.length, 1);
  finish.resolve();
  await waitFor(async () => (await harness.client.inspect({ taskId: admitted.taskId })).runs.items.filter((run) => run.phase === "settled").length === 2,
    "Both admitted runs should settle.");
  assert.equal(harness.provider.fake.snapshot().createdSessionIds.length, 1);
  assert.equal(harness.provider.fake.snapshot().resumedSessionIds.length, 1);
  assert.equal(harness.resources[1]?.continuation?.runId, admitted.runId);
  const view = await harness.client.inspect({ taskId: admitted.taskId });
  assert.equal(view.task.runCount, 2);
  assert.equal(view.runs.items.every((run) => run.outcome?.kind === "succeeded"), true);
});

test("follow_up requires host-approved exact resume and preserves immutable earlier outcomes", { timeout: 10_000 }, async (t) => {
  for (const allowed of [false, true]) {
    await t.test(`continuation authority ${allowed}`, async (st) => {
      const harness = await createExecutionHarness({ allowContinuation: allowed, provider: { transformSession(session, context) {
        return { ...session, startTurn: mapTurnOutputs(session, (input) => completedTurn(context, input.turnId)) };
      } } });
      st.after(() => harness.close());
      const admitted = await harness.spawn();
      const first = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
      assert.equal(first.status, "settled");
      const send = () => harness.client.send({ operationId: randomUUID(), taskId: admitted.taskId, mode: "follow_up",
        input: textInput("Follow up."), target: harness.target.reference, expectedPolicyRevision: 1 });
      if (!allowed) {
        await assert.rejects(send(), hasCode("unsupported_operation"));
        assert.equal(harness.provider.calls.turns.length, 1);
      } else {
        assert.equal((await send()).status, "queued");
        await waitFor(() => harness.provider.calls.turns.length === 2, "The follow-up should resume.");
        const view = await harness.client.inspect({ taskId: admitted.taskId });
        assert.deepEqual(view.runs.items.find((run) => run.runId === admitted.runId)?.outcome, first.task.runs.items[0]?.outcome);
        assert.equal(harness.provider.fake.snapshot().resumedSessionIds.length, 1);
      }
    });
  }
});

test("uncertain steering serializes later controls, cannot be replayed and forbids future follow-up", { timeout: 10_000 }, async (t) => {
  const finish = deferred<void>();
  const entered = deferred<void>();
  const steerEntered = deferred<void>();
  const releaseSteer = deferred<void>();
  let nativeSteers = 0;
  const harness = await createExecutionHarness({ allowContinuation: true, provider: {
    transformSession(session, context) {
      const steering = session.steering;
      if (steering.kind !== "supported") throw new Error("Expected fake steering");
      return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
        yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.started", payload: {} });
        entered.resolve();
        await finish.promise;
        yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.completed", payload: { outcome: "completed" } });
      }), steering: { kind: "supported", async steerTurn(input) {
        nativeSteers += 1;
        const result = await steering.steerTurn(input);
        if (nativeSteers !== 1) return result;
        steerEntered.resolve();
        await releaseSteer.promise;
        return { status: "delivery_uncertain", error: { code: "transport_lost", message: "Delivery could not be confirmed.", category: "unknown", recovery: { kind: "unknown" } } };
      } } }; },
  } });
  t.after(async () => { releaseSteer.resolve(); finish.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await entered.promise;
  const input = { operationId: randomUUID(), taskId: admitted.taskId, mode: "steer" as const,
    input: textInput(), target: harness.target.reference, expectedPolicyRevision: 1 };
  const first = harness.client.send(input);
  await steerEntered.promise;
  let laterSettled = false;
  const later = harness.client.send({ ...input, operationId: randomUUID(), input: textInput("Later steering") }).then(
    (receipt) => { laterSettled = true; return { kind: "receipt" as const, receipt }; },
    (error: unknown) => { laterSettled = true; return { kind: "error" as const, error }; },
  );
  await setImmediate();
  assert.equal(nativeSteers, 1, "A distinct steering operation must wait for the earlier native receipt.");
  assert.equal(laterSettled, false);
  releaseSteer.resolve();
  const receipt = await first;
  assert.equal(receipt.status, "delivery_uncertain");
  const laterOutcome = await later;
  assert.equal(laterOutcome.kind, "error");
  if (laterOutcome.kind !== "error") throw new Error("Steering after uncertain delivery must reject before native execution");
  assert.ok(hasCode("recovery_required")(laterOutcome.error));
  assert.deepEqual(await harness.client.send(input), { ...receipt, duplicate: true });
  finish.resolve();
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(settled.task.runs.items[0]?.outcome?.kind, "recovery_required");
  assert.equal(harness.provider.fake.snapshot().steeringInputs.length, 1);
  await assert.rejects(harness.client.send({ ...input, operationId: randomUUID(), mode: "follow_up" }), hasCode("recovery_required"));
  assert.equal(harness.provider.calls.turns.length, 1);
});
