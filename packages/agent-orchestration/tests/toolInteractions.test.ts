// ------------------------------------------------------------------------------------------------
//                toolInteractions.test.ts - Tool receipts preserve steering and continuation truth
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAgentEventOutput } from "@agen-ai/agent-runtime";
import { createDelegationHostBinding, type DelegationAdmissionReceipt, type DelegationSendReceipt } from "../src/index.js";
import { waitFor } from "./fixtures/execution/harness.js";
import { completedTurn, deferred, eventBase, mapTurnOutputs } from "./fixtures/execution/provider.js";
import { assertToolError, createToolHarness, toolValue } from "./fixtures/tools/harness.js";

for (const uncertain of [false, true]) test(`tool steering reports ${uncertain ? "uncertainty without replay" : "delivery separately from a queued next turn"}`, { timeout: 10_000 }, async (t) => {
  const entered = deferred<void>();
  const finish = deferred<void>();
  let turns = 0;
  const harness = await createToolHarness({ allowContinuation: true, provider: { transformSession(session, context) {
    const steering = session.steering;
    assert.equal(steering.kind, "supported");
    if (steering.kind !== "supported") throw new Error("The existing fake must support steering.");
    return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
      turns += 1;
      if (turns > 1) { yield* completedTurn(context, input.turnId); return; }
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.started", payload: {} });
      entered.resolve();
      await finish.promise;
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.completed", payload: { outcome: "completed" } });
    }), steering: { kind: "supported", async steerTurn(input) {
      const result = await steering.steerTurn(input);
      return uncertain ? { status: "delivery_uncertain", error: { code: "transport_lost", message: "private-native-diagnostic", category: "unknown", recovery: { kind: "unknown" } } } : result;
    } } };
  } } });
  t.after(async () => { finish.resolve(); await harness.close(); });
  const binding = await createDelegationHostBinding({ client: harness.client });
  assert.ok(binding);
  const parent = await harness.mount(binding);
  const admitted = toolValue<DelegationAdmissionReceipt>(await parent.invoke("delegate_task", {
    operationId: randomUUID(), target: harness.target.reference, expectedPolicyRevision: 1, prompt: "Perform the first turn.",
  }));
  await entered.promise;
  const send = { operationId: randomUUID(), taskId: admitted.taskId, mode: "steer", target: harness.target.reference,
    expectedPolicyRevision: 1, message: "Refine the current turn." };
  const receipt = toolValue<DelegationSendReceipt>(await parent.invoke("task_send", send));
  assert.equal(receipt.status, uncertain ? "delivery_uncertain" : "delivered");
  assert.deepEqual(toolValue(await parent.invoke("task_send", send)), { ...receipt, duplicate: true });
  assert.equal(harness.provider.fake.snapshot().steeringInputs.length, 1);
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal(JSON.stringify(receipt).includes("private-native-diagnostic"), false);
  if (!uncertain) {
    const queued = toolValue<DelegationSendReceipt>(await parent.invoke("task_send", { ...send, operationId: randomUUID(), mode: "next_turn", message: "Continue at the next boundary." }));
    assert.equal(queued.status, "queued");
    assert.equal(harness.provider.calls.turns.length, 1);
    finish.resolve();
    await waitFor(async () => (await harness.client.inspect({ taskId: admitted.taskId })).runs.items.filter((run) => run.phase === "settled").length === 2,
      "The explicit queued turn should run after the original terminal boundary.");
    assert.equal(harness.provider.fake.snapshot().resumedSessionIds.length, 1);
  } else {
    finish.resolve();
    const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
    assert.equal(settled.task.runs.items[0]?.outcome?.kind, "recovery_required");
    assertToolError(await parent.invoke("task_send", { ...send, operationId: randomUUID(), mode: "follow_up" }), "recovery_required");
    assert.equal(harness.provider.calls.turns.length, 1);
  }
});
