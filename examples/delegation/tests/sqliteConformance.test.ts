// ------------------------------------------------------------------------------------------------
//                sqliteConformance.test.ts - Public delivery retries and durable transaction bounds
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import {
  createInMemoryDelegationStore,
  type DelegationStoreCommand,
  type DelegationHistoricalRequest,
} from "@agen-ai/agent-orchestration";
import { delegationSubordinateId } from "@agen-ai/agent-orchestration/store-adapter";
import { openSqliteDelegationStore } from "../sqlite/index.js";
import { createSqliteParentInbox, sqliteParentInboxSchema } from "../inbox/index.js";
import { parent } from "../fixtures/host.js";
import { temporaryRoot } from "../fixtures/journal.js";
import { createParentHost, idleParent, setParent } from "../fixtures/parent.js";
import { admission, fence, hasCode, prepareAndDispatch, settleRun } from "../fixtures/store.js";

for (const persistence of ["volatile", "durable"] as const) {
  test(`${persistence} delivery commits retain bounded retry identities and fence old owners`, { timeout: 10_000 }, async (t) => {
    const directory = await temporaryRoot();
    let store = persistence === "volatile" ? createInMemoryDelegationStore() : (await openSqliteDelegationStore({ root: join(directory.root, "database") })).store;
    let owner = await store.acquireOwner();
    t.after(async () => { await store.releaseOwner(owner); await directory.remove(); });
    const ids = await settleRun(store, owner);
    let logicalTime = Date.now();
    async function notification() {
      const result = await store.read({ kind: "notification", notificationId: ids.notificationId });
      assert.equal(result.kind, "notification");
      assert.ok(result.notification);
      return result.notification;
    }
    async function claim() {
      const retained = await notification();
      logicalTime = Math.max(logicalTime, Date.now(), Date.parse(retained.retryAt ?? new Date().toISOString()));
      const attemptId = delegationSubordinateId(ids.notificationId, `delivery-attempt:${retained.attempts + 1}`);
      return { ...await fence(store, owner, ids.taskId, ids.runId, delegationSubordinateId(attemptId, "claim")), kind: "delivery_claim" as const, notificationId: ids.notificationId,
        expectedNotificationRevision: retained.revision, attemptId, at: new Date(logicalTime).toISOString() };
    }
    async function receipt(attempt: Extract<DelegationStoreCommand, { kind: "delivery_claim" }>, status: "blocked" | "accepted") {
      return { ...await fence(store, owner, ids.taskId, ids.runId, delegationSubordinateId(attempt.attemptId, "receipt")), kind: "delivery_receipt" as const, notificationId: ids.notificationId,
        expectedNotificationRevision: (await notification()).revision, attemptId: attempt.attemptId, at: new Date(logicalTime).toISOString(),
        result: status === "blocked" ? { status: "blocked" as const, reason: "busy" as const, retryAt: new Date(logicalTime + 1_000).toISOString() }
          : { status: "accepted" as const, inboxId: "stable-inbox-entry", acceptedAt: new Date(logicalTime).toISOString() } };
    }
    const first = await claim();
    const claimed = await store.commit(first);
    assert.deepEqual(await store.commit(first), { ...claimed, duplicate: true });
    const firstReceipt = await receipt(first, "blocked");
    const blocked = await store.commit(firstReceipt);
    const eligible = await store.scan({ kind: "eligible_notifications", at: new Date().toISOString() });
    assert.equal(eligible.kind, "eligible_notifications");
    assert.ok(eligible.page.items.some((record) => record.envelope.notificationId === ids.notificationId),
      "Future retry facts must remain discoverable so a restarted coordinator can schedule their deadline.");
    assert.deepEqual(await store.commit(firstReceipt), { ...blocked, duplicate: true });
    await assert.rejects(store.commit({ ...firstReceipt, result: { status: "dismissed", reason: "Changed committed response" } }), hasCode("operation_conflict"));
    const second = await claim();
    await store.commit(second);
    await assert.rejects(store.commit(first), hasCode("stale_revision"));
    assert.deepEqual(await store.commit(firstReceipt), { ...blocked, duplicate: true });
    const secondReceipt = await receipt(second, "accepted");
    const accepted = await store.commit(secondReceipt);
    assert.deepEqual(await store.commit(secondReceipt), { ...accepted, duplicate: true });
    await assert.rejects(store.commit(firstReceipt), hasCode("stale_revision"));
    assert.equal((await notification()).inboxId, "stable-inbox-entry");

    const pending = await settleRun(store, owner);
    const oldAttempt = delegationSubordinateId(pending.notificationId, "delivery-attempt:1");
    const oldClaim: DelegationStoreCommand = { ...await fence(store, owner, pending.taskId, pending.runId, delegationSubordinateId(oldAttempt, "claim")), kind: "delivery_claim", notificationId: pending.notificationId,
      expectedNotificationRevision: 1, attemptId: oldAttempt, at: new Date().toISOString() };
    await store.commit(oldClaim);
    const oldOwner = owner;
    await store.releaseOwner(owner);
    if (persistence === "durable") store = (await openSqliteDelegationStore({ root: join(directory.root, "database") })).store;
    owner = await store.acquireOwner();
    await assert.rejects(store.commit(oldClaim), hasCode("owner_lost"));
    assert.ok(owner.epoch > oldOwner.epoch);
    const retained = await store.read({ kind: "notification", notificationId: pending.notificationId });
    assert.equal(retained.kind, "notification");
    assert.equal(retained.notification?.state, "claimed");
    await store.commit({ ...await fence(store, owner, pending.taskId, pending.runId, delegationSubordinateId(oldAttempt, "receipt")), kind: "delivery_receipt", notificationId: pending.notificationId,
      expectedNotificationRevision: retained.notification!.revision, attemptId: oldClaim.attemptId, at: new Date().toISOString(),
      result: { status: "uncertain", retryAt: new Date(Date.now() + 1_000).toISOString() } });
    const reset = await store.read({ kind: "notification", notificationId: pending.notificationId });
    assert.equal(reset.kind, "notification");
    assert.equal(reset.notification?.state, "pending");
    const nextAttempt = delegationSubordinateId(pending.notificationId, "delivery-attempt:2");
    await store.commit({ ...await fence(store, owner, pending.taskId, pending.runId, delegationSubordinateId(nextAttempt, "claim")), kind: "delivery_claim", notificationId: pending.notificationId,
      expectedNotificationRevision: reset.notification!.revision, attemptId: nextAttempt, at: reset.notification!.retryAt! });
  });
}

test("reference inbox transactions roll back partial writes and durable pages resume without omissions", { timeout: 10_000 }, async (t) => {
  const directory = await temporaryRoot();
  setParent(directory.root, idleParent);
  let opened = await openSqliteDelegationStore({ root: join(directory.root, "database"), limits: { maxPageRecords: 2 }, inboxSchema: sqliteParentInboxSchema });
  let owner = await opened.store.acquireOwner();
  let inbox = createSqliteParentInbox({ database: opened.database, host: createParentHost(directory.root).host });
  t.after(async () => { await inbox.dispose(); await opened.store.releaseOwner(owner); await directory.remove(); });
  const completion = await settleRun(opened.store, owner);
  const accepted = await inbox.port.accept({ envelope: completion.envelope, signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 1_000).toISOString() });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") throw new Error("Expected a real durable inbox entry.");
  assert.throws(() => opened.database.ordinaryTransaction(2_048, (database) => {
    database.prepare("UPDATE delegation_parent_inbox SET state='dismissed' WHERE inbox_id=?").run(accepted.inboxId);
    throw new Error("Fail after the first inbox mutation.");
  }), /Fail after the first inbox mutation/);
  assert.equal(inbox.inspect({ parent, storeId: opened.store.storeId, notificationId: completion.notificationId })?.state, "pending");
  const ids = new Set<string>();
  for (let index = 0; index < 7; index += 1) {
    const command = admission(owner);
    ids.add(command.admission.runId);
    await opened.store.commit(command);
  }
  await inbox.dispose();
  await opened.store.releaseOwner(owner);
  opened = await openSqliteDelegationStore({ root: join(directory.root, "database"), limits: { maxPageRecords: 2 }, inboxSchema: sqliteParentInboxSchema });
  owner = await opened.store.acquireOwner();
  inbox = createSqliteParentInbox({ database: opened.database, host: createParentHost(directory.root).host });
  assert.equal(inbox.inspect({ parent, storeId: opened.store.storeId, notificationId: completion.notificationId })?.state, "pending");
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await opened.store.scan({ kind: "queued", at: new Date().toISOString(), limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(page.kind, "queued");
    assert.ok(page.page.items.length <= 2);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= opened.store.limits.maxPageBytes);
    seen.push(...page.page.items.map((run) => run.runId));
    cursor = page.page.cursor;
  } while (cursor);
  assert.equal(seen.length, ids.size);
  assert.deepEqual(new Set(seen), ids);
});

for (const persistence of ["volatile", "durable"] as const) test(`${persistence} contract four retires eligibility independently of exact late receipts`, { timeout: 10_000 }, async (t) => {
  const directory = await temporaryRoot();
  const store = persistence === "volatile" ? createInMemoryDelegationStore() : openSqliteDelegationStore({ root: join(directory.root, "database") }).store;
  assert.equal(store.contractVersion, 4);
  const owner = await store.acquireOwner();
  t.after(async () => { await store.releaseOwner(owner); await directory.remove(); });
  const admitted = admission(owner);
  await store.commit(admitted);
  const taskId = admitted.taskId;
  const runId = admitted.admission.runId;
  await prepareAndDispatch(store, owner, taskId, runId);
  const at = new Date().toISOString();
  const request = (requestId: string): DelegationHistoricalRequest => ({ requestId, requestKind: "approval", openedAt: at, state: "waiting" });
  async function change(state: "opened" | "resolution_intended" | "unavailable", history: DelegationHistoricalRequest, operationId = randomUUID()) {
    return store.commit({ ...await fence(store, owner, taskId, runId, operationId), kind: "request_state", state,
      request: { ...history, state: state === "opened" ? "waiting" : state }, at });
  }
  async function run() {
    const result = await store.read({ kind: "run", taskId, runId });
    assert.equal(result.kind, "run");
    assert.ok(result.run);
    return result.run;
  }
  const unopenedAnswer = request("unanswered");
  await change("opened", unopenedAnswer);
  await change("unavailable", unopenedAnswer);
  assert.deepEqual([(await run()).phase, (await run()).pendingRequest?.state], ["running", "unavailable"]);
  await assert.rejects(change("resolution_intended", unopenedAnswer), hasCode("request_unavailable"));

  const first = request("late-refusal");
  const firstOperationId = randomUUID();
  await change("opened", first);
  await change("resolution_intended", first, firstOperationId);
  await change("unavailable", first);
  await store.commit({ ...await fence(store, owner, taskId, runId, firstOperationId), kind: "operation_receipt", disposition: "rejected", requestState: "pending", at });
  assert.deepEqual([(await run()).phase, (await run()).pendingRequest?.state], ["running", "unavailable"], "A truthful pending refusal cannot restore retired eligibility.");
  const refusal = await store.read({ kind: "operation", parent, operationId: firstOperationId });
  assert.equal(refusal.kind, "operation");
  assert.deepEqual([refusal.operation?.disposition, refusal.operation?.requestState], ["rejected", "pending"]);
  assert.deepEqual(refusal.operation?.request, { requestId: first.requestId, requestKind: "approval" });
  await assert.rejects(store.commit({ ...await fence(store, owner, taskId, runId, firstOperationId), kind: "operation_receipt", disposition: "delivered", at }), hasCode("operation_conflict"));

  const second = request("late-delivery");
  const secondOperationId = randomUUID();
  await change("opened", second);
  await change("resolution_intended", second, secondOperationId);
  await change("unavailable", second);
  const current = request("surviving-request");
  await change("opened", current);
  const beforeReceipt = await run();
  await store.commit({ ...await fence(store, owner, taskId, runId, secondOperationId), kind: "operation_receipt", disposition: "delivered", at });
  assert.equal((await run()).phase, "waiting");
  assert.deepEqual((await run()).pendingRequest, beforeReceipt.pendingRequest, "A late receipt belongs only to its original request.");
  const delivery = await store.read({ kind: "operation", parent, operationId: secondOperationId });
  assert.equal(delivery.kind, "operation");
  assert.equal(delivery.operation?.disposition, "delivered");
  assert.deepEqual(delivery.operation?.request, { requestId: second.requestId, requestKind: "approval" });
  const operations = await store.read({ kind: "operations", taskId, runId });
  assert.equal(operations.kind, "operations");
  assert.deepEqual(operations.page.items.filter((operation) => operation.kind === "request_resolution").map((operation) => operation.operationId).sort(),
    [firstOperationId, secondOperationId].sort(), "Retirement cannot synthesize a response operation.");
});
