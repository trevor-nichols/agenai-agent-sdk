// ------------------------------------------------------------------------------------------------
//                toolPagination.test.ts - Complete target and result pages inside tool byte budgets
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAgentEventOutput } from "@agen-ai/agent-runtime";
import { createDelegationHostBinding, type DelegationAdmissionReceipt, type DelegationTargetReference, type DelegationToolTargetPage, type DelegationToolTaskStatus } from "../src/index.js";
import { eventBase, mapTurnOutputs } from "./fixtures/execution/provider.js";
import { createToolHarness, toolValue } from "./fixtures/tools/harness.js";

test("large effective target catalogs resume through complete pages within the tool envelope", async (t) => {
  const harness = await createToolHarness({ targets(primary) { return Array.from({ length: 30 }, (_, index) => ({ ...primary,
    reference: { ...primary.reference, targetId: `target-${index}` }, label: `Target ${index} ${"界".repeat(150)}`,
    options: Array.from({ length: 20 }, (_, option) => ({ key: `${option}-${"k".repeat(80)}`, optionId: "v".repeat(80) })),
  })); } });
  t.after(() => harness.close());
  const binding = await createDelegationHostBinding({ client: harness.client });
  assert.ok(binding);
  const parent = await harness.mount(binding);
  const references: DelegationTargetReference[] = [];
  let cursor: string | undefined;
  do {
    const page = toolValue<DelegationToolTargetPage>(
      await parent.invoke("delegation_targets", { limit: 100, ...(cursor === undefined ? {} : { cursor }) }));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 24 * 1_024);
    assert.equal(page.policyRevision, 1);
    assert.ok(page.targets.length > 0);
    assert.equal(page.emptyReason, undefined);
    references.push(...page.targets.map((target) => target.reference));
    cursor = page.cursor;
  } while (cursor !== undefined);
  assert.deepEqual(references, harness.catalog.targets.map((target) => target.reference));
  assert.equal(harness.provider.calls.turns.length, 0);
});

test("escaped final results paginate without truncating authoritative task state or losing earlier outcomes", { timeout: 10_000 }, async (t) => {
  const harness = await createToolHarness({ allowContinuation: true, provider: { transformSession(session, context) { return { ...session,
    startTurn: mapTurnOutputs(session, async function* (input) {
      const base = eventBase(context, input.turnId);
      yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
      yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId: "answer", itemKind: "assistant_message", status: "in_progress" } });
      yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId: "answer", streamKind: "assistant_text", delta: "\"\\\n界".repeat(1_000) } });
      yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { structuredOutput: { kind: 'not_requested' }, outcome: "completed" } });
    }),
  }; } } });
  t.after(() => harness.close());
  const binding = await createDelegationHostBinding({ client: harness.client });
  assert.ok(binding);
  const parent = await harness.mount(binding);
  const admitted = toolValue<DelegationAdmissionReceipt>(await parent.invoke("delegate_task", {
    operationId: randomUUID(), target: harness.target.reference, expectedPolicyRevision: 1, prompt: "Produce the first result.",
  }));
  await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  for (let index = 1; index < 4; index += 1) {
    toolValue(await parent.invoke("task_send", { operationId: randomUUID(), taskId: admitted.taskId, mode: "follow_up",
      target: harness.target.reference, expectedPolicyRevision: 1, message: `Produce result ${index}.` }));
    await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  }
  const direct = await harness.client.inspect({ taskId: admitted.taskId });
  const outcomes: { runId: string; outcome: unknown }[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = toolValue<DelegationToolTaskStatus>(await parent.invoke("task_status", { taskId: admitted.taskId, limit: 100, ...(cursor === undefined ? {} : { runsCursor: cursor }) }));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 24 * 1_024);
    assert.deepEqual(page.task, { storeId: direct.task.storeId, taskId: direct.task.taskId, state: "settled", revision: direct.task.revision,
      latestRunId: direct.task.latestRunId, runCount: 4, completionPolicy: direct.task.completionPolicy });
    outcomes.push(...page.runs.items.map(({ runId, outcome }) => ({ runId, outcome })));
    cursor = page.runs.cursor;
    pages += 1;
  } while (cursor !== undefined);
  assert.ok(pages > 1, "The escaped results must exercise byte-limited continuation pages.");
  assert.deepEqual(outcomes, direct.runs.items.map(({ runId, outcome }) => ({ runId, outcome })));
});
