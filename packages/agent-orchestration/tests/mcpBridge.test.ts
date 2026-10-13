// ------------------------------------------------------------------------------------------------
//                mcpBridge.test.ts - Actual discovery, scoped credentials and callback quiescence
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseAgentError } from "@agen-ai/agent-protocol";
import { createAgentEventOutput } from "@agen-ai/agent-runtime";
import { createDelegationHostBinding, type DelegationAdmissionReceipt, type DelegationToolTargetPage, type DelegationToolTaskStatus } from "../src/index.js";
import { startDelegationMcpBridge } from "../src/mcp/index.js";
import { scope, waitFor } from "./fixtures/execution/harness.js";
import { deferred, mapTurnOutputs } from "./fixtures/execution/provider.js";
import { hasCode } from "./fixtures/execution/store.js";
import { assertToolError, createToolHarness, toolValue } from "./fixtures/tools/harness.js";
import { connectMcp } from "./fixtures/tools/mcp.js";

test("real MCP initialization, discovery and invocation keep tokens and parent task authority separate", { timeout: 10_000 }, async (t) => {
  const error = parseAgentError({ category: "quota_exhausted", code: "allowance_exhausted", message: "The child allowance is exhausted.", recovery: { kind: "wait_for_quota" } });
  const harness = await createToolHarness({ policyForScope(requested, current) { return { ...current, scope: requested }; },
    provider: { transformSession(session) { return { ...session, startTurn: mapTurnOutputs(session, async function* (input, outputs) {
      for await (const output of outputs) yield output.kind === "event" && output.event.type === "turn.completed"
        ? createAgentEventOutput({ ...output.event, payload: { outcome: "failed", error } }) : output;
    }) }; } },
  });
  const other = await harness.coordinator.bindParent({ scope: { ...scope, parentId: "other-parent" } });
  const firstBinding = await createDelegationHostBinding({ client: harness.client, nativeToolNames: ["native_delegate"] });
  const secondBinding = await createDelegationHostBinding({ client: other });
  assert.ok(firstBinding && secondBinding);
  const aParent = await harness.mount(firstBinding);
  const bParent = await harness.mount(secondBinding);
  assert.ok(aParent.binding && bParent.binding);
  const a = await connectMcp(aParent.binding);
  const b = await connectMcp(bParent.binding);
  t.after(async () => { await a.close(); await b.close(); await harness.close(); });
  assert.equal(new URL(a.bridge.server.url).hostname, "127.0.0.1");
  assert.notEqual(a.bridge.server.headers.Authorization, b.bridge.server.headers.Authorization);
  assert.equal(a.client.getInstructions(), firstBinding.instructions?.text);
  const discovered = await a.client.listTools();
  assert.deepEqual(discovered.tools.map((tool) => tool.name), firstBinding.tools.map((tool) => tool.name));
  const targets = toolValue<DelegationToolTargetPage>(await a.call("delegation_targets", {}));
  assert.deepEqual(targets.targets.map((target) => target.reference), [harness.target.reference]);
  const admitted = toolValue<DelegationAdmissionReceipt>(await a.call("delegate_task", { operationId: randomUUID(),
    target: targets.targets[0]!.reference, expectedPolicyRevision: targets.policyRevision, prompt: "Use the scoped MCP path." }));
  await waitFor(() => harness.requests.length === 1, "The MCP-admitted child should reach its host request boundary.");
  const status = toolValue<DelegationToolTaskStatus>(await a.call("task_status", { taskId: admitted.taskId }));
  assert.equal(status.runs.items[0]?.phase, "waiting");
  assertToolError(await b.call("task_status", { taskId: admitted.taskId }), "policy_denied");
  const crossToken = await fetch(b.bridge.server.url, { method: "POST", headers: { ...a.bridge.server.headers,
    "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "task_cancel", arguments: { operationId: randomUUID(), taskId: admitted.taskId } },
  }) });
  assert.equal(crossToken.status, 401);
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  assert.equal(harness.provider.calls.turns.length, 1);
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected the fake approval request.");
  await harness.coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval", requestId: request.request.requestId, disposition: "selected", optionId: request.request.options[0]!.optionId,
  } });
  const completed = toolValue<DelegationToolTaskStatus>(await a.call("task_status", { taskId: admitted.taskId, waitMs: 1_000 }));
  assert.deepEqual(completed.runs.items[0]?.outcome, { kind: "failed", error });
  const callback = toolValue<DelegationToolTaskStatus>(await aParent.invoke("task_status", { taskId: admitted.taskId }));
  assert.deepEqual(callback.runs.items[0]?.outcome, completed.runs.items[0]?.outcome);
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal(harness.provider.calls.resolutions.length, 1);
});

for (const blocked of [false, true]) test(`MCP release ${blocked ? "retains a blocked callback for cleanup retry" : "quiesces an in-flight wait"} without canceling the child`, { timeout: 10_000 }, async (t) => {
  const entered = deferred<void>();
  const finish = deferred<void>();
  let waitsSettled = 0;
  let bindingReleases = 0;
  const harness = await createToolHarness({ limits: { maxWaitMs: 2_000 } });
  const binding = await createDelegationHostBinding({ client: { ...harness.client, async wait(input) {
    entered.resolve();
    try { if (blocked) await finish.promise; return await harness.client.wait(input); }
    finally { waitsSettled += 1; }
  } } });
  assert.ok(binding);
  const parent = await harness.mount({ ...binding, async release() { bindingReleases += 1; await binding.release(); } });
  assert.ok(parent.binding);
  const connection = await connectMcp(parent.binding, { shutdownTimeoutMs: 50 });
  t.after(async () => { finish.resolve(); await connection.close(); await harness.close(); });
  const admitted = toolValue<DelegationAdmissionReceipt>(await connection.call("delegate_task", { operationId: randomUUID(),
    target: harness.target.reference, expectedPolicyRevision: 1, prompt: "Keep working after transport cleanup." }));
  await waitFor(() => harness.requests.length === 1, "The owned child should be waiting before transport shutdown.");
  const pending = connection.client.callTool({ name: "task_status", arguments: { taskId: admitted.taskId, waitMs: 2_000 } }).then(
    () => "returned", () => "disconnected",
  );
  await entered.promise;
  if (blocked) {
    await assert.rejects(startDelegationMcpBridge({ binding: parent.binding }), TypeError);
    await assert.rejects(connection.bridge.release(), hasCode("recovery_required"));
    await assert.rejects(startDelegationMcpBridge({ binding: parent.binding }), TypeError);
    assert.equal(waitsSettled, 0);
    assert.equal(bindingReleases, 0);
    finish.resolve();
    await waitFor(() => waitsSettled === 1, "The retained callback should actually settle before cleanup retry.");
  }
  await connection.bridge.release();
  await pending;
  assert.equal(waitsSettled, 1);
  assert.equal(bindingReleases, 0, "The bridge must leave binding release to its runtime owner.");
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.phase, "waiting");
  await assert.rejects(fetch(connection.bridge.server.url, { headers: connection.bridge.server.headers }));
  if (blocked) {
    const replacement = await connectMcp(parent.binding);
    try {
      assert.notEqual(replacement.bridge.server.headers.Authorization, connection.bridge.server.headers.Authorization);
      toolValue(await replacement.call("task_status", { taskId: admitted.taskId }));
    } finally { await replacement.close(); }
  }
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected the fake approval request.");
  await harness.coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval", requestId: request.request.requestId, disposition: "selected", optionId: request.request.options[0]!.optionId,
  } });
  assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 })).status, "settled");
  await parent.session.close({ reason: "shutdown" });
  assert.equal(bindingReleases, 1);
});
