// ------------------------------------------------------------------------------------------------
//                executionStreamsRequests.test.ts - Output ownership and live host request authority
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseAgentApprovalOptionId, parseAgentError, parseAgentRequestId, type AgentRequest } from "@agen-ai/agent-protocol";
import { createAgentEventOutput, createAgentProviderRequestContext } from "@agen-ai/agent-runtime";
import type { DelegationHostRequestHandle } from "../src/index.js";
import { createExecutionHarness, waitFor } from "./fixtures/execution/harness.js";
import { deferred, eventBase, mapTurnOutputs } from "./fixtures/execution/provider.js";
import { at, createStoreFixture, digest, hasCode } from "./fixtures/execution/store.js";

test("collect preserves classified terminal failures with bounded public recovery and no child context", { timeout: 10_000 }, async (t) => {
  const quota = { sourceId: "private-account-source", poolId: "private-allowance-pool", windowId: "private-quota-window", observedAt: at };
  const preciseRetryAt = "2026-10-12T00:00:00.123456789+01:00";
  const cases = [
    [{ category: "quota_exhausted", code: "allowance_exhausted", message: "The child allowance is exhausted.", recovery: { kind: "wait_for_quota", quota } }, { kind: "wait_for_quota" }],
    [{ category: "authentication", code: "authentication_required", message: "The child requires authentication.", recovery: { kind: "user_action", action: "authenticate" } }, { kind: "user_action", action: "authenticate" }],
    [{ category: "transport", code: "connection_unavailable", message: "The child connection was unavailable.", recovery: { kind: "retry", notBefore: at } }, { kind: "retry", notBefore: at }],
    [{ category: "transport", code: "precise_retry_time", message: "The child connection was unavailable.", recovery: { kind: "retry", notBefore: preciseRetryAt } }, { kind: "retry", notBefore: preciseRetryAt }],
    [{ category: "transport", code: "oversized_retry_time", message: "The child connection was unavailable.", recovery: { kind: "retry", notBefore: `2026-10-12T00:00:00.${"7".repeat(2_100)}Z` } }, { kind: "retry" }],
    [{ category: "provider", code: "🧭".repeat(60), message: `Child failed: ${'🧭界"\\\u0000'.repeat(600)} end`, recovery: { kind: "none" } }, { kind: "none" }],
    [undefined, { kind: "unknown" }],
  ] as const;
  for (const [failure, recovery] of cases) await t.test(failure?.code ?? "missing terminal detail", async (st) => {
    const error = failure && parseAgentError({ ...failure, context: { operation: "private-native-operation", component: "private-native-session" } });
    const harness = await createExecutionHarness({ provider: { transformSession(session, context) {
      return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
        const base = eventBase(context, input.turnId);
        yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
        yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: error ? "failed" : "expired", ...(error ? { error } : {}) } });
      }) };
    } } });
    st.after(() => harness.close());
    const admitted = await harness.spawn();
    const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
    const outcome = settled.task.runs.items[0]?.outcome;
    assert.equal(settled.status, "settled");
    assert.equal(outcome?.kind, "failed");
    if (outcome?.kind !== "failed") throw new Error("Expected an authoritative failed child terminal.");
    const expected = error ? { category: error.category, code: error.code, recovery }
      : { category: "unknown", code: "child_failed", recovery: { kind: "unknown" } };
    assert.deepEqual({ category: outcome.error.category, code: outcome.error.code, recovery: outcome.error.recovery }, expected);
    assert.deepEqual(Object.keys(outcome.error).sort(), ["category", "code", "message", "recovery"]);
    assert.ok(Buffer.byteLength(JSON.stringify(outcome.error)) <= 2_048);
    if (error) {
      assert.ok(error.message.startsWith(outcome.error.message));
      assert.equal(Buffer.from(outcome.error.message).toString(), outcome.error.message, "Truncation must preserve complete Unicode characters.");
      if (failure?.category === "provider") assert.ok(outcome.error.message.length < error.message.length);
      else assert.equal(outcome.error.message, error.message);
    } else assert.equal(outcome.error.message, "The managed child reported an unsuccessful terminal outcome.");
    const collected = await harness.client.inspect({ taskId: admitted.taskId });
    assert.deepEqual(collected.runs.items[0]?.outcome, outcome);
    assert.equal(JSON.stringify(collected).includes("private-"), false);
    assert.equal(harness.provider.calls.turns.length, 1);
    assert.equal(harness.provider.calls.streamOwners, 1);
  });
});

for (const malformed of [false, true]) test(`${malformed ? "a malformed failed terminal" : "a transient-looking exception"} after dispatch remains uncertain without replay`, { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
      const base = eventBase(context, input.turnId);
      yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
      if (malformed) yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "failed" } });
      else throw parseAgentError({ category: "transport", code: "connection_reset", message: "The connection was reset.", recovery: { kind: "retry" } });
    }) };
  } } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "recovery_required", reason: "dispatch_uncertain" });
  assert.deepEqual((await harness.coordinator.recover({ limit: 100 })).recovered, []);
  assert.deepEqual((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.outcome, settled.task.runs.items[0]?.outcome);
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal(harness.provider.calls.streamOwners, 1);
});

test("one output owner awaits each observation commit before pulling the provider again", { timeout: 10_000 }, async (t) => {
  const blocked = deferred<void>();
  const committed = deferred<void>();
  let fetchedAfterText = false;
  const harness = await createExecutionHarness({
    store(store) { return { ...store, async commit(command) {
      if (command.kind === "observe" && command.observation.kind === "text") {
        blocked.resolve();
        await committed.promise;
      }
      return store.commit(command);
    } }; },
    provider: { transformSession(session, context) { return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
      const base = eventBase(context, input.turnId);
      yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
      yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId: "answer", itemKind: "assistant_message", status: "in_progress" } });
      yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId: "answer", streamKind: "assistant_text", delta: "Answer" } });
      fetchedAfterText = true;
      yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "completed" } });
    }) }; } },
  });
  t.after(() => harness.close());
  const receipt = await harness.spawn();
  await blocked.promise;
  assert.equal(fetchedAfterText, false);
  assert.equal(harness.provider.calls.streamOwners, 1);
  committed.resolve();
  const settled = await harness.client.wait({ taskId: receipt.taskId, timeoutMs: 1_000 });
  assert.equal(settled.status, "settled");
  assert.equal(fetchedAfterText, true);
  assert.equal(settled.task.runs.items[0]?.outcome?.kind, "succeeded");
  assert.equal("input" in settled.task.runs.items[0]!, false);
});

test("waiting retains its concurrency slot and only a live host handle can resolve the exact request", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ limits: { maxActiveRuns: 1 }, provider: { transformSession(session) {
    return { ...session, startTurn: mapTurnOutputs(session, async function* (input, outputs) {
      for await (const output of outputs) yield output.kind === "event" && output.event.type === "request.opened"
        ? createAgentEventOutput(output.event, { requestContext: createAgentProviderRequestContext({ providerResponseId: "private-native-response" }) }) : output;
    }) };
  } } });
  t.after(() => harness.close());
  const first = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The host should receive the validated waiting request.");
  const request = harness.requests[0]!;
  assert.equal(request.request.requestKind, "approval");
  if (request.request.requestKind !== "approval") throw new Error("Expected fake approval");
  const second = await harness.spawn();
  const waiting = await harness.client.inspect({ taskId: first.taskId });
  assert.equal(waiting.runs.items[0]?.phase, "waiting");
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal((await harness.client.inspect({ taskId: second.taskId })).runs.items[0]?.phase, "queued");
  assert.equal(JSON.stringify(waiting).includes(request.request.prompt), false);
  const history = await harness.store.read({ kind: "observations", taskId: first.taskId, runId: first.runId });
  assert.equal(JSON.stringify(history).includes("private-native-response"), false);
  const resolution = { requestKind: "approval" as const, requestId: request.request.requestId,
    disposition: "selected" as const, optionId: request.request.options[0]!.optionId };
  await assert.rejects(async () => harness.coordinator.resolveRequest({ handle: {} as DelegationHostRequestHandle, operationId: randomUUID(), resolution }), hasCode("request_unavailable"));
  for (const invalid of [{ ...resolution, requestId: parseAgentRequestId("another-request") },
    { ...resolution, optionId: parseAgentApprovalOptionId("unoffered-option") }]) {
    await assert.rejects(async () => harness.coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution: invalid }));
    assert.equal((await harness.client.inspect({ taskId: first.taskId })).runs.items[0]?.phase, "waiting");
  }
  assert.equal(harness.provider.calls.resolutions.length, 0);
  harness.disablePolicy();
  const resolved = await harness.coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution });
  assert.equal(resolved.status, "delivered");
  assert.equal(harness.provider.calls.resolutions.length, 1);
  assert.equal(harness.provider.calls.streamOwners, 1);
  assert.equal((await harness.client.wait({ taskId: first.taskId, timeoutMs: 1_000 })).status, "settled");
  await assert.rejects(async () => harness.coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution }), hasCode("request_unavailable"));
  assert.equal(harness.provider.calls.resolutions.length, 1);
});

test("request-resolution capacity rejection preserves the exact waiting handle and reserved cancellation", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ limits: { maxOrdinaryOperationsPerRun: 3 } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The child should reach its exact approval boundary.");
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected fake approval");
  const input = { handle: request.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval" as const, requestId: request.request.requestId, disposition: "selected" as const, optionId: request.request.options[0]!.optionId,
  } };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(async () => harness.coordinator.resolveRequest(input), hasCode("capacity_exceeded"));
    const waiting = await harness.client.inspect({ taskId: admitted.taskId });
    assert.equal(waiting.runs.items[0]?.phase, "waiting");
    assert.equal(waiting.runs.items[0]?.pendingRequest?.state, "waiting");
    assert.equal(harness.provider.calls.resolutions.length, 0);
    assert.equal(harness.provider.calls.close, 0);
    assert.equal(harness.resourceReleases(), 0);
  }
  assert.equal(harness.requests.length, 1);
  await harness.client.cancel({ operationId: randomUUID(), taskId: admitted.taskId });
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "canceled", confirmation: "provider_terminal" });
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 1);
  await assert.rejects(harness.coordinator.resolveRequest(input), hasCode("request_unavailable"));
  assert.equal(harness.provider.calls.resolutions.length, 0);
});

test("request authority is independently checked before any provider continuation", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness();
  t.after(() => harness.close());
  await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The host should receive the request.");
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected fake approval");
  const resolution = { requestKind: "approval" as const, requestId: request.request.requestId,
    disposition: "selected" as const, optionId: request.request.options[0]!.optionId };
  harness.denyRequestAccess();
  await assert.rejects(async () => harness.coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution }), /Request access revoked/u);
  assert.equal(harness.provider.calls.resolutions.length, 0);
});

test("aborting observation and wait subscriptions leaves the owned child running", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness();
  t.after(() => harness.close());
  const receipt = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The child should reach waiting.");
  const controller = new AbortController();
  const observation = harness.client.observe({ taskId: receipt.taskId, signal: controller.signal })[Symbol.asyncIterator]();
  await observation.next();
  controller.abort();
  await observation.return?.();
  await assert.rejects(harness.client.wait({ taskId: receipt.taskId, timeoutMs: 100, signal: controller.signal }));
  assert.equal((await harness.client.inspect({ taskId: receipt.taskId })).runs.items[0]?.phase, "waiting");
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  assert.equal(harness.provider.calls.close, 0);
});

test("observation cursors resume in admission order across equal timestamps and expose omitted ranges", { timeout: 10_000 }, async (t) => {
  const fixture = await createStoreFixture({ maxRunObservations: 1 }, "ffffffff-ffff-4fff-bfff-ffffffffffff");
  await fixture.running();
  await fixture.store.commit({ ...await fixture.fence(), kind: "observe", observation: {
    storeId: fixture.store.storeId, taskId: fixture.taskId, runId: fixture.runId, index: 1, at, kind: "text", text: "First run",
  } });
  await fixture.store.commit({ ...await fixture.fence(), kind: "settle", at,
    outcome: { kind: "succeeded", result: { text: "First run", truncated: false, references: [] } } });
  const secondId = "00000000-0000-4000-8000-000000000000";
  const fence = await fixture.fence();
  await fixture.store.commit({ ...fixture.admission, operationId: randomUUID(), inputDigest: digest("second run"), expectedTaskRevision: fence.expectedTaskRevision,
    runId: fixture.runId, expectedRunRevision: fence.expectedRunRevision,
    admission: { ...fixture.admission.admission, previousRunId: fixture.runId, continuationMode: "follow_up", runId: secondId } });
  await fixture.receipt(await fixture.intent("prepare", secondId));
  await fixture.receipt(await fixture.intent("turn", secondId), "delegated");
  for (let index = 1; index <= 3; index += 1) await fixture.store.commit({ ...await fixture.fence(undefined, undefined, secondId), kind: "observe", observation: {
    storeId: fixture.store.storeId, taskId: fixture.taskId, runId: secondId, index, at, kind: "text", text: `Second run ${index}`,
  } });
  await fixture.store.commit({ ...await fixture.fence(undefined, undefined, secondId), kind: "settle", at,
    outcome: { kind: "succeeded", result: { text: "Second run", truncated: false, references: [] } } });
  await fixture.store.releaseOwner(fixture.owner);
  const harness = await createExecutionHarness({ store: () => fixture.store });
  t.after(() => harness.close());
  const first = harness.client.observe({ taskId: fixture.taskId })[Symbol.asyncIterator]();
  const observed = await first.next();
  assert.ok(!observed.done);
  assert.equal(observed.value.runId, fixture.runId);
  await first.return?.();
  const resumed = [];
  for await (const observation of harness.client.observe({ taskId: fixture.taskId, after: observed.value.cursor })) resumed.push(observation);
  assert.deepEqual(resumed.map((observation) => [observation.runId, observation.kind]), [[secondId, "text"], [secondId, "omitted"], [secondId, "gap"]]);
  assert.equal(new Set(resumed.map((observation) => observation.cursor)).size, 3);
  const view = await harness.client.inspect({ taskId: fixture.taskId });
  assert.deepEqual(view.runs.items.map((run) => run.runId), [fixture.runId, secondId]);
});

test("a host can await a person while child output continues and delivery settles before terminal or cleanup", { timeout: 10_000 }, async (t) => {
  const routing = deferred<void>();
  const finish = deferred<void>();
  const closeEntered = deferred<void>();
  const quiesced = deferred<void>();
  const harness = await createExecutionHarness({ limits: { maxActiveRuns: 1 }, host(base) { return {
    async onRequest(input) {
      assert.equal(input.run.pendingRequest?.requestId, input.request.requestId);
      assert.equal(input.run.pendingRequest?.state, "waiting");
      const observations = await harness.store.read({ kind: "observations", taskId: input.task.taskId, runId: input.run.runId });
      assert.equal(observations.kind, "observations");
      assert.equal(observations.page.items.find((observation) => observation.kind === "request")?.request?.requestId, input.request.requestId);
      base.onRequest(input);
      await routing.promise;
    },
  }; }, provider: { transformSession(session, context) { return { ...session,
    startTurn: mapTurnOutputs(session, async function* (input, outputs) {
      for await (const output of outputs) {
        yield output;
        if (output.kind === "event" && output.event.type === "request.opened") {
          const base = eventBase(context, input.turnId);
          yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId: "parallel-work", itemKind: "assistant_message", status: "in_progress" } });
          yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId: "parallel-work", streamKind: "assistant_text", delta: "Work continues while approval is pending." } });
          await finish.promise;
        }
      }
    }),
    async close(input) { closeEntered.resolve(); await quiesced.promise; await session.close(input); },
  }; } } });
  t.after(async () => { routing.resolve(); finish.resolve(); quiesced.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The host routing task must receive the exact committed request.");
  await waitFor(async () => {
    const page = await harness.store.read({ kind: "observations", taskId: admitted.taskId, runId: admitted.runId });
    return page.kind === "observations" && page.page.items.some((observation) => observation.text === "Work continues while approval is pending.");
  }, "The reader must publish unrelated output while onRequest is still awaiting the person.");
  const queued = await harness.spawn();
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected approval");
  const input = { handle: request.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval" as const, requestId: request.request.requestId, disposition: "selected" as const, optionId: request.request.options[0]!.optionId,
  } };
  const receipts = await Promise.all([harness.coordinator.resolveRequest(input), harness.coordinator.resolveRequest(input)]);
  assert.deepEqual(receipts.map(({ status, duplicate }) => ({ status, duplicate })), [
    { status: "delivered", duplicate: false }, { status: "delivered", duplicate: true },
  ]);
  const pending = await harness.client.inspect({ taskId: admitted.taskId });
  assert.equal(pending.runs.items[0]?.phase, "running");
  assert.equal(pending.runs.items[0]?.pendingRequest?.state, "resolved");
  assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 10 })).status, "timeout");
  assert.equal((await harness.client.inspect({ taskId: queued.taskId })).runs.items[0]?.phase, "queued");
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal(harness.provider.calls.streamOwners, 1);
  assert.equal(harness.provider.calls.resolutions.length, 1);
  assert.equal(harness.resourceReleases(), 0);
  assert.equal(harness.grantReleases(), 0);
  routing.resolve();
  finish.resolve();
  await closeEntered.promise;
  assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 10 })).status, "timeout");
  assert.equal((await harness.client.inspect({ taskId: queued.taskId })).runs.items[0]?.phase, "queued");
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal(harness.resourceReleases(), 0);
  assert.equal(harness.grantReleases(), 0);
  quiesced.resolve();
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(settled.task.runs.items[0]?.outcome?.kind, "succeeded");
  assert.equal(harness.resourceReleases(), 1);
});

test("two live requests retain exact answer history and route only after the preceding delivery is committed", { timeout: 10_000 }, async (t) => {
  const firstOperationId = randomUUID();
  const secondOperationId = randomUUID();
  const secondRequestId = parseAgentRequestId("second-managed-request");
  const receiptBlocked = deferred<void>();
  const commitReceipt = deferred<void>();
  const secondOffered = deferred<void>();
  const secondAnswered = deferred<void>();
  const transcript: string[] = [];
  const harness = await createExecutionHarness({ store(store) { return { ...store, async commit(command) {
    if (command.kind === "operation_receipt" && command.operationId === firstOperationId) {
      receiptBlocked.resolve();
      await commitReceipt.promise;
    }
    const receipt = await store.commit(command);
    if (command.kind === "request_state") transcript.push(`committed:${command.state}:${command.request.requestId}`);
    if (command.kind === "operation_receipt" && command.operationId === firstOperationId) transcript.push("committed:first-delivery");
    if (command.kind === "operation_receipt" && command.operationId === secondOperationId) transcript.push("committed:second-delivery");
    if (command.kind === "settle") transcript.push("committed:terminal");
    return receipt;
  } }; }, provider: { transformSession(session, context) { return { ...session, startTurn(input) {
    const execution = session.startTurn(input);
    return { ...execution, outputs: (async function* () {
      let firstRequest: AgentRequest | undefined;
      for await (const output of execution.outputs) {
        if (output.kind === "event" && output.event.type === "request.opened") firstRequest = output.event.payload.request;
        if (output.kind === "event" && output.event.type === "turn.completed") {
          if (firstRequest?.requestKind !== "approval") throw new Error("Expected the first approval before the second callback.");
          const base = eventBase(context, input.turnId);
          const request = { ...firstRequest, requestId: secondRequestId, prompt: "Approve the second operation?" };
          secondOffered.resolve();
          yield createAgentEventOutput({ ...base, type: "request.opened", payload: { request } });
          yield createAgentEventOutput({ ...base, type: "turn.state_changed", payload: { state: "waiting_for_request", requestId: secondRequestId } });
          yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId: "second-work", itemKind: "assistant_message", status: "in_progress" } });
          yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId: "second-work", streamKind: "assistant_text", delta: "Second request remains live." } });
          await secondAnswered.promise;
          yield createAgentEventOutput({ ...base, type: "turn.state_changed", payload: { state: "running" } });
        }
        yield output;
      }
    })(), async resolveRequest(response) {
      transcript.push(`native-answer:${response.resolution.requestId}`);
      if (response.resolution.requestId !== secondRequestId) return execution.resolveRequest(response);
      secondAnswered.resolve();
      return { status: "delivered" as const };
    } };
  } }; } } });
  t.after(async () => { commitReceipt.resolve(); secondAnswered.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The first exact request must reach the host.");
  const first = harness.requests[0]!;
  if (first.request.requestKind !== "approval") throw new Error("Expected first approval");
  const firstAnswer = { handle: first.handle, operationId: firstOperationId, resolution: {
    requestKind: "approval" as const, requestId: first.request.requestId, disposition: "selected" as const, optionId: first.request.options[0]!.optionId,
  } };
  const delivering = harness.coordinator.resolveRequest(firstAnswer);
  await Promise.all([receiptBlocked.promise, secondOffered.promise]);
  await setImmediate();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.provider.calls.resolutions.length, 1);
  commitReceipt.resolve();
  const delivered = await delivering;
  await waitFor(() => harness.requests.length === 2, "The second request must route after the exact first receipt is durable.");
  const second = harness.requests[1]!;
  assert.equal(second.request.requestId, secondRequestId);
  assert.notEqual(second.handle, first.handle);
  await waitFor(async () => {
    const page = await harness.store.read({ kind: "observations", taskId: admitted.taskId, runId: admitted.runId });
    return page.kind === "observations" && page.page.items.some((observation) => observation.text === "Second request remains live.");
  }, "Unrelated output must continue while the second request is pending.");
  assert.deepEqual(await harness.coordinator.resolveRequest(firstAnswer), { ...delivered, duplicate: true });
  await assert.rejects(harness.coordinator.resolveRequest({ ...firstAnswer, operationId: randomUUID() }), hasCode("request_unavailable"));
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.pendingRequest?.requestId, secondRequestId);
  assert.equal(harness.provider.calls.resolutions.length, 1);
  if (second.request.requestKind !== "approval") throw new Error("Expected second approval");
  assert.equal((await harness.coordinator.resolveRequest({ handle: second.handle, operationId: secondOperationId, resolution: {
    requestKind: "approval", requestId: secondRequestId, disposition: "selected", optionId: second.request.options[0]!.optionId,
  } })).status, "delivered");
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "succeeded", result: {
    text: "Deterministic fake output.Second request remains live.", truncated: false, references: [],
  } });
  assert.deepEqual(transcript, [
    `committed:opened:${first.request.requestId}`, `committed:resolution_intended:${first.request.requestId}`,
    `native-answer:${first.request.requestId}`, "committed:first-delivery", `committed:opened:${secondRequestId}`,
    `committed:resolution_intended:${secondRequestId}`, `native-answer:${secondRequestId}`, "committed:second-delivery", "committed:terminal",
  ]);
  assert.deepEqual(harness.provider.calls.resolutions.map((response) => response.resolution.requestId), [first.request.requestId, secondRequestId]);
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal(harness.provider.calls.streamOwners, 1);
  assert.equal(harness.provider.calls.close, 1);
  assert.equal(harness.resourceReleases(), 1);
  assert.equal(harness.grantReleases(), 1);
});

for (const requestState of ["pending", "unavailable"] as const) test(`a definitive ${requestState} rejection retains its exact receipt and only authoritative answer eligibility`, { timeout: 10_000 }, async (t) => {
  let attempts = 0;
  const error = parseAgentError({ category: "provider", code: "answer_declined", message: "The provider declined this answer.", recovery: { kind: "none" } });
  const harness = await createExecutionHarness({ provider: { transformSession(session) { return { ...session, startTurn(input) {
    const execution = session.startTurn(input);
    return { ...execution, async resolveRequest(response) {
      attempts += 1;
      if (attempts === 1) return { status: "rejected" as const, requestState, error };
      return execution.resolveRequest(response);
    } };
  } }; } } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The exact request must remain owned by the host.");
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected approval");
  const input = { handle: request.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval" as const, requestId: request.request.requestId, disposition: "selected" as const, optionId: request.request.options[0]!.optionId,
  } };
  const rejected = await harness.coordinator.resolveRequest(input);
  assert.deepEqual(rejected, { status: "rejected", requestState, taskId: admitted.taskId, runId: admitted.runId, operationId: input.operationId, duplicate: false });
  assert.deepEqual(await harness.coordinator.resolveRequest(input), { ...rejected, duplicate: true });
  assert.equal(attempts, 1);
  const view = await harness.client.inspect({ taskId: admitted.taskId });
  assert.equal(view.runs.items[0]?.pendingRequest?.state, requestState === "pending" ? "waiting" : "unavailable");
  assert.equal(harness.provider.calls.streamOwners, 1);
  if (requestState === "pending") {
    assert.equal((await harness.coordinator.resolveRequest({ ...input, operationId: randomUUID() })).status, "delivered");
    assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 })).task.runs.items[0]?.outcome?.kind, "succeeded");
    assert.equal(attempts, 2);
  } else {
    await assert.rejects(async () => harness.coordinator.resolveRequest({ ...input, operationId: randomUUID() }), hasCode("request_unavailable"));
    assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 10 })).status, "timeout");
    assert.equal(attempts, 1);
  }
});

for (const throws of [false, true]) test(`${throws ? "an entered response exception" : "an uncertain response receipt"} forbids replay and retains cleanup ownership`, { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ provider: { transformSession(session) { return { ...session, startTurn(input) {
    const execution = session.startTurn(input);
    return { ...execution, async resolveRequest() {
      if (throws) throw new Error("The native callback outcome was lost.");
      return { status: "delivery_uncertain" as const, error: parseAgentError({ category: "transport", code: "receipt_lost", message: "The answer outcome is unknown.", recovery: { kind: "none" } }) };
    } };
  } }; } } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The child must expose its exact callback before response delivery.");
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected approval");
  const input = { handle: request.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval" as const, requestId: request.request.requestId, disposition: "selected" as const, optionId: request.request.options[0]!.optionId,
  } };
  assert.equal((await harness.coordinator.resolveRequest(input)).status, "delivery_uncertain");
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "recovery_required", reason: "request_executor_lost" });
  await assert.rejects(async () => harness.coordinator.resolveRequest({ ...input, operationId: randomUUID() }), hasCode("request_unavailable"));
  assert.equal(harness.provider.calls.resolutions.length, 1);
  assert.equal(harness.provider.calls.streamOwners, 1);
  assert.equal(harness.resourceReleases(), 1);
});

test("request authority loss after durable intent preserves the local error and admits no native answer", { timeout: 10_000 }, async (t) => {
  let revoke: () => void = () => undefined;
  const harness = await createExecutionHarness({ store(store) { return { ...store, async commit(command) {
    const receipt = await store.commit(command);
    if (command.kind === "request_state" && command.state === "resolution_intended") revoke();
    return receipt;
  } }; } });
  revoke = () => harness.denyRequestAccess();
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The owned child must expose its approval before authority is revoked.");
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected approval");
  const operationId = randomUUID();
  await assert.rejects(harness.coordinator.resolveRequest({ handle: request.handle, operationId, resolution: {
    requestKind: "approval", requestId: request.request.requestId, disposition: "selected", optionId: request.request.options[0]!.optionId,
  } }), /Request access revoked/u);
  assert.equal(harness.provider.calls.resolutions.length, 0);
  const view = await harness.client.inspect({ taskId: admitted.taskId });
  assert.equal(view.runs.items[0]?.phase, "waiting");
  assert.equal(view.runs.items[0]?.pendingRequest?.state, "waiting");
  const operation = await harness.store.read({ kind: "operation", parent: view.task.parent, operationId });
  assert.equal(operation.kind, "operation");
  assert.equal(operation.operation?.disposition, "rejected");
  assert.equal(operation.operation?.requestState, "pending");
});
