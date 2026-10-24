// ------------------------------------------------------------------------------------------------
//                executionCancellation.test.ts - Cancellation truth and independent active authority
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parseAgentArtifactId } from "@agen-ai/agent-protocol";
import { createAgentArtifactOutput, createAgentEventOutput } from "@agen-ai/agent-runtime";
import type { DelegationLimits, DelegationStore } from "../src/index.js";
import { createExecutionHarness, scope, textInput, waitFor } from "./fixtures/execution/harness.js";
import { bindingSupport, ownedBinding } from "./fixtures/execution/binding.js";
import { completedTurn, deferred, eventBase, mapTurnOutputs } from "./fixtures/execution/provider.js";
import { hasCode } from "./fixtures/execution/store.js";

async function createContinuingHarness(limits: Partial<DelegationLimits> = {}, store?: (store: DelegationStore) => DelegationStore) {
  const entered = deferred<void>();
  const finish = deferred<void>();
  let turns = 0;
  const harness = await createExecutionHarness({ limits, store, allowContinuation: true, provider: { transformSession(session, context) {
    const interruption = session.interruption;
    if (interruption.kind !== "supported") throw new Error("Expected fake interruption");
    return { ...session, startTurn: mapTurnOutputs(session, async function* (input, outputs) {
      turns += 1;
      if (turns === 1) { yield* completedTurn(context, input.turnId); return; }
      if (turns > 2) { yield* outputs; return; }
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.started", payload: {} });
      entered.resolve();
      await finish.promise;
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.completed", payload: { structuredOutput: { kind: "not_requested" }, outcome: "canceled" } });
    }), interruption: { kind: "supported", async interruptTurn(input) {
      const result = await interruption.interruptTurn(input);
      finish.resolve();
      return result;
    } } };
  } } });
  return { ...harness, entered, finish };
}

test("canceling a queued run confirms not-dispatched and only its exact operation can be retried", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ limits: { maxActiveRuns: 1 } });
  t.after(() => harness.close());
  await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The first child should own the active slot.");
  const queued = await harness.spawn();
  const input = { operationId: randomUUID(), taskId: queued.taskId };
  const first = await harness.client.cancel(input);
  const repeated = await harness.client.cancel(input);
  assert.equal(first.status, "confirmed");
  assert.equal(repeated.operationId, first.operationId);
  assert.equal(repeated.duplicate, true);
  await assert.rejects(harness.client.cancel({ ...input, operationId: randomUUID() }), hasCode("operation_conflict"));
  const view = await harness.client.inspect({ taskId: queued.taskId });
  assert.deepEqual(view.runs.items[0]?.outcome, { kind: "canceled", confirmation: "not_dispatched" });
  assert.equal(harness.provider.contexts.length, 1);
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
});

test("policy deselection leaves active ownership intact while execution lease revocation interrupts it", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness();
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The child should reach a waiting request.");
  harness.disablePolicy();
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.phase, "waiting");
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  assert.equal(harness.resourceReleases(), 0);
  harness.grants[0]!.abort(new Error("Execution authority revoked"));
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(settled.status, "settled");
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "canceled", confirmation: "provider_terminal" });
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 1);
  await waitFor(() => harness.resourceReleases() === 1, "Runtime cleanup should precede resource release.");
  assert.equal(harness.grantReleases(), 1);
});

test("cancellation racing queued scheduling preserves terminal truth and unrelated admissions", { timeout: 10_000 }, async (t) => {
  for (const scenario of ["scanned", "ceiling read", "expired", "policy disabled", "policy revision changed"] as const) {
    await t.test(scenario, async (st) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      let scanned = false;
      let held = false;
      let queuedDeadline = 0;
      const harness = await createExecutionHarness({ store(store) { return { ...store,
        async scan(query) {
          const result = await store.scan(query);
          if (query.kind === "queued" && result.kind === "queued" && result.page.items.length > 0 && !scanned) {
            scanned = true;
            queuedDeadline = Date.parse(result.page.items[0]!.queuedStartDeadlineAt);
            if (scenario !== "ceiling read") { held = true; entered.resolve(); await release.promise; }
          }
          return result;
        },
        async read(query) {
          const result = await store.read(query);
          if (scenario === "ceiling read" && scanned && !held && query.kind === "ceiling") {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      }; }, provider: { transformSession(session, context) {
        return { ...session, startTurn: mapTurnOutputs(session, (input) => completedTurn(context, input.turnId)) };
      } } });
      st.after(async () => { release.resolve(); st.mock.timers.reset(); await harness.close(); });
      const admitted = await harness.spawn();
      await entered.promise;
      const canceled = await harness.client.cancel({ operationId: randomUUID(), taskId: admitted.taskId });
      assert.equal(canceled.status, "confirmed");
      const policy = harness.host.currentPolicy(scope).policy;
      if (scenario === "expired") st.mock.timers.enable({ apis: ["Date"], now: queuedDeadline + 1 });
      if (scenario === "policy disabled") harness.disablePolicy();
      if (scenario === "policy revision changed") harness.setPolicy({ ...policy, revision: policy.revision + 1 });
      release.resolve();
      await setImmediate();
      st.mock.timers.reset();
      harness.setPolicy(policy);
      assert.equal(harness.provider.contexts.length, 0, "The canceled task must never open a provider session.");
      assert.deepEqual((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.outcome,
        { kind: "canceled", confirmation: "not_dispatched" });
      const next = await harness.spawn();
      const settled = await harness.client.wait({ taskId: next.taskId, timeoutMs: 1_000 });
      assert.equal(settled.task.runs.items[0]?.outcome?.kind, "succeeded");
      assert.equal(harness.provider.contexts.length, 1);
      assert.deepEqual(await harness.close(), { status: "closed", retainedTaskIds: [] });
    });
  }
});

test("grant revocation blocks a queued next_turn while a fresh follow_up remains explicit authority", { timeout: 10_000 }, async (t) => {
  for (const queuedBeforeRevocation of [true, false]) await t.test(queuedBeforeRevocation ? "queued next_turn" : "fresh follow_up", async (st) => {
    const entered = deferred<void>();
    const finish = deferred<void>();
    let turns = 0;
    const harness = await createExecutionHarness({ allowContinuation: true, provider: { transformSession(session, context) {
      const interruption = session.interruption;
      if (interruption.kind !== "supported") throw new Error("Expected fake interruption");
      return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
        turns += 1;
        if (turns > 1) { yield* completedTurn(context, input.turnId); return; }
        const base = eventBase(context, input.turnId);
        yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
        entered.resolve();
        await finish.promise;
        yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { structuredOutput: { kind: "not_requested" }, outcome: "canceled" } });
      }), interruption: { kind: "supported", async interruptTurn(input) {
        const result = await interruption.interruptTurn(input);
        finish.resolve();
        return result;
      } } };
    } } });
    st.after(async () => { finish.resolve(); await harness.close(); });
    const first = await harness.spawn();
    await entered.promise;
    const input = { taskId: first.taskId, input: textInput(), target: harness.target.reference, expectedPolicyRevision: 1 };
    if (queuedBeforeRevocation) assert.equal((await harness.client.send({ ...input, operationId: randomUUID(), mode: "next_turn" })).status, "queued");
    harness.grants[0]!.abort(new Error("Execution authority revoked"));
    const settled = await harness.client.wait({ taskId: first.taskId, timeoutMs: 1_000 });
    assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "canceled", confirmation: "provider_terminal" });
    if (queuedBeforeRevocation) {
      assert.equal(settled.task.runs.items[1]?.outcome?.kind, "failed");
      assert.equal(harness.provider.calls.turns.length, 1);
      assert.equal(harness.provider.fake.snapshot().resumedSessionIds.length, 0);
    } else {
      assert.equal((await harness.client.send({ ...input, operationId: randomUUID(), mode: "follow_up" })).status, "queued");
      const followed = await harness.client.wait({ taskId: first.taskId, timeoutMs: 1_000 });
      assert.deepEqual(followed.task.runs.items.map((run) => run.outcome?.kind), ["canceled", "succeeded"]);
      assert.equal(harness.provider.fake.snapshot().resumedSessionIds.length, 1);
    }
  });
});

test("policy revocation between resource acquisition and runtime claim cleans the unclaimed host owner once", { timeout: 10_000 }, async (t) => {
  const events: string[] = [];
  const host = ownedBinding(events);
  let resourcesReleased = 0;
  const harness = await createExecutionHarness({ provider: { transformAdapter(adapter) { return { ...adapter, hostBinding: bindingSupport }; } },
    host: { acquireChildResources() {
      revoke();
      return { workingDirectory: { policy: "isolated", authorizedRef: "directory-authority", path: "/host/delegated" }, hostBinding: host.binding,
        async release() { await host.binding.release(); resourcesReleased += 1; events.push("resources_released"); } };
    } },
  });
  t.after(() => harness.close());
  const revoke = () => harness.disablePolicy();
  const admitted = await harness.spawn();
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(settled.status, "settled");
  assert.equal(harness.provider.contexts.length, 0);
  assert.equal(harness.provider.calls.close, 0);
  assert.equal(host.releases(), 1);
  assert.equal(resourcesReleased, 1);
  assert.deepEqual(events, ["binding_released", "resources_released"]);
});

test("canceling preparation retains an acquired child lease until its late delivery and releases it without opening", { timeout: 10_000 }, async (t) => {
  const acquired = deferred<void>();
  const deliver = deferred<void>();
  const binding = ownedBinding();
  let acquisitionSignal: AbortSignal | undefined;
  const harness = await createExecutionHarness({ binding: () => binding.binding,
    provider: { transformAdapter(adapter) { return { ...adapter, hostBinding: bindingSupport }; } },
    host(base) { return { async acquireChildResources(input) {
      const resources = await base.acquireChildResources(input);
      acquisitionSignal = input.signal;
      acquired.resolve();
      await deliver.promise;
      return resources;
    } }; },
  });
  t.after(async () => { deliver.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await acquired.promise;
  const cancellation = await harness.client.cancel({ operationId: randomUUID(), taskId: admitted.taskId });
  assert.equal(cancellation.status, "requested");
  assert.equal(acquisitionSignal?.aborted, true);
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.phase, "preparing");
  assert.deepEqual([binding.releases(), harness.resourceReleases(), harness.grantReleases()], [0, 0, 0]);
  deliver.resolve();
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(settled.status, "settled");
  assert.equal(settled.task.runs.items[0]?.cancelRequested, true);
  assert.equal(settled.task.runs.items[0]?.dispatch, "none");
  assert.equal(settled.task.runs.items[0]?.pendingRequest, undefined);
  assert.deepEqual([harness.provider.contexts.length, harness.provider.calls.turns.length, harness.provider.calls.resolutions.length, harness.requests.length], [0, 0, 0, 0]);
  assert.deepEqual([binding.releases(), harness.resourceReleases(), harness.grantReleases()], [1, 1, 1]);
  assert.deepEqual(harness.events, ["execution_acquired", "resources_acquired", "resources_released", "execution_released"]);
});

test("an accepted interruption without a terminal confirmation stays recovery_required", { timeout: 10_000 }, async (t) => {
  const finish = deferred<void>();
  const entered = deferred<void>();
  let interruptions = 0;
  const harness = await createExecutionHarness({ provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.started", payload: {} });
      entered.resolve();
      await finish.promise;
    }), interruption: { kind: "supported", interruptTurn() {
      interruptions += 1;
      finish.resolve();
      return { status: "completed" };
    } } };
  } } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await entered.promise;
  const cancellation = { operationId: randomUUID(), taskId: admitted.taskId };
  const receipt = await harness.client.cancel(cancellation);
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "recovery_required", reason: "cancellation_uncertain" });
  assert.deepEqual(await harness.client.cancel(cancellation), { ...receipt, status: "recovery_required", duplicate: true });
  assert.equal(interruptions, 1);
});

test("a definite successful terminal event wins a concurrent accepted cancellation", { timeout: 10_000 }, async (t) => {
  const finish = deferred<void>();
  const entered = deferred<void>();
  const terminalConsumed = deferred<void>();
  const harness = await createExecutionHarness({ provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.started", payload: {} });
      entered.resolve();
      await finish.promise;
      yield createAgentEventOutput({ ...eventBase(context, input.turnId), type: "turn.completed", payload: { structuredOutput: { kind: "not_requested" }, outcome: "completed" } });
      terminalConsumed.resolve();
    }), interruption: { kind: "supported", async interruptTurn() {
      finish.resolve();
      await terminalConsumed.promise;
      return { status: "completed" };
    } } };
  } } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await entered.promise;
  await harness.client.cancel({ operationId: randomUUID(), taskId: admitted.taskId });
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(settled.task.runs.items[0]?.outcome?.kind, "succeeded");
});

test("the original turn owns cancellation-time output through its terminal or bounded abort", { timeout: 10_000 }, async (t) => {
  for (const scenario of ["output follows the accepted receipt", "terminal precedes a delayed receipt", "blocked publisher is aborted at the cancellation deadline"] as const) await t.test(scenario, async (st) => {
    const receiptDelayed = scenario === "terminal precedes a delayed receipt";
    const blockedPublisher = scenario === "blocked publisher is aborted at the cancellation deadline";
    const entered = deferred<void>();
    const finish = deferred<void>();
    const mainEnded = deferred<void>();
    const publicationStopped = deferred<void>();
    const publicationSignals: boolean[] = [];
    let publicationAborted = false;
    const harness = await createExecutionHarness({ ...(blockedPublisher ? { limits: { controlTimeoutMs: 100 } } : {}), host: {
      async publishArtifact({ candidate, signal }) {
        publicationSignals.push(signal.aborted);
        signal.throwIfAborted();
        if (blockedPublisher) {
          const aborted = () => { publicationAborted = true; publicationStopped.resolve(); };
          signal.addEventListener("abort", aborted, { once: true });
          try { await publicationStopped.promise; } finally { signal.removeEventListener("abort", aborted); }
          signal.throwIfAborted();
        }
        return { id: candidate.descriptor.artifactId, kind: "artifact" };
      },
    }, provider: { transformSession(session, context) {
      const interruption = session.interruption;
      if (interruption.kind !== "supported") throw new Error("Expected fake interruption");
      return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
        const base = eventBase(context, input.turnId);
        yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
        yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId: "answer", itemKind: "assistant_message", status: "in_progress" } });
        yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId: "answer", streamKind: "assistant_text", delta: "Before " } });
        entered.resolve();
        await finish.promise;
        yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId: "answer", streamKind: "assistant_text", delta: "After." } });
        yield createAgentArtifactOutput({ descriptor: { artifactId: parseAgentArtifactId("cancellation-artifact"), kind: "diff", displayName: "final.diff", mediaType: "text/x-diff" },
          source: { kind: "bytes", bytes: new TextEncoder().encode("Final change") }, delivery: "best_effort" });
        yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { structuredOutput: { kind: "not_requested" }, outcome: "completed" } });
        mainEnded.resolve();
      }), interruption: { kind: "supported", async interruptTurn(input) {
        await interruption.interruptTurn(input);
        if (receiptDelayed) {
          finish.resolve();
          await mainEnded.promise;
          await setImmediate();
        }
        return { status: "accepted" };
      } } };
    } } });
    st.after(async () => { publicationStopped.resolve(); finish.resolve(); await harness.close(); });
    const admitted = await harness.spawn();
    await entered.promise;
    const cancellation = harness.client.cancel({ operationId: randomUUID(), taskId: admitted.taskId });
    if (!receiptDelayed) { await cancellation; finish.resolve(); }
    const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
    assert.equal(settled.status, "settled");
    await cancellation;
    assert.deepEqual(publicationSignals, [false], "The original execution retains publication authority until terminal settlement or cancellation timeout.");
    if (blockedPublisher) {
      assert.equal(publicationAborted, true);
      assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "recovery_required", reason: "cancellation_uncertain" });
      assert.equal(harness.resourceReleases(), 1);
    } else assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "succeeded", result: {
      text: "Before After.", truncated: false, references: [{ id: "cancellation-artifact", kind: "artifact" }],
    } });
    const observations = await harness.store.read({ kind: "observations", taskId: admitted.taskId, runId: admitted.runId });
    assert.equal(observations.kind, "observations");
    assert.deepEqual(observations.page.items.filter((entry) => entry.kind === "text").map((entry) => entry.text), ["Before ", "After."]);
    assert.equal(harness.provider.calls.streamOwners, 1);
    assert.equal(harness.provider.calls.turns.length, 1);
  });
});

test("cancel replay for a settled run cannot interrupt a later continuation", { timeout: 10_000 }, async (t) => {
  const harness = await createContinuingHarness();
  const { entered, finish } = harness;
  t.after(async () => { finish.resolve(); await harness.close(); });
  const first = await harness.spawn();
  await harness.client.wait({ taskId: first.taskId, timeoutMs: 1_000 });
  const cancellation = { operationId: randomUUID(), taskId: first.taskId };
  const noOp = await harness.client.cancel(cancellation);
  assert.equal(noOp.status, "confirmed");
  await harness.client.send({ operationId: randomUUID(), taskId: first.taskId, mode: "follow_up", input: textInput(), target: harness.target.reference, expectedPolicyRevision: 1 });
  await entered.promise;
  assert.deepEqual(await harness.client.cancel(cancellation), { ...noOp, duplicate: true });
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  assert.equal((await harness.client.wait({ taskId: first.taskId, timeoutMs: 10 })).status, "timeout");
  const activeCancellation = { operationId: randomUUID(), taskId: first.taskId };
  const activeReceipt = await harness.client.cancel(activeCancellation);
  const settled = await harness.client.wait({ taskId: first.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items.map((run) => run.outcome?.kind), ["succeeded", "canceled"]);
  assert.deepEqual(await harness.client.cancel(activeCancellation), { ...activeReceipt, status: "confirmed", duplicate: true });
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 1);
  await harness.client.send({ operationId: randomUUID(), taskId: first.taskId, mode: "follow_up", input: textInput(), target: harness.target.reference, expectedPolicyRevision: 1 });
  await waitFor(() => harness.requests.length === 1, "The fresh continuation should remain outside both earlier cancellation cuts.");
  assert.deepEqual(await harness.client.cancel(activeCancellation), { ...activeReceipt, status: "confirmed", duplicate: true });
  assert.deepEqual(await harness.client.cancel(cancellation), { ...noOp, duplicate: true });
  assert.equal((await harness.client.inspect({ taskId: first.taskId })).runs.items[2]?.phase, "waiting");
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 1);
});

for (const retryAfterFailure of [false, true]) test(`cancel reaches active and queued runs after historical pages${retryAfterFailure ? " on retry after a partial attempt" : ""}`, { timeout: 10_000 }, async (t) => {
  const cancellationId = randomUUID();
  const readFailure = new Error("Task history temporarily unavailable");
  let failNextPage = false;
  const harness = await createContinuingHarness({ maxPageRecords: 1 }, (store) => ({ ...store,
    async commit(command) {
      const receipt = await store.commit(command);
      if (retryAfterFailure && command.kind === "cancel" && command.operationId === cancellationId) failNextPage = true;
      return receipt;
    },
    async read(query) {
      if (failNextPage && query.kind === "task" && query.cursor) { failNextPage = false; throw readFailure; }
      return store.read(query);
    },
  }));
  const { entered, finish } = harness;
  t.after(async () => { finish.resolve(); await harness.close(); });
  const first = await harness.spawn();
  await harness.client.wait({ taskId: first.taskId, timeoutMs: 1_000 });
  const input = { taskId: first.taskId, input: textInput(), target: harness.target.reference, expectedPolicyRevision: 1 };
  const second = await harness.client.send({ ...input, operationId: randomUUID(), mode: "follow_up" });
  await entered.promise;
  const third = await harness.client.send({ ...input, operationId: randomUUID(), mode: "next_turn" });
  assert.equal(second.status, "queued");
  assert.equal(third.status, "queued");
  if (second.status !== "queued" || third.status !== "queued") throw new Error("Expected admitted continuations");
  const cancellation = { operationId: cancellationId, taskId: first.taskId };
  if (retryAfterFailure) {
    await assert.rejects(harness.client.cancel(cancellation), (error) => error === readFailure);
    const queued = await harness.store.read({ kind: "run", taskId: first.taskId, runId: third.admission.runId });
    assert.equal(queued.kind, "run");
    assert.equal(queued.run?.cancelRequested, false);
    assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  }
  const receipt = await harness.client.cancel(cancellation);
  assert.equal(receipt.duplicate, retryAfterFailure);
  assert.equal((await harness.client.wait({ taskId: first.taskId, timeoutMs: 1_000 })).status, "settled");
  for (const [runId, outcome] of [[first.runId, "succeeded"], [second.admission.runId, "canceled"], [third.admission.runId, "canceled"]]) {
    const result = await harness.store.read({ kind: "run", taskId: first.taskId, runId: runId! });
    assert.equal(result.kind, "run");
    assert.equal(result.run?.outcome?.kind, outcome);
  }
  assert.deepEqual(await harness.client.cancel(cancellation), { ...receipt, status: "confirmed", duplicate: true });
  assert.equal(harness.provider.calls.turns.length, 2);
  assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 1);
});

test("cancellation receipts and effects retain the same run membership across concurrent follow_up admission", { timeout: 10_000 }, async (t) => {
  const cancellationId = randomUUID();
  const lookupEntered = deferred<void>();
  const finishLookup = deferred<void>();
  let pausedLookup = false;
  let turns = 0;
  const harness = await createExecutionHarness({ allowContinuation: true, store(store) { return { ...store, async read(query) {
    if (!pausedLookup && query.kind === "operation" && query.operationId === cancellationId) {
      pausedLookup = true;
      lookupEntered.resolve();
      await finishLookup.promise;
    }
    return store.read(query);
  } }; }, provider: { transformSession(session, context) { return { ...session, startTurn: mapTurnOutputs(session, async function* (input, outputs) {
    turns += 1;
    if (turns === 1) yield* completedTurn(context, input.turnId);
    else yield* outputs;
  }) }; } } });
  t.after(async () => { finishLookup.resolve(); await harness.close(); });
  const first = await harness.spawn();
  await harness.client.wait({ taskId: first.taskId, timeoutMs: 1_000 });
  const cancellation = { operationId: cancellationId, taskId: first.taskId };
  const canceling = harness.client.cancel(cancellation);
  await lookupEntered.promise;
  let followupAdmitted = false;
  const following = harness.client.send({ operationId: randomUUID(), taskId: first.taskId, mode: "follow_up",
    input: textInput(), target: harness.target.reference, expectedPolicyRevision: 1 }).then((receipt) => { followupAdmitted = true; return receipt; });
  await setImmediate();
  if (followupAdmitted) await waitFor(() => harness.requests.length === 1, "The already-admitted follow-up should reach waiting before the cancellation lookup continues.");
  finishLookup.resolve();
  const [receipt, followup] = await Promise.all([canceling, following]);
  assert.equal(followup.status, "queued");
  if (followup.status !== "queued") throw new Error("Expected explicit continuation admission");
  const run = await harness.store.read({ kind: "run", taskId: first.taskId, runId: followup.admission.runId });
  assert.equal(run.kind, "run");
  if (run.run?.cancelRequested) {
    const settled = await harness.client.wait({ taskId: first.taskId, timeoutMs: 1_000 });
    assert.deepEqual(settled.task.runs.items[1]?.outcome, { kind: "canceled", confirmation: "provider_terminal" });
    assert.equal((await harness.client.cancel(cancellation)).status, "confirmed");
    assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 1);
  } else {
    assert.equal(receipt.status, "confirmed", "A receipt cannot claim pending cancellation for a run that received no cancellation request.");
    assert.deepEqual(await harness.client.cancel(cancellation), { ...receipt, status: "confirmed", duplicate: true });
    await waitFor(() => harness.requests.length === 1, "A follow-up admitted after the cancellation must retain its waiting executor.");
    assert.equal((await harness.client.inspect({ taskId: first.taskId })).runs.items[1]?.phase, "waiting");
    assert.equal(harness.provider.fake.snapshot().interruptedTurnIds.length, 0);
  }
});

test("queued deadlines settle without waiting for active capacity to become free", { timeout: 10_000 }, async (t) => {
  const harness = await createExecutionHarness({ limits: { maxActiveRuns: 1, queuedStartTimeoutMs: 40 } });
  t.after(() => harness.close());
  const active = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The active run should retain its waiting slot.");
  const queued = await harness.spawn();
  const expired = await harness.client.wait({ taskId: queued.taskId, timeoutMs: 1_000 });
  assert.equal(expired.status, "settled");
  assert.equal(expired.task.runs.items[0]?.outcome?.kind, "failed");
  assert.equal((await harness.client.inspect({ taskId: active.taskId })).runs.items[0]?.phase, "waiting");
  assert.equal(harness.provider.contexts.length, 1);
  assert.equal(harness.provider.calls.turns.length, 1);
});

for (const trigger of ["cancellation", "shutdown", "output consumer failure"] as const) test(`${trigger} aborts an entered answer before joining its control lane`, { timeout: 10_000 }, async (t) => {
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const failPublication = deferred<void>();
  const publishing = deferred<void>();
  const harness = await createExecutionHarness({ host: {
    async publishArtifact() { publishing.resolve(); await failPublication.promise; throw new Error("The owned output consumer failed."); },
  }, provider: { transformSession(session) { return { ...session, startTurn(input) {
    const execution = session.startTurn(input);
    return { ...execution, outputs: (async function* () {
      for await (const output of execution.outputs) {
        yield output;
        if (trigger === "output consumer failure" && output.kind === "event" && output.event.type === "request.opened") {
          yield createAgentArtifactOutput({ descriptor: { artifactId: parseAgentArtifactId("blocked-answer-output"), kind: "diff", displayName: "pending.diff", mediaType: "text/x-diff" },
            source: { kind: "bytes", bytes: new TextEncoder().encode("Pending change") }, delivery: "best_effort" });
        }
      }
    })(), async resolveRequest(response) {
      entered.resolve();
      const signal = response.signal;
      if (!signal) throw new Error("An owned answer requires its cancellation signal.");
      const abort = () => aborted.resolve();
      signal.addEventListener("abort", abort, { once: true });
      try { if (!signal.aborted) await aborted.promise; } finally { signal.removeEventListener("abort", abort); }
      return { status: "delivery_uncertain" as const, error: { category: "transport" as const, code: "answer_canceled", message: "The entered answer was canceled.", recovery: { kind: "none" as const } } };
    } };
  } }; } } });
  t.after(async () => { aborted.resolve(); failPublication.resolve(); await harness.close(); });
  const admitted = await harness.spawn();
  await waitFor(() => harness.requests.length === 1, "The exact child request must be routed before answering.");
  const request = harness.requests[0]!;
  if (request.request.requestKind !== "approval") throw new Error("Expected approval");
  const answer = harness.coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval", requestId: request.request.requestId, disposition: "selected", optionId: request.request.options[0]!.optionId,
  } });
  await entered.promise;
  const stopping = trigger === "cancellation" ? harness.client.cancel({ operationId: randomUUID(), taskId: admitted.taskId })
    : trigger === "shutdown" ? harness.coordinator.dispose({ mode: "cancel", timeoutMs: 1_000 })
      : publishing.promise.then(() => failPublication.resolve());
  await aborted.promise;
  assert.equal((await answer).status, "delivery_uncertain");
  const stopped = await stopping;
  if (trigger === "shutdown") assert.deepEqual(stopped, { status: "closed", retainedTaskIds: [] });
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.deepEqual(settled.task.runs.items[0]?.outcome, { kind: "recovery_required", reason: "request_executor_lost" });
  assert.equal(harness.provider.calls.resolutions.length, 1);
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal(harness.provider.calls.streamOwners, 1);
  assert.equal(harness.provider.calls.close, 1);
  assert.equal(harness.resourceReleases(), 1);
  assert.equal(harness.grantReleases(), 1);
});
