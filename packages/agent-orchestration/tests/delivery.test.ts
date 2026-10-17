// ------------------------------------------------------------------------------------------------
//                delivery.test.ts - Inbox compatibility, retry truth and delivery producer ownership
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { parseAgentError } from "@agen-ai/agent-protocol";
import { createAgentEventOutput, createAgentProviderRegistry } from "@agen-ai/agent-runtime";
import {
  createDelegationCoordinator, createInMemoryDelegationStore,
  type DelegationCompletionEnvelope, type DelegationHost, type DelegationLimits,
  type DelegationParentDeliveryPort, type DelegationPersistence, type DelegationStore,
} from "../src/index.js";
import { enabledPolicy, makeCatalog, makeTarget } from "./fixtures.js";
import { scope, textInput, waitFor } from "./fixtures/execution/harness.js";
import { completedTurn, createExecutionProvider, deferred, eventBase, type ProviderHooks, mapTurnOutputs } from "./fixtures/execution/provider.js";
import { at, hasCode } from "./fixtures/execution/store.js";

async function createHarness(options: {
  readonly port?: DelegationParentDeliveryPort;
  readonly persistence?: DelegationPersistence;
  readonly limits?: Partial<DelegationLimits>;
  readonly provider?: ProviderHooks;
  readonly onRequest?: DelegationHost["onRequest"];
  readonly store?: (store: DelegationStore) => DelegationStore;
} = {}) {
  const provider = createExecutionProvider(options.provider ?? { transformSession: (session, context) => ({ ...session, startTurn: mapTurnOutputs(session, (turn) => completedTurn(context, turn.turnId)) }) });
  const registry = await createAgentProviderRegistry({ drivers: [provider.driver], definitions: [provider.definition] });
  const target = makeTarget("standard", { instanceId: provider.definition.instanceId, providerKey: provider.definition.providerKey, modelId: "fake-model" });
  const catalog = makeCatalog([target]);
  const base = createInMemoryDelegationStore({ limits: options.limits });
  let releases = 0;
  let admissions = 0;
  let notificationId: string | undefined;
  const store: DelegationStore = { ...base, persistence: options.persistence ?? "volatile", async commit(command) {
    const receipt = await base.commit(command);
    if (command.kind === "admit" && !receipt.duplicate) admissions += 1;
    if (command.kind === "settle") notificationId = receipt.notificationId;
    return receipt;
  }, async releaseOwner(owner) { releases += 1; await base.releaseOwner(owner); } };
  const host: DelegationHost = {
    registry, currentPolicy: (parent) => ({ scope: parent, catalog, policy: enabledPolicy() }),
    assertResultAccess() {}, assertControl() {}, assertRequestAccess() {}, onRequest: options.onRequest ?? (() => {}),
    acquireExecution: () => ({ signal: new AbortController().signal, assertCurrent() {}, release() {} }),
    acquireChildResources: () => ({ workingDirectory: { policy: "isolated", authorizedRef: "directory", path: "/host/delegated" }, release() {} }),
    verifyAppliedConfiguration: ({ target: applied }) => ({ target: applied.reference, configuration: applied.application.configuration }),
  };
  const configuredStore = options.store?.(store) ?? store;
  const coordinator = await createDelegationCoordinator({ host, store: configuredStore, limits: store.limits, ...(options.port ? { parentDelivery: options.port } : {}) })
    .catch(async (error: unknown) => { await registry.dispose(); throw error; });
  const client = await coordinator.bindParent({ scope });
  async function notification() {
    if (!notificationId) return undefined;
    const page = await store.read({ kind: "notification", notificationId });
    assert.equal(page.kind, "notification");
    return page.notification;
  }
  return { provider, registry, store, coordinator, client, notification,
    spawn: (completionPolicy: "collect" | "next_turn" | "automatic" = "automatic") => client.spawn({ operationId: randomUUID(), target: target.reference, expectedPolicyRevision: 1, input: textInput(), completionPolicy }),
    releases: () => releases, admissions: () => admissions,
    async close() { await coordinator.dispose({ mode: "cancel", timeoutMs: 1_000 }); await registry.dispose(); },
  };
}

test("collect retains results without an inbox while unsupported delivery fails before admission", { timeout: 10_000 }, async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  for (const policy of ["next_turn", "automatic"] as const) await assert.rejects(harness.spawn(policy), hasCode("unsupported_operation"));
  assert.equal(harness.admissions(), 0);
  assert.equal(harness.provider.contexts.length, 0);
  const admitted = await harness.spawn("collect");
  assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 })).status, "settled");
  assert.equal((await harness.notification())?.state, "collectible");
});

test("durable execution rejects a process-local parent port before acquiring execution ownership", { timeout: 10_000 }, async () => {
  let calls = 0;
  let acquisitions = 0;
  let commits = 0;
  const port: DelegationParentDeliveryPort = { persistence: "volatile", async inspect() { calls += 1; return { status: "absent" }; },
    async accept() { calls += 1; return { status: "uncertain" }; } };
  await assert.rejects(createHarness({ port, persistence: "durable", store: (store) => ({ ...store,
    acquireOwner() { acquisitions += 1; return store.acquireOwner(); },
    commit(command) { commits += 1; return store.commit(command); },
  }) }), hasCode("unsupported_operation"));
  assert.equal(calls, 0);
  assert.equal(acquisitions, 0);
  assert.equal(commits, 0);
});

test("the coordinator refuses an older store contract before acquiring ownership or reading retained work", { timeout: 10_000 }, async () => {
  let calls = 0;
  await assert.rejects(createHarness({ store: (store) => ({ ...store, contractVersion: 3,
    acquireOwner() { calls += 1; return store.acquireOwner(); },
    read(input: Parameters<DelegationStore["read"]>[0]) { calls += 1; return store.read(input); },
    scan(input: Parameters<DelegationStore["scan"]>[0]) { calls += 1; return store.scan(input); },
  }) as unknown as DelegationStore }), hasCode("store_failed"));
  assert.equal(calls, 0);
});

for (const policy of ["next_turn", "automatic"] as const) test(`${policy} completion delivery waits for the original child terminal after its answer receipt`, { timeout: 10_000 }, async (t) => {
  const requested = deferred<Parameters<DelegationHost["onRequest"]>[0]>();
  const terminalReady = deferred<void>();
  const finish = deferred<void>();
  const accepted: DelegationCompletionEnvelope[] = [];
  const harness = await createHarness({ onRequest(request) { requested.resolve(request); },
    port: { persistence: "volatile", async inspect() { return { status: "absent" }; }, async accept({ envelope }) {
      accepted.push(envelope);
      return { status: "accepted", inboxId: "child-completion", acceptedAt: new Date().toISOString() };
    } },
    provider: { transformSession(session) { return { ...session, startTurn: mapTurnOutputs(session, async function* (_input, outputs) {
      for await (const output of outputs) {
        if (output.kind === "event" && output.event.type === "turn.completed") {
          terminalReady.resolve();
          await finish.promise;
        }
        yield output;
      }
    }) }; } },
  });
  t.after(async () => { finish.resolve(); await harness.close(); });
  const admitted = await harness.spawn(policy);
  const request = await requested.promise;
  assert.equal((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.phase, "waiting");
  assert.equal(await harness.notification(), undefined);
  assert.equal(accepted.length, 0);
  if (request.request.requestKind !== "approval") throw new Error("Expected the child approval request.");
  const receipt = await harness.coordinator.resolveRequest({ handle: request.handle, operationId: randomUUID(), resolution: {
    requestKind: "approval", requestId: request.request.requestId, disposition: "selected", optionId: request.request.options[0]!.optionId,
  } });
  assert.equal(receipt.status, "delivered");
  await terminalReady.promise;
  const active = (await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]!;
  assert.equal(active.phase, "running");
  assert.equal(active.outcome, undefined);
  assert.equal(await harness.notification(), undefined);
  assert.equal(accepted.length, 0);
  assert.equal(harness.provider.calls.resolutions.length, 1);

  finish.resolve();
  assert.equal((await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 })).status, "settled");
  await waitFor(async () => (await harness.notification())?.state === "accepted", "Only the child terminal should schedule its completion delivery.");
  assert.equal(accepted.length, 1);
  assert.deepEqual({ taskId: accepted[0]!.taskId, runId: accepted[0]!.runId, policy: accepted[0]!.policy, outcome: accepted[0]!.outcome }, {
    taskId: admitted.taskId, runId: admitted.runId, policy,
    outcome: { kind: "succeeded", result: { text: "Deterministic fake output.", truncated: false, references: [] } },
  });
  assert.equal((await harness.notification())?.inboxId, "child-completion");
  assert.equal(harness.provider.calls.turns.length, 1);
  assert.equal(harness.provider.calls.streamOwners, 1);
});

for (const policy of ["next_turn", "automatic"] as const) test(`${policy} classified delivery reconciles a lost inbox acknowledgement before another accept`, { timeout: 10_000 }, async (t) => {
  let accepted: { status: "accepted"; inboxId: string; acceptedAt: string } | undefined;
  let delivered: DelegationCompletionEnvelope | undefined;
  let accepts = 0;
  let inspectedAfterAcceptance = false;
  const port: DelegationParentDeliveryPort = { persistence: "volatile", async inspect() {
    if (accepted) inspectedAfterAcceptance = true;
    return accepted ?? { status: "absent" };
  }, async accept({ envelope }) {
    accepts += 1;
    delivered = envelope;
    accepted = { status: "accepted", inboxId: "logical-inbox-entry", acceptedAt: new Date().toISOString() };
    return { status: "uncertain" };
  } };
  const error = parseAgentError({ category: "rate_limited", code: "request_throttled", message: "Wait before another request.", recovery: { kind: "retry", notBefore: at } });
  const harness = await createHarness({ port, provider: { transformSession(session, context) {
    return { ...session, startTurn: mapTurnOutputs(session, async function* (turn) {
      const base = eventBase(context, turn.turnId);
      yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
      yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "failed", error } });
    }) };
  } } });
  t.after(() => harness.close());
  const admitted = await harness.spawn(policy);
  await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
  await waitFor(async () => (await harness.notification())?.state === "accepted", "A retained uncertain delivery should reconcile its inbox acceptance.");
  assert.equal(inspectedAfterAcceptance, true);
  assert.equal(accepts, 1);
  assert.equal((await harness.notification())?.inboxId, accepted!.inboxId);
  assert.deepEqual(delivered?.outcome, { kind: "failed", error });
  assert.equal(delivered?.policy, policy);
  assert.equal(delivered?.taskId, admitted.taskId);
  assert.equal(delivered?.runId, admitted.runId);
  assert.deepEqual((await harness.notification())?.envelope, delivered);
  assert.deepEqual((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.outcome, delivered?.outcome);
  assert.equal(harness.provider.calls.turns.length, 1);
});

test("shutdown during overdue reconciliation preserves uncertain inbox truth", { timeout: 10_000 }, async (t) => {
  const claimed = deferred<void>();
  const release = deferred<void>();
  let claims = 0;
  let inspections = 0;
  const harness = await createHarness({ limits: { notificationTtlMs: 200 },
    port: { persistence: "volatile", async accept() { return { status: "uncertain" }; },
      async inspect() { inspections += 1; return { status: "absent" }; } },
    store: (store) => ({ ...store, async commit(command) {
      const receipt = await store.commit(command);
      if (command.kind === "delivery_claim" && ++claims === 2) { claimed.resolve(); await release.promise; }
      return receipt;
    } }),
  });
  t.after(async () => { release.resolve(); await harness.close(); });
  await harness.spawn();
  await claimed.promise;
  assert.equal((await harness.coordinator.dispose({ mode: "drain", timeoutMs: 20 })).status, "recovery_required");
  release.resolve();
  await waitFor(async () => (await harness.notification())?.state !== "claimed", "Shutdown must release its claim with retained uncertainty.");
  assert.equal((await harness.notification())?.state, "pending");
  assert.equal((await harness.notification())?.reason, "uncertain");
  assert.equal(inspections, 0);
});

for (const scenario of ["accepted", "absent", "inspection retry"] as const) test(`expired uncertain delivery reconciles ${scenario} after its callback quiesces`, { timeout: 10_000 }, async (t) => {
  const entered = deferred<DelegationCompletionEnvelope>();
  const aborted = deferred<void>();
  const finish = deferred<void>();
  let accepted: { status: "accepted"; inboxId: string; acceptedAt: string } | undefined;
  let accepts = 0;
  let inspections = 0;
  const port: DelegationParentDeliveryPort = { persistence: "volatile", async accept({ envelope, signal }) {
    accepts += 1;
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    entered.resolve(envelope);
    await finish.promise;
    if (scenario !== "absent") accepted = { status: "accepted", inboxId: "late-inbox-entry", acceptedAt: new Date().toISOString() };
    return accepted ?? { status: "uncertain" };
  }, async inspect({ deadlineAt, signal }) {
    inspections += 1;
    assert.equal(signal.aborted, false);
    assert.ok(Date.parse(deadlineAt) > Date.now(), "Reconciliation needs its own bounded deadline after notification expiry.");
    if (scenario === "inspection retry" && inspections === 1) throw new Error("Inbox temporarily unavailable");
    return accepted ?? { status: "absent" };
  } };
  const harness = await createHarness({ port, limits: { notificationTtlMs: 200, controlTimeoutMs: 40 } });
  t.after(async () => { finish.resolve(); await harness.close(); });
  await harness.spawn();
  const envelope = await entered.promise;
  await aborted.promise;
  await setTimeout(Math.max(1, Date.parse(envelope.expiresAt) - Date.now() + 1));
  assert.equal((await harness.notification())?.state, "pending");
  assert.equal(inspections, 0, "The timed-out accept must quiesce before reconciliation starts.");
  finish.resolve();
  await waitFor(async () => inspections > 0 || (await harness.notification())?.state === "expired", "Uncertain delivery must reconcile after expiry.");
  assert.equal(inspections, 1);
  if (scenario === "inspection retry") {
    await waitFor(async () => { const notification = await harness.notification(); return notification?.state === "pending" && notification.attempts === 2; }, "Failed inspection must retain uncertainty.");
    assert.ok(Date.parse((await harness.notification())!.retryAt!) > Date.now() + 1_000, "Reconciliation failure must retain bounded backoff after expiry.");
  }
  await waitFor(async () => ["accepted", "expired"].includes((await harness.notification())?.state ?? ""), "Reconciliation should settle retained delivery truth.");
  const notification = await harness.notification();
  assert.equal(notification?.state, scenario === "absent" ? "expired" : "accepted");
  assert.equal(notification?.inboxId, accepted?.inboxId);
  assert.equal(inspections, scenario === "inspection retry" ? 2 : 1);
  assert.equal(accepts, 1, "Expired delivery must never issue another accept.");
});

test("definitive inbox dispositions preserve independent success, failure, cancellation and uncertainty outcomes", { timeout: 10_000 }, async (t) => {
  for (const outcome of ["completed", "failed", "canceled", "incomplete"] as const) await t.test(outcome, async (st) => {
    let delivered: DelegationCompletionEnvelope | undefined;
    const harness = await createHarness({ port: { persistence: "volatile", async inspect() { return { status: "absent" }; }, async accept({ envelope }) {
      delivered = envelope;
      return { status: "rejected", reason: "dismissed" };
    } }, provider: { transformSession(session, context) { return { ...session, startTurn: mapTurnOutputs(session, async function* (turn) {
      const base = eventBase(context, turn.turnId);
      yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
      if (outcome !== "incomplete") yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome,
        ...(outcome === "failed" ? { error: { code: "authentication_required", message: "The child requires authentication.", category: "authentication", recovery: { kind: "user_action", action: "authenticate" } } } : {}) } });
    }) }; } } });
    st.after(() => harness.close());
    const admitted = await harness.spawn();
    const settled = await harness.client.wait({ taskId: admitted.taskId, timeoutMs: 1_000 });
    await waitFor(async () => (await harness.notification())?.state === "dismissed", "Definitive inbox dismissal should settle delivery independently.");
    const expected = outcome === "completed" ? "succeeded" : outcome === "incomplete" ? "recovery_required" : outcome;
    assert.equal(settled.task.runs.items[0]?.outcome?.kind, expected);
    if (outcome === "failed") assert.deepEqual(delivered?.outcome, { kind: "failed", error: {
      category: "authentication", code: "authentication_required", message: "The child requires authentication.", recovery: { kind: "user_action", action: "authenticate" },
    } });
    assert.deepEqual(delivered?.outcome, settled.task.runs.items[0]?.outcome);
    assert.deepEqual((await harness.client.inspect({ taskId: admitted.taskId })).runs.items[0]?.outcome, delivered?.outcome);
  });
});

test("delivery shutdown aborts a cooperative port and retains ownership while an unquiesced callback survives", { timeout: 10_000 }, async (t) => {
  for (const cooperative of [true, false]) await t.test(cooperative ? "abort-aware inbox" : "unquiesced inbox", async (st) => {
    const entered = deferred<AbortSignal>();
    const finish = deferred<void>();
    let aborted = false;
    const port: DelegationParentDeliveryPort = { persistence: "volatile", async inspect() { return { status: "absent" }; }, async accept({ signal }) {
      entered.resolve(signal);
      signal.addEventListener("abort", () => { aborted = true; if (cooperative) finish.resolve(); }, { once: true });
      await finish.promise;
      return { status: "uncertain" };
    } };
    const harness = await createHarness({ port, limits: { controlTimeoutMs: 100 } });
    st.after(async () => { finish.resolve(); await harness.close(); });
    await harness.spawn();
    const signal = await entered.promise;
    const receipt = await harness.coordinator.dispose({ mode: "drain", timeoutMs: 250 });
    assert.equal(signal.aborted, true);
    assert.equal(aborted, true);
    if (cooperative) {
      assert.equal(receipt.status, "closed");
      assert.equal(harness.releases(), 1);
    } else {
      assert.equal(receipt.status, "recovery_required");
      assert.equal(harness.releases(), 0);
      finish.resolve();
      await waitFor(async () => (await harness.notification())?.state === "pending", "Late acceptance completion should retain retry truth before closing.");
      assert.equal((await harness.coordinator.dispose({ mode: "drain", timeoutMs: 1_000 })).status, "closed");
      assert.equal(harness.releases(), 1);
    }
  });
});
