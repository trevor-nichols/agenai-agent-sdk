// ------------------------------------------------------------------------------------------------
//                failure.ts - Classified child settlement and fresh-process durable delivery
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseAgentError } from "@agen-ai/agent-protocol";
import { createAgentEventOutput } from "@agen-ai/agent-runtime";
import {
  createDelegationCoordinator,
  type DelegationCompletionEnvelope,
  type DelegationCompletionPolicy,
  type DelegationNotificationRecord,
  type DelegationStore,
} from "@agen-ai/agent-orchestration";
import { createSqliteParentInbox, sqliteParentInboxSchema } from "../inbox/index.js";
import { openSqliteDelegationStore } from "../sqlite/index.js";
import { createReferenceHost, eventBase, input, parent } from "./host.js";
import { invocationCount, persistJson, readJson, recordInvocation } from "./journal.js";
import { createParentHost, idleParent, setParent } from "./parent.js";
import { withCommit } from "./store.js";

interface InboxIdentity {
  readonly inboxId: string;
  readonly acceptedAt: string;
}

export interface DurableFailureResult {
  readonly processId: number;
  readonly envelope: DelegationCompletionEnvelope;
  readonly inbox?: InboxIdentity;
  readonly dispatch?: Readonly<{ envelope: DelegationCompletionEnvelope; inboxId: string }>;
  readonly childInvocations: number;
  readonly parentInvocations: number;
}

async function notification(store: DelegationStore, notificationId: string): Promise<DelegationNotificationRecord> {
  const page = await store.read({ kind: "notification", notificationId });
  assert.equal(page.kind, "notification");
  assert.ok(page.notification);
  return page.notification;
}

async function acceptedNotification(store: DelegationStore, notificationId: string): Promise<DelegationNotificationRecord> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const retained = await notification(store, notificationId);
    if (retained.state === "accepted") return retained;
    assert.ok(Date.now() < deadline, "The classified completion must reach its durable parent inbox.");
    await setTimeout(1);
  }
}

export async function settleDurableFailure(root: string, policy: DelegationCompletionPolicy): Promise<DurableFailureResult> {
  setParent(root, { ...idleParent, executionAllowed: false });
  const opened = openSqliteDelegationStore({ root: join(root, "database"), ...(policy === "collect" ? {} : { inboxSchema: sqliteParentInboxSchema }) });
  const inbox = policy === "collect" ? undefined : createSqliteParentInbox({ database: opened.database, host: createParentHost(root).host });
  const error = parseAgentError({ category: "quota_exhausted", code: "allowance_exhausted", message: "The child allowance is exhausted.",
    recovery: { kind: "wait_for_quota", quota: { sourceId: "private-child-account", poolId: "private-child-pool", windowId: "private-child-window", observedAt: "2026-10-11T12:00:00.000Z" } },
    context: { component: "private-native-session" } });
  const reference = await createReferenceHost({ root, onInvoke: () => recordInvocation(root, "child"), async *outputs(_session, context, turn) {
    const base = eventBase(context, turn.turnId);
    yield createAgentEventOutput({ ...base, type: "turn.started", payload: {} });
    yield createAgentEventOutput({ ...base, type: "turn.completed", payload: { outcome: "failed", error } });
  } });
  let notificationId: string | undefined;
  const store = withCommit(opened.store, async (command) => {
    const receipt = await opened.store.commit(command);
    if (command.kind === "settle") notificationId = receipt.notificationId;
    return receipt;
  });
  const coordinator = await createDelegationCoordinator({ host: reference.host, store, limits: store.limits, ...(inbox ? { parentDelivery: inbox.port } : {}) });
  try {
    const client = await coordinator.bindParent({ scope: parent });
    const admitted = await client.spawn({ operationId: randomUUID(), target: reference.target.reference, expectedPolicyRevision: 1, input, completionPolicy: policy });
    const settled = await client.wait({ taskId: admitted.taskId, timeoutMs: 2_000 });
    assert.equal(settled.status, "settled");
    assert.ok(notificationId);
    const retained = inbox ? await acceptedNotification(store, notificationId) : await notification(store, notificationId);
    assert.equal(retained.state, inbox ? "accepted" : "collectible");
    assert.equal(retained.envelope.taskId, admitted.taskId);
    assert.equal(retained.envelope.runId, admitted.runId);
    assert.deepEqual(retained.envelope.outcome, settled.task.runs.items[0]?.outcome);
    const entry = inbox?.inspect({ parent, storeId: store.storeId, notificationId });
    if (inbox) assert.ok(entry);
    assert.equal(invocationCount(root, "child"), 1);
    assert.equal(invocationCount(root, "parent"), 0);
    const result: DurableFailureResult = { processId: process.pid, envelope: retained.envelope,
      ...(entry ? { inbox: { inboxId: entry.inboxId, acceptedAt: entry.acceptedAt } } : {}),
      childInvocations: invocationCount(root, "child"), parentInvocations: invocationCount(root, "parent") };
    persistJson(root, "failure-identity.json", result);
    return result;
  } finally {
    if (inbox) assert.equal((await inbox.dispose()).status, "closed");
    assert.equal((await coordinator.dispose({ mode: "drain", timeoutMs: 1_000 })).status, "closed");
    await reference.registry.dispose();
  }
}

export async function reopenDurableFailure(root: string, policy: DelegationCompletionPolicy): Promise<DurableFailureResult> {
  const original = readJson<DurableFailureResult>(root, "failure-identity.json");
  const opened = openSqliteDelegationStore({ root: join(root, "database"), ...(policy === "collect" ? {} : { inboxSchema: sqliteParentInboxSchema }) });
  const destination = createParentHost(root);
  const inbox = policy === "collect" ? undefined : createSqliteParentInbox({ database: opened.database, host: { ...destination.host,
    acquireTurn(scope) {
      const lease = destination.host.acquireTurn(scope);
      return lease && { ...lease, async dispatch(call) {
        persistJson(root, "parent-failure-input.json", { envelope: call.envelope, inboxId: call.inboxId });
        return lease.dispatch(call);
      } };
    },
  } });
  const reference = await createReferenceHost({ root, onInvoke: () => recordInvocation(root, "child") });
  const coordinator = await createDelegationCoordinator({ host: reference.host, store: opened.store, limits: opened.store.limits,
    ...(inbox ? { parentDelivery: inbox.port } : {}) });
  try {
    const client = await coordinator.bindParent({ scope: parent });
    const collected = await client.wait({ taskId: original.envelope.taskId, timeoutMs: 1_000 });
    assert.equal(collected.status, "settled");
    assert.equal(collected.task.runs.items[0]?.runId, original.envelope.runId);
    assert.deepEqual(collected.task.runs.items[0]?.outcome, original.envelope.outcome);
    const retained = await notification(opened.store, original.envelope.notificationId);
    assert.deepEqual(retained.envelope, original.envelope);
    assert.equal(invocationCount(root, "child"), 1);
    assert.equal(invocationCount(root, "parent"), 0);
    let entry = inbox?.inspect({ parent, storeId: opened.store.storeId, notificationId: original.envelope.notificationId });
    if (inbox) {
      assert.ok(entry);
      assert.deepEqual({ inboxId: entry.inboxId, acceptedAt: entry.acceptedAt }, original.inbox);
      assert.deepEqual(entry.envelope, original.envelope);
      const call = () => ({ envelope: original.envelope, signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 1_000).toISOString() });
      assert.deepEqual(await inbox.port.accept(call()), { status: "accepted", ...original.inbox });
      assert.deepEqual(await inbox.dispatchPending({ parent, trigger: policy === "next_turn" ? "next_turn" : "automatic" }),
        [{ inboxId: entry.inboxId, state: "blocked", reason: "execution_unavailable" }]);
      assert.equal(invocationCount(root, "parent"), 0, "A recovery hint cannot grant current parent execution authority.");
      setParent(root, idleParent);
      if (policy === "next_turn") {
        assert.deepEqual(await inbox.dispatchPending({ parent, trigger: "automatic" }), []);
        assert.equal(invocationCount(root, "parent"), 0, "Next-turn delivery still needs an explicit parent turn boundary.");
      }
      assert.equal(invocationCount(root, "parent"), 0, "Reopening or granting authority cannot dispatch a parent by itself.");
      assert.deepEqual(await inbox.dispatchPending({ parent, trigger: policy === "next_turn" ? "next_turn" : "automatic" }),
        [{ inboxId: entry.inboxId, state: "acknowledged" }]);
      assert.deepEqual(await inbox.dispatchPending({ parent, trigger: "next_turn" }), []);
      assert.deepEqual(await inbox.port.accept(call()), { status: "accepted", ...original.inbox });
      assert.deepEqual(await inbox.dispatchPending({ parent, trigger: "automatic" }), []);
      entry = inbox.inspect({ parent, storeId: opened.store.storeId, notificationId: original.envelope.notificationId });
      assert.equal(entry?.state, "acknowledged");
      assert.equal(destination.releases(), 1);
    }
    assert.equal(invocationCount(root, "child"), 1);
    assert.equal(invocationCount(root, "parent"), inbox ? 1 : 0);
    return { processId: process.pid, envelope: retained.envelope,
      ...(entry ? { inbox: { inboxId: entry.inboxId, acceptedAt: entry.acceptedAt },
        dispatch: readJson<{ envelope: DelegationCompletionEnvelope; inboxId: string }>(root, "parent-failure-input.json") } : {}),
      childInvocations: invocationCount(root, "child"), parentInvocations: invocationCount(root, "parent") };
  } finally {
    if (inbox) assert.equal((await inbox.dispose()).status, "closed");
    assert.equal((await coordinator.dispose({ mode: "drain", timeoutMs: 1_000 })).status, "closed");
    await reference.registry.dispose();
  }
}
