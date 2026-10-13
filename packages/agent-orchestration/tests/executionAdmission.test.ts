// ------------------------------------------------------------------------------------------------
//                executionAdmission.test.ts - Authority, exact targets and scoped replay
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAgentEventOutput } from "@agen-ai/agent-runtime";
import type { DelegationClient } from "../src/index.js";
import { enabledPolicy, explicitSelection, makeTarget } from "./fixtures.js";
import { createExecutionHarness, scope, textInput } from "./fixtures/execution/harness.js";
import { completedTurn, deferred, eventBase, mapTurnOutputs } from "./fixtures/execution/provider.js";
import { hasCode } from "./fixtures/execution/store.js";

test("disabled, excluded, stale policy and stale exact target admissions make zero native calls", { timeout: 10_000 }, async (t) => {
  for (const scenario of ["disabled", "excluded", "policy", "target", "scope"] as const) {
    await t.test(scenario, async (st) => {
      const harness = await createExecutionHarness();
      st.after(() => harness.close());
      if (scenario === "disabled") harness.disablePolicy();
      if (scenario === "excluded") harness.setPolicy(enabledPolicy([{ exclusionId: "deny-model", providerKey: harness.target.providerKey, modelId: "fake-model" }]));
      if (scenario === "scope") harness.setScope({ ...scope, revision: 2 });
      const input = harness.spawnInput();
      const modified = scenario === "policy" ? { ...input, expectedPolicyRevision: 2 }
        : scenario === "target" ? { ...input, target: { ...input.target, sourceRevision: 2 } } : input;
      await assert.rejects(harness.client.spawn(modified), hasCode(scenario === "disabled" ? "delegation_disabled"
        : scenario === "excluded" ? "policy_denied" : scenario === "target" ? "stale_target" : "stale_revision"));
      assert.equal(harness.provider.contexts.length, 0);
      assert.equal(harness.provider.calls.turns.length, 0);
      assert.equal(harness.grants.length, 0);
    });
  }
});

test("admission replay precedes new dispatch policy but follows current result access", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, (input) => completedTurn(context, input.turnId)) };
  } } });
  t.after(() => harness.close());
  const input = harness.spawnInput();
  const receipt = await harness.client.spawn(input);
  assert.equal((await harness.client.wait({ taskId: receipt.taskId, timeoutMs: 1_000 })).status, "settled");
  harness.disablePolicy();
  assert.deepEqual(await harness.client.spawn(input), { ...receipt, duplicate: true });
  assert.equal(harness.provider.calls.turns.length, 1);
  await assert.rejects(harness.client.spawn({ ...input, input: { parts: [{ type: "text", text: "Conflicting payload" }] } }), hasCode("operation_conflict"));
  harness.denyResultAccess();
  await assert.rejects(harness.client.spawn(input), /Result access revoked/u);
});

test("same operation identifier is independent in another trusted parent scope", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, (input) => completedTurn(context, input.turnId)) };
  } } });
  t.after(() => harness.close());
  const input = harness.spawnInput();
  const first = await harness.client.spawn(input);
  const otherScope = { parentId: "other-parent", scopeId: "other-scope", revision: 1 };
  harness.setScope(otherScope);
  const other = await harness.coordinator.bindParent({ scope: otherScope });
  const second = await other.spawn(input);
  assert.notEqual(second.taskId, first.taskId);
  assert.equal(second.duplicate, false);
  await assert.rejects(harness.client.inspect({ taskId: second.taskId }), hasCode("policy_denied"));
});

test("policy revoked after opening is rechecked before the first provider turn", { timeout: 10_000 }, async (t) => {
  const entered = deferred<void>();
  const open = deferred<void>();
  const harness = await createExecutionHarness({ provider: { beforeOpen() { entered.resolve(); return open.promise; } } });
  t.after(() => harness.close());
  const receipt = await harness.spawn();
  await entered.promise;
  harness.disablePolicy();
  open.resolve();
  const settled = await harness.client.wait({ taskId: receipt.taskId, timeoutMs: 1_000 });
  assert.equal(settled.status, "settled");
  assert.equal(harness.provider.calls.turns.length, 0);
  assert.equal(harness.provider.calls.close, 1);
  assert.equal(harness.resourceReleases(), 1);
});

test("registry disposal during awaited readiness rejects opening before any native session exists", { timeout: 10_000 }, async (t) => {
  const entered = deferred<void>();
  const ready = deferred<void>();
  const harness = await createExecutionHarness({ provider: { beforeReadiness() { entered.resolve(); return ready.promise; } } });
  t.after(async () => { ready.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await entered.promise;
  await harness.registry.dispose();
  ready.resolve();
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(harness.provider.contexts.length, 0);
  assert.equal(harness.provider.calls.turns.length, 0);
  assert.equal(settled.task.runs.items[0]?.outcome?.kind, "failed");
  assert.equal(harness.resourceReleases(), 1);
  assert.equal(harness.grantReleases(), 1);
});

test("non-collect delivery is rejected before task admission in MS004", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness();
  t.after(() => harness.close());
  for (const completionPolicy of ["next_turn", "automatic"] as const) {
    await assert.rejects(harness.client.spawn({ ...harness.spawnInput(), completionPolicy }), hasCode("unsupported_operation"));
  }
  const capacity = await harness.store.read({ kind: "capacity" });
  assert.equal(capacity.kind, "capacity");
  assert.equal(capacity.capacity.tasks, 0);
  assert.equal(harness.provider.contexts.length, 0);
});

test("a settled or foreign ancestor cannot grant descendant execution authority", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, (input) => completedTurn(context, input.turnId)) };
  } } });
  t.after(() => harness.close());
  const receipt = await harness.spawn();
  await harness.client.wait({ taskId: receipt.taskId, timeoutMs: 1_000 });
  for (const ancestor of [{ taskId: receipt.taskId, runId: receipt.runId }, { taskId: randomUUID(), runId: randomUUID() }]) {
    await assert.rejects(harness.coordinator.bindParent({ scope, ancestor }));
  }
  assert.equal(harness.provider.calls.turns.length, 1);
});

test("live descendants retain the ancestor ceiling, enforce depth and fence origin-only queued revisions", { timeout: 10_000 }, async (t) => {
  const parentFinish = deferred<void>();
  const childFinish = deferred<void>();
  const parentEntered = deferred<void>();
  const childEntered = deferred<void>();
  const childBinding = deferred<DelegationClient>();
  const childScope = { ...scope, parentId: "child-parent" };
  let originPolicy = enabledPolicy([], explicitSelection("standard"));
  let changeOriginOnSteer = false;
  let turns = 0;
  const harness: Awaited<ReturnType<typeof createExecutionHarness>> = await createExecutionHarness({ limits: { maxActiveRuns: 2 },
    store(store) { return { ...store, async commit(command) {
      const receipt = await store.commit(command);
      if (changeOriginOnSteer && command.kind === "dispatch_intent" && command.operationKind === "steer") {
        changeOriginOnSteer = false;
        originPolicy = { ...enabledPolicy(), revision: 3 };
      }
      return receipt;
    } }; },
    targets(primary) { return [primary, makeTarget("expanded", { instanceId: primary.instanceId, providerKey: primary.providerKey })]; },
    policyForScope(requested, current) { return { ...current, scope: requested, policy: requested.parentId === scope.parentId ? originPolicy : enabledPolicy() }; },
    host(base) { return { async acquireChildResources(input) {
      const resources = await base.acquireChildResources(input);
      if (input.scope.parentId === scope.parentId) childBinding.resolve(await harness.coordinator.bindParent({ scope: childScope, ancestor: { taskId: input.task.taskId, runId: input.run.runId } }));
      return resources;
    } }; },
    provider: { transformSession(session, context) { return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
      turns += 1;
      const isParent = turns === 1;
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.started", payload: {} });
      (isParent ? parentEntered : childEntered).resolve();
      await (isParent ? parentFinish : childFinish).promise;
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.completed", payload: { outcome: "completed" } });
    }) }; } },
  });
  t.after(async () => { parentFinish.resolve(); childFinish.resolve(); await harness.close(); });
  const parentReceipt = await harness.spawn();
  await parentEntered.promise;
  const descendant = await childBinding.promise;
  const first = await descendant.spawn(harness.spawnInput());
  await childEntered.promise;
  assert.equal((await descendant.inspect({ taskId: first.taskId })).task.depth, 2);
  const grandchild = await harness.coordinator.bindParent({ scope: { ...scope, parentId: "grandchild-parent" }, ancestor: { taskId: first.taskId, runId: first.runId } });
  await assert.rejects(grandchild.spawn(harness.spawnInput()), hasCode("capacity_exceeded"));
  originPolicy = { ...enabledPolicy(), revision: 2 };
  await assert.rejects(descendant.spawn({ ...harness.spawnInput(), target: harness.catalog.targets[1]!.reference }), hasCode("policy_denied"));
  const steeringInput = { operationId: randomUUID(), taskId: first.taskId, mode: "steer" as const,
    input: textInput(), target: harness.target.reference, expectedPolicyRevision: 1 };
  assert.equal((await descendant.send(steeringInput)).status, "delivered");
  const queued = await descendant.spawn(harness.spawnInput());
  assert.equal((await descendant.inspect({ taskId: queued.taskId })).runs.items[0]?.phase, "queued");
  changeOriginOnSteer = true;
  const steering = await descendant.send({ ...steeringInput, operationId: randomUUID() });
  assert.equal(steering.status, "rejected");
  assert.equal(changeOriginOnSteer, false);
  assert.equal(harness.provider.fake.snapshot().steeringInputs.length, 1);
  assert.equal((await descendant.inspect({ taskId: first.taskId })).runs.items[0]?.phase, "running");
  childFinish.resolve();
  const rejected = await descendant.wait({ taskId: queued.taskId, timeoutMs: 1_000 });
  assert.equal(rejected.status, "settled");
  assert.equal(rejected.task.runs.items[0]?.outcome?.kind, "failed");
  assert.equal(harness.provider.calls.turns.length, 2);
  assert.equal((await descendant.wait({ taskId: first.taskId, timeoutMs: 1_000 })).task.runs.items[0]?.outcome?.kind, "succeeded");
  assert.equal((await harness.client.inspect({ taskId: parentReceipt.taskId })).runs.items[0]?.phase, "running");
  parentFinish.resolve();
  assert.equal((await harness.client.wait({ taskId: parentReceipt.taskId, timeoutMs: 1_000 })).status, "settled");
});
