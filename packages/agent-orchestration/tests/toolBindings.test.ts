// ------------------------------------------------------------------------------------------------
//                toolBindings.test.ts - Scoped tool admission, cached policy and waiting visibility
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AgentProviderContractError } from "@agen-ai/agent-runtime";
import { createDelegationHostBinding, type DelegationAdmissionReceipt, type DelegationCancelReceipt, type DelegationToolTargetPage, type DelegationToolTaskStatus } from "../src/index.js";
import { enabledPolicy, explicitSelection, makeTarget } from "./fixtures.js";
import { scope, waitFor } from "./fixtures/execution/harness.js";
import { deferred } from "./fixtures/execution/provider.js";
import { assertToolError, createToolHarness, toolValue } from "./fixtures/tools/harness.js";

test("disabled parents receive no binding while enabled empty selections retain their scoped tools", async (t) => {
  const harness = await createToolHarness();
  t.after(() => harness.close());
  harness.disablePolicy();
  const disabled = await createDelegationHostBinding({ client: harness.client });
  assert.equal(disabled, undefined);
  assert.equal((await harness.mount(disabled)).binding, undefined);
  harness.setPolicy({ ...enabledPolicy([], explicitSelection()), revision: 3 });
  const binding = await createDelegationHostBinding({ client: harness.client });
  assert.ok(binding);
  const parent = await harness.mount(binding);
  const choices = toolValue<DelegationToolTargetPage>(await parent.invoke("delegation_targets", {}));
  assert.equal(choices.policyRevision, 3);
  assert.deepEqual(choices.targets, []);
  assert.equal(choices.emptyReason, "no_permitted_targets");
  const denied = await parent.invoke("delegate_task", { operationId: randomUUID(), target: harness.target.reference,
    expectedPolicyRevision: 3, prompt: "No target has been selected." });
  assertToolError(denied, "policy_denied");
  assert.equal(harness.provider.calls.turns.length, 0);
});

test("discovery exposes only effective targets and guidance names only host-certified native tools", async (t) => {
  const harness = await createToolHarness({ targets(primary) { return [primary,
    makeTarget("unselected"), makeTarget("unavailable", { availability: { kind: "unavailable", code: "signed_out", reason: "Account unavailable." } }),
  ]; } });
  t.after(() => harness.close());
  harness.setPolicy(enabledPolicy([], explicitSelection("standard", "unavailable")));
  const nativeToolNames = Object.freeze(["native_delegate"]);
  const binding = await createDelegationHostBinding({ client: harness.client, nativeToolNames, instructionPlacement: "developer" });
  assert.ok(binding);
  assert.equal(binding.instructions?.placement, "developer");
  assert.ok(binding.instructions?.text.includes("native_delegate"));
  const parent = await harness.mount(binding);
  const page = toolValue<DelegationToolTargetPage>(await parent.invoke("delegation_targets", {}));
  assert.deepEqual(page.targets.map((target) => target.reference), [harness.target.reference]);
  for (const target of page.targets) for (const field of ["application", "certification", "instanceId"]) assert.equal(field in target, false);
  const withoutNative = await createDelegationHostBinding({ client: harness.client });
  assert.ok(withoutNative);
  assert.equal(withoutNative.instructions?.text.includes("native_delegate"), false);
  await withoutNative.release();
  await assert.rejects(createDelegationHostBinding({ client: harness.client, nativeToolNames: ["delegate_task"] }), TypeError);
  await assert.rejects(createDelegationHostBinding({ client: harness.client, nativeToolNames: new Array<string>(1) }), TypeError);
});

test("closed tool arguments reject authority injection and malformed inputs before any child starts", async (t) => {
  const harness = await createToolHarness();
  t.after(() => harness.close());
  const binding = await createDelegationHostBinding({ client: harness.client });
  assert.ok(binding);
  const parent = await harness.mount(binding);
  const valid = { operationId: randomUUID(), target: harness.target.reference, expectedPolicyRevision: 1, prompt: "Do bounded work." };
  for (const args of [
    { ...valid, parentId: "another-parent" }, { ...valid, executable: "/outside/agent" },
    { ...valid, operationId: "not-an-operation-id" }, { ...valid, completionPolicy: "unknown" },
    { ...valid, prompt: "x".repeat(16_001) }, { ...valid, context: "x".repeat(32_769) },
  ]) {
    await assert.rejects(parent.invoke("delegate_task", args), (error: unknown) => error instanceof AgentProviderContractError && error.code === "host_tool_input_invalid");
  }
  await assert.rejects(parent.invoke("task_status", { taskId: randomUUID(), waitMs: 30_001 }),
    (error: unknown) => error instanceof AgentProviderContractError && error.code === "host_tool_input_invalid");
  assertToolError(await parent.invoke("delegate_task", { ...valid, prompt: "p".repeat(9_000), context: "c".repeat(9_000) }), "capacity_exceeded");
  assert.equal(harness.provider.calls.turns.length, 0);
  const capacity = await harness.store.read({ kind: "capacity" });
  assert.equal(capacity.kind, "capacity");
  assert.equal(capacity.capacity.tasks, 0);
});

test("cached tools deny new execution after disablement but retain bounded waiting status and cancellation", async (t) => {
  const harness = await createToolHarness();
  t.after(() => harness.close());
  const waitEntered = deferred<void>();
  const binding = await createDelegationHostBinding({ client: { ...harness.client, wait(input) {
    waitEntered.resolve();
    return harness.client.wait(input);
  } } });
  assert.ok(binding);
  const parent = await harness.mount(binding);
  const spawn = { operationId: randomUUID(), target: harness.target.reference, expectedPolicyRevision: 1, prompt: "Pause for host approval." };
  const admitted = toolValue<DelegationAdmissionReceipt>(await parent.invoke("delegate_task", spawn));
  await waitFor(() => harness.requests.length === 1, "The child should reach its host-only approval boundary.");
  const cancellation = new AbortController();
  const pendingWait = parent.invoke("task_status", { taskId: admitted.taskId, waitMs: 1_000 }, cancellation.signal);
  await waitEntered.promise;
  cancellation.abort(new Error("private-caller-cancellation-reason"));
  const canceledWait = await pendingWait;
  assertToolError(canceledWait, "operation_aborted");
  assert.equal(JSON.stringify(canceledWait).includes("private-caller-cancellation-reason"), false);
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  harness.setPolicy({ ...enabledPolicy(), revision: 2 });
  assertToolError(await parent.invoke("delegate_task", { ...spawn, operationId: randomUUID() }), "stale_revision");
  assertToolError(await parent.invoke("task_send", { operationId: randomUUID(), taskId: admitted.taskId, mode: "steer",
    target: harness.target.reference, expectedPolicyRevision: 1, message: "Use a stale policy snapshot." }), "stale_revision");
  harness.disablePolicy();
  const disabledChoices = toolValue<DelegationToolTargetPage>(await parent.invoke("delegation_targets", {}));
  assert.deepEqual(disabledChoices.targets, []);
  assert.equal(disabledChoices.emptyReason, "delegation_disabled");
  assertToolError(await parent.invoke("delegate_task", { ...spawn, operationId: randomUUID(), expectedPolicyRevision: 3 }), "delegation_disabled");
  assertToolError(await parent.invoke("task_send", { operationId: randomUUID(), taskId: admitted.taskId, mode: "steer",
    target: harness.target.reference, expectedPolicyRevision: 3, message: "Continue." }), "delegation_disabled");
  const result = await parent.invoke("task_status", { taskId: admitted.taskId, waitMs: 1 });
  const status = toolValue<DelegationToolTaskStatus>(result);
  assert.equal(status.waitStatus, "timeout");
  assert.equal(status.runs.items[0]?.phase, "waiting");
  const pendingRequest = status.runs.items[0]?.pendingRequest;
  assert.ok(pendingRequest);
  assert.equal(pendingRequest.requestKind, "approval");
  for (const field of ["requestId", "handle", "prompt", "options", "requestContext"]) assert.equal(field in pendingRequest, false);
  assert.equal(JSON.stringify(result).includes(harness.requests[0]!.request.requestId), false);
  assert.equal(harness.provider.calls.resolutions.length, 0);
  const cancelInput = { operationId: randomUUID(), taskId: admitted.taskId };
  const canceled = toolValue<DelegationCancelReceipt>(await parent.invoke("task_cancel", cancelInput));
  assert.ok(canceled.status === "requested" || canceled.status === "confirmed");
  await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  const confirmed = toolValue<DelegationCancelReceipt>(await parent.invoke("task_cancel", cancelInput));
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.duplicate, true);
  assert.equal(harness.provider.calls.turns.length, 1);
});

test("two parent bindings cannot inspect, send to or cancel each other's task identifiers", async (t) => {
  const harness = await createToolHarness({ policyForScope(requested, current) { return { ...current, scope: requested }; } });
  t.after(() => harness.close());
  const first = await createDelegationHostBinding({ client: harness.client });
  const otherClient = await harness.coordinator.bindParent({ scope: { ...scope, parentId: "other-parent" } });
  const second = await createDelegationHostBinding({ client: otherClient });
  assert.ok(first && second);
  const a = await harness.mount(first);
  const b = await harness.mount(second);
  const admitted = toolValue<DelegationAdmissionReceipt>(await a.invoke("delegate_task", {
    operationId: randomUUID(), target: harness.target.reference, expectedPolicyRevision: 1, prompt: "Owned by the first parent.",
  }));
  await waitFor(() => harness.requests.length === 1, "The first parent's child should remain waiting.");
  assertToolError(await b.invoke("task_status", { taskId: admitted.taskId }), "policy_denied");
  assertToolError(await b.invoke("task_send", { operationId: randomUUID(), taskId: admitted.taskId, mode: "steer",
    target: harness.target.reference, expectedPolicyRevision: 1, message: "Foreign steering." }), "request_unavailable");
  assertToolError(await b.invoke("task_cancel", { operationId: randomUUID(), taskId: admitted.taskId }), "request_unavailable");
  assert.equal(harness.provider.fake.snapshot().steeringInputs.length, 0);
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.phase, "waiting");
});
