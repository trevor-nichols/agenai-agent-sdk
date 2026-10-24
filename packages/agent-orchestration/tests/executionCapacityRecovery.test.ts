// ------------------------------------------------------------------------------------------------
//                executionCapacityRecovery.test.ts - Saturation, storage loss and no-replay recovery
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseAgentArtifactId } from "@agen-ai/agent-protocol";
import { createAgentArtifactOutput, createAgentEventOutput } from "@agen-ai/agent-runtime";
import { createExecutionHarness, textInput, waitFor } from "./fixtures/execution/harness.js";
import { deferred, eventBase, mapTurnOutputs } from "./fixtures/execution/provider.js";
import { at, createStoreFixture, hasCode } from "./fixtures/execution/store.js";

test("observation saturation continues consuming outputs and retains bounded final truth", { timeout: 10_000 }, async (t) => {
  for (const escaped of [false, true]) await t.test(escaped ? "escaped multibyte result with published references" : "small complete result", async (st) => {
    let outputs = 0;
    let notificationId: string | undefined;
    const deltas = escaped ? ['"\\\u0000界'.repeat(900), '"\\\u0000界'.repeat(900), "middle ", "last."] : ["First ", "middle ", "last."];
    const harness = await createExecutionHarness({ limits: { maxRunObservations: 2 }, store(store) { return { ...store, async commit(command) {
      const receipt = await store.commit(command);
      if (command.kind === "settle") notificationId = receipt.notificationId;
      return receipt;
    } }; }, host: {
      publishArtifact({ candidate }) { return { id: candidate.descriptor.artifactId, kind: "artifact", digest: candidate.descriptor.digest!.value }; },
    }, provider: { transformSession(session, context) {
      return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
        const base = eventBase(context, input.turnId);
        yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
        yield createAgentEventOutput({ ...base, type: "item.started", payload: { itemId: "answer", itemKind: "assistant_message", status: "in_progress" } });
        if (escaped) for (let index = 0; index < 8; index += 1) yield createAgentArtifactOutput({
          descriptor: { artifactId: parseAgentArtifactId(`artifact:${index}`), kind: "diff", displayName: "change.diff", mediaType: "text/x-diff" },
          source: { kind: "bytes", bytes: new TextEncoder().encode("artifact body") }, delivery: "best_effort",
        });
        for (const delta of deltas) {
          outputs += 1;
          yield createAgentEventOutput({ ...base, type: "content.delta", payload: { itemId: "answer", streamKind: "assistant_text", delta } });
        }
        yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { structuredOutput: { kind: "not_requested" }, outcome: "completed" } });
      }) };
    } } });
    st.after(() => harness.close());
    const admitted = await harness.spawn();
    const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
    assert.equal(settled.status, "settled");
    const outcome = settled.task.runs.items[0]?.outcome;
    assert.equal(outcome?.kind, "succeeded", JSON.stringify({ outcome, producedTextDeltas: outputs }));
    if (outcome?.kind !== "succeeded") throw new Error("Expected bounded successful result");
    if (escaped) {
      assert.equal(outcome.result.truncated, true);
      assert.equal(outcome.result.references.length, 8);
      assert.ok(Buffer.byteLength(JSON.stringify(outcome.result)) <= 8_192);
    } else assert.equal(outcome.result.text, "First middle last.");
    assert.equal(outputs, deltas.length);
    const retained = await harness.store.read({ kind: "observations", taskId: admitted.taskId, runId: admitted.runId });
    assert.equal(retained.kind, "observations");
    assert.equal(retained.gap, true);
    assert.equal(retained.page.items.filter((observation) => observation.kind === "omitted").length, 1);
    assert.ok(notificationId);
    const completion = await harness.store.read({ kind: "notification", notificationId });
    assert.equal(completion.kind, "notification");
    assert.deepEqual(completion.notification?.envelope.outcome, outcome);
    assert.ok(Buffer.byteLength(JSON.stringify(completion.notification?.envelope)) <= 32_768);
  });
});

test("ordinary ledger saturation rejects new steering while reserved cancellation still settles", { timeout: 10_000 }, async (t) => {
  const entered = deferred<void>();
  const finish = deferred<void>();
  const harness = await createExecutionHarness({ limits: { maxOrdinaryOperationsPerRun: 3 }, provider: { transformSession(session, context) {
    const interruption = session.interruption;
    if (interruption.kind !== "supported") throw new Error("Expected fake interruption");
    return { ...session, startTurn: mapTurnOutputs(session, async function* (input) {
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
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await entered.promise;
  await assert.rejects(harness.client.send({ operationId: randomUUID(), taskId: admitted.taskId, mode: "steer",
    input: textInput(), target: harness.target.reference, expectedPolicyRevision: 1 }), hasCode("capacity_exceeded"));
  assert.equal(harness.provider.fake.snapshot().steeringInputs.length, 0);
  await harness.client.cancel({ operationId: randomUUID(), taskId: admitted.taskId });
  const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  assert.equal(settled.task.runs.items[0]?.outcome?.kind, "canceled");
  await waitFor(() => harness.resourceReleases() === 1, "Reserved cleanup should release resources after terminal truth.");
});

test("storage failure after dispatch retires execution conservatively and never retries the provider", { timeout: 10_000 }, async (t) => {
  let failed = false;
  const harness = await createExecutionHarness({ store(store) { return { ...store, async commit(command) {
    if (!failed && command.kind === "observe" && command.observation.kind === "text") {
      failed = true;
      throw new Error("Observation commit unavailable");
    }
    return store.commit(command);
  } }; } });
  t.after(() => harness.close());
  const admitted = await harness.spawn();
  await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 }).catch((error: unknown) => { assert.ok(hasCode("owner_lost")(error)); });
  await waitFor(async () => (await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.outcome?.kind === "recovery_required",
    "Storage loss must retain conservative final truth after owned cleanup.");
  assert.equal(harness.provider.calls.turns.length, 1);
  const recovered = await harness.coordinator.recover({ limit: 100 });
  assert.equal(recovered.recovered.some((run) => run.disposition === "queued"), false);
  assert.equal(harness.provider.calls.turns.length, 1);
});

test("prior-owner dispatched and waiting runs recover as history without recreating provider or request handles", { timeout: 10_000 }, async (t) => {
  for (const waiting of [false, true]) {
    await t.test(waiting ? "waiting request" : "dispatched turn", async (st) => {
      const fixture = await createStoreFixture();
      await fixture.running();
      if (waiting) await fixture.store.commit({ ...await fixture.fence(), kind: "request_state", state: "opened", at,
        request: { requestId: "prior-request", requestKind: "approval", openedAt: at, state: "waiting" } });
      await fixture.store.releaseOwner(fixture.owner);
      const harness = await createExecutionHarness({ store: () => fixture.store });
      st.after(() => harness.close());
      const recovered = await harness.coordinator.recover({ limit: 100 });
      assert.deepEqual(recovered.recovered, [], "Construction already settled prior-owner recovery before scheduling any new work.");
      const view = await harness.client.inspect({ taskId: fixture.taskId });
      assert.equal(view.task.state, "recovery_required");
      assert.equal(view.runs.items[0]?.outcome?.kind, "recovery_required");
      assert.equal(harness.provider.contexts.length, 0);
      assert.equal(harness.provider.calls.turns.length, 0);
      assert.equal(harness.requests.length, 0);
    });
  }
});
