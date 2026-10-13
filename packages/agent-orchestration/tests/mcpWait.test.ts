// ------------------------------------------------------------------------------------------------
//                mcpWait.test.ts - Advertised bounded waits survive transport response deadlines
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createDelegationHostBinding, type DelegationAdmissionReceipt } from "../src/index.js";
import { waitFor } from "./fixtures/execution/harness.js";
import { deferred } from "./fixtures/execution/provider.js";
import { createToolHarness, toolValue } from "./fixtures/tools/harness.js";
import { connectMcp } from "./fixtures/tools/mcp.js";

test("an advertised default status wait remains connected beyond ten seconds until transport release", { timeout: 25_000 }, async (t) => {
  const entered = deferred<void>();
  const harness = await createToolHarness();
  const binding = await createDelegationHostBinding({ client: { ...harness.client, wait(input) {
    entered.resolve();
    return harness.client.wait(input);
  } } });
  assert.ok(binding);
  const parent = await harness.mount(binding);
  assert.ok(parent.binding);
  const connection = await connectMcp(parent.binding);
  t.after(async () => { await connection.close(); await harness.close(); });
  const admitted = toolValue<DelegationAdmissionReceipt>(await connection.call("delegate_task", { operationId: randomUUID(),
    target: harness.target.reference, expectedPolicyRevision: 1, prompt: "Remain waiting for the host." }));
  await waitFor(() => harness.requests.length === 1, "The child must reach its actual waiting boundary.");
  let settled = false;
  const pending = connection.client.callTool({ name: "task_status", arguments: { taskId: admitted.taskId, waitMs: 30_000 } }).then(
    () => { settled = true; }, () => { settled = true; },
  );
  await entered.promise;
  await setTimeout(10_150);
  assert.equal(settled, false, "The bridge must support the wait duration advertised by its tool schema.");
  await connection.bridge.release();
  await pending;
  assert.equal(settled, true);
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
});
