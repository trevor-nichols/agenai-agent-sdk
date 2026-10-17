// ------------------------------------------------------------------------------------------------
//                executionWithdrawal.test.ts - Request retirement independent of entered answers
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseAgentApprovalRequest, parseAgentError } from "@agen-ai/agent-protocol";
import { createAgentEventOutput, type AgentRequestResolutionResult } from "@agen-ai/agent-runtime";
import { createExecutionHarness, waitFor } from "./fixtures/execution/harness.js";
import { deferred, eventBase } from "./fixtures/execution/provider.js";
import { hasCode } from "./fixtures/execution/store.js";

for (const lateStatus of ["delivered", "rejected"] as const) test(`retired A preserves its late ${lateStatus} receipt while B answers and cleanup joins actual work`, { timeout: 10_000 }, async (t) => {
  const retire = deferred<void>();
  const finish = deferred<void>();
  const firstEntered = deferred<void>();
  const firstReceipt = deferred<AgentRequestResolutionResult>();
  const callbackFinished = deferred<void>();
  const closeEntered = deferred<void>();
  const first = parseAgentApprovalRequest({ requestKind: "approval", requestId: "withdrawal:A", prompt: "Approve A?",
    subject: { kind: "other", title: "A", itemId: "withdrawal-work" }, options: [{ optionId: "allow", label: "Allow", decision: "approved",
      consequence: { kind: "scoped", persistence: "once", scope: { kind: "exact_action" } } }] });
  const second = parseAgentApprovalRequest({ ...first, requestId: "withdrawal:B", prompt: "Approve B?" });
  const signals: AbortSignal[] = [];
  const cooperative = lateStatus === "rejected";
  const harness = await createExecutionHarness({ host(base) { return { async onRequest(request) {
    base.onRequest(request);
    signals.push(request.signal);
    if (request.request.requestId !== first.requestId) return;
    if (cooperative) {
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    } else await callbackFinished.promise;
  } }; }, provider: { transformSession(session, context) { return { ...session,
    startTurn(input) {
      const base = eventBase(context, input.turnId);
      return { turnId: input.turnId, outputs: (async function* () {
        yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
        yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId: "withdrawal-work", itemKind: "dynamic_tool_call", status: "in_progress" } });
        yield createAgentEventOutput({ ...base, type: "request.opened", payload: { request: first } });
        await retire.promise;
        yield createAgentEventOutput({ ...base, type: "request.unavailable", payload: { requestId: first.requestId, reason: "withdrawn" } });
        yield createAgentEventOutput({ ...base, type: "request.opened", payload: { request: second } });
        await finish.promise;
        yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "completed" } });
      })(), async resolveRequest(response) {
        if (response.resolution.requestId === first.requestId) { firstEntered.resolve(); return firstReceipt.promise; }
        assert.equal(response.resolution.requestId, second.requestId);
        return { status: "delivered" as const };
      } };
    }, async close(input) { closeEntered.resolve(); await session.close(input); },
  }; } } });
  t.after(async () => { retire.resolve(); finish.resolve(); firstReceipt.resolve({ status: "delivered" }); callbackFinished.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "A must be presented before its answer enters.");
  const presentedA = harness.requests[0]!;
  const answerA = { handle: presentedA.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval" as const, requestId: first.requestId, disposition: "selected" as const, optionId: first.options[0]!.optionId,
  } };
  const answeringA = harness.coordinator.resolveRequest(answerA);
  await firstEntered.promise;
  retire.resolve();
  await waitFor(() => harness.requests.length === 2, "B must reach the host while retired A's actual answer is still unsettled.");
  assert.equal(signals[0]!.aborted, true);
  const presentedB = harness.requests[1]!;
  assert.equal(signals[1]!.aborted, false);
  assert.equal(harness.grants[0]!.signal.aborted, false);
  const active = (await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]!;
  assert.equal(active.phase, "waiting");
  assert.equal(active.pendingRequest?.requestId, second.requestId);
  await assert.rejects(harness.coordinator.resolveRequest({ ...answerA, operationId: randomUUID() }), hasCode("request_unavailable"));
  const duplicateA = harness.coordinator.resolveRequest(answerA);
  const answerB = { handle: presentedB.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval" as const, requestId: second.requestId, disposition: "selected" as const, optionId: second.options[0]!.optionId,
  } };
  assert.equal((await harness.coordinator.resolveRequest(answerB)).status, "delivered");
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.pendingRequest?.state, "resolved");
  finish.resolve();
  await closeEntered.promise;
  assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 10 })).status, "timeout");
  assert.equal(harness.resourceReleases(), 0);
  firstReceipt.resolve(lateStatus === "delivered" ? { status: "delivered" } : { status: "rejected", requestState: "pending",
    error: parseAgentError({ category: "provider", code: "declined", message: "The entered answer was refused.", recovery: { kind: "none" } }) });
  const receiptA = await answeringA;
  assert.equal(receiptA.status, lateStatus);
  if (receiptA.status === "rejected") assert.equal(receiptA.requestState, "pending");
  assert.deepEqual(await duplicateA, { ...receiptA, duplicate: true });
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.pendingRequest?.requestId, second.requestId);
  if (!cooperative) {
    assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 10 })).status, "timeout");
    assert.equal(harness.resourceReleases(), 0);
    callbackFinished.resolve();
  }
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(settled.task.runs.items[0]?.outcome?.kind, "succeeded");
  assert.equal(settled.task.runs.items[0]?.pendingRequest?.state, "unavailable");
  const retainedA = await harness.store.read({ kind: "operation", parent: settled.task.task.parent, operationId: answerA.operationId });
  assert.equal(retainedA.kind, "operation");
  assert.equal(retainedA.operation?.disposition, lateStatus);
  assert.deepEqual(retainedA.operation?.request, { requestId: first.requestId, requestKind: "approval" });
  const observations = await harness.store.read({ kind: "observations", taskId: admitted.taskId, runId: admitted.runId });
  assert.equal(observations.kind, "observations");
  assert.deepEqual(observations.page.items.filter((observation) => observation.kind === "request").map((observation) => [observation.request?.requestId, observation.request?.state]),
    [[first.requestId, "waiting"], [first.requestId, "unavailable"], [second.requestId, "waiting"]]);
  assert.equal(harness.provider.calls.resolutions.length, 2);
  assert.equal(harness.provider.calls.streamOwners, 1);
  assert.equal(harness.provider.calls.close, 1);
  assert.equal(harness.resourceReleases(), 1);
  assert.equal(harness.grantReleases(), 1);
});

for (const retainedCallback of [false, true]) test(`canonical retirement after A delivered and B opened dismisses A's ${retainedCallback ? "outstanding callback" : "returned callback signal"}`, { timeout: 10_000 }, async (t) => {
  const answeredA = deferred<void>();
  const retireA = deferred<void>();
  const finish = deferred<void>();
  const presentationFinished = deferred<void>();
  const closeEntered = deferred<void>();
  const first = parseAgentApprovalRequest({ requestKind: "approval", requestId: "delivered:A", prompt: "Approve A?",
    subject: { kind: "other", title: "A", itemId: "delivered-work" }, options: [{ optionId: "allow", label: "Allow", decision: "approved",
      consequence: { kind: "scoped", persistence: "once", scope: { kind: "exact_action" } } }] });
  const second = parseAgentApprovalRequest({ ...first, requestId: "delivered:B", prompt: "Approve B?" });
  const signals: AbortSignal[] = [];
  const harness = await createExecutionHarness({ host(base) { return { async onRequest(request) {
    base.onRequest(request);
    signals.push(request.signal);
    if (retainedCallback && request.request.requestId === first.requestId) await presentationFinished.promise;
  } }; }, provider: { transformSession(session, context) { return { ...session,
    startTurn(input) {
      const base = eventBase(context, input.turnId);
      return { turnId: input.turnId, outputs: (async function* () {
        yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
        yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId: "delivered-work", itemKind: "dynamic_tool_call", status: "in_progress" } });
        yield createAgentEventOutput({ ...base, type: "request.opened", payload: { request: first } });
        await answeredA.promise;
        yield createAgentEventOutput({ ...base, type: "request.opened", payload: { request: second } });
        await retireA.promise;
        yield createAgentEventOutput({ ...base, type: "request.unavailable", payload: { requestId: first.requestId, reason: "withdrawn" } });
        await finish.promise;
        yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "completed" } });
      })(), async resolveRequest(response) {
        if (response.resolution.requestId === first.requestId) answeredA.resolve();
        else assert.equal(response.resolution.requestId, second.requestId);
        return { status: "delivered" as const };
      } };
    }, async close(input) { closeEntered.resolve(); await session.close(input); },
  }; } } });
  t.after(async () => { answeredA.resolve(); retireA.resolve(); finish.resolve(); presentationFinished.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The host must own A's actual presentation before its answer.");
  const answerA = { handle: harness.requests[0]!.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval" as const, requestId: first.requestId, disposition: "selected" as const, optionId: first.options[0]!.optionId,
  } };
  const deliveredA = await harness.coordinator.resolveRequest(answerA);
  assert.equal(deliveredA.status, "delivered");
  await waitFor(() => harness.requests.length === 2, "B must open after A's delivered receipt while A's presentation remains outstanding.");
  const before = (await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]!;
  assert.equal(before.phase, "waiting");
  assert.equal(before.pendingRequest?.requestId, second.requestId);
  const retainedA = await harness.store.read({ kind: "operation", parent: harness.requests[0]!.task.parent, operationId: answerA.operationId });
  retireA.resolve();
  await waitFor(async () => {
    const observations = await harness.store.read({ kind: "observations", taskId: admitted.taskId, runId: admitted.runId });
    return observations.kind === "observations" && observations.page.items.some((observation) => observation.request?.requestId === first.requestId && observation.request.state === "unavailable");
  }, "The original request's canonical retirement must remain observable after B opens.");
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, false);
  const after = (await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]!;
  assert.equal(after.phase, "waiting");
  assert.deepEqual(after.pendingRequest, before.pendingRequest);
  assert.deepEqual(await harness.store.read({ kind: "operation", parent: harness.requests[0]!.task.parent, operationId: answerA.operationId }), retainedA);
  assert.deepEqual(await harness.coordinator.resolveRequest(answerA), { ...deliveredA, duplicate: true });
  await assert.rejects(harness.coordinator.resolveRequest({ ...answerA, operationId: randomUUID() }), hasCode("request_unavailable"));
  const answerB = { handle: harness.requests[1]!.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval" as const, requestId: second.requestId, disposition: "selected" as const, optionId: second.options[0]!.optionId,
  } };
  assert.equal((await harness.coordinator.resolveRequest(answerB)).status, "delivered");
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.pendingRequest?.state, "resolved");
  finish.resolve();
  await closeEntered.promise;
  if (retainedCallback) {
    assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 10 })).status, "timeout");
    assert.equal(harness.resourceReleases(), 0);
    assert.equal(harness.grantReleases(), 0);
    presentationFinished.resolve();
  }
  assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 })).task.runs.items[0]?.outcome?.kind, "succeeded");
  const operations = await harness.store.read({ kind: "operations", taskId: admitted.taskId, runId: admitted.runId });
  assert.equal(operations.kind, "operations");
  assert.deepEqual(operations.page.items.filter((operation) => operation.kind === "request_resolution").map((operation) => [operation.operationId, operation.disposition]).sort(),
    [[answerA.operationId, "delivered"], [answerB.operationId, "delivered"]].sort());
  assert.equal(harness.provider.calls.resolutions.length, 2);
  assert.equal(harness.provider.calls.streamOwners, 1);
  assert.equal(harness.resourceReleases(), 1);
  assert.equal(harness.grantReleases(), 1);
});
