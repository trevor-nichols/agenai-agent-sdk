// ------------------------------------------------------------------------------------------------
//                parentInbox.test.ts - Safe-boundary scheduling and retained completion authority
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { createSqliteParentInbox, sqliteParentInboxSchema, type ParentLifecycle } from "../inbox/index.js";
import { openSqliteDelegationStore } from "../sqlite/index.js";
import { invocationCount, temporaryRoot } from "../fixtures/journal.js";
import { createParentHost, idleParent, setParent } from "../fixtures/parent.js";
import { parent } from "../fixtures/host.js";
import { hasCode, settleRun } from "../fixtures/store.js";
import { startScenario } from "../fixtures/process.js";

test("next-turn and automatic delivery respect parent lifecycle and separately authorized safe boundaries", { timeout: 30_000 }, async (t) => {
  for (const policy of ["next_turn", "automatic"] as const) {
    for (const lifecycle of ["running", "busy", "waiting", "idle", "stopped", "paused", "retired"] satisfies ParentLifecycle[]) {
      await t.test(`${policy} while ${lifecycle}`, async (st) => {
        const directory = await temporaryRoot();
        setParent(directory.root, { ...idleParent, lifecycle });
        const opened = await openSqliteDelegationStore({ root: join(directory.root, "database"), inboxSchema: sqliteParentInboxSchema });
        const owner = await opened.store.acquireOwner();
        const destination = createParentHost(directory.root);
        const inbox = createSqliteParentInbox({ database: opened.database, host: destination.host });
        st.after(async () => { await inbox.dispose(); await opened.store.releaseOwner(owner); await directory.remove(); });
        const completion = await settleRun(opened.store, owner, policy);
        const acceptance = await inbox.port.accept({ envelope: completion.envelope, signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 1_000).toISOString() });
        if (lifecycle === "retired") {
          assert.deepEqual(acceptance, { status: "rejected", reason: "parent_retired" });
          assert.equal(inbox.inspect({ parent, storeId: opened.store.storeId, notificationId: completion.notificationId }), undefined);
        } else {
          assert.equal(acceptance.status, "accepted");
          await inbox.dispatchPending({ parent, trigger: "automatic", limit: 1 });
          const automatic = policy === "automatic" && lifecycle === "idle";
          assert.equal(invocationCount(directory.root, "parent"), automatic ? 1 : 0);
          assert.equal(inbox.inspect({ parent, storeId: opened.store.storeId, notificationId: completion.notificationId })?.state, automatic ? "acknowledged" : "pending");
          if (!automatic) {
            setParent(directory.root, idleParent);
            if (policy === "next_turn") {
              await inbox.dispatchPending({ parent, trigger: "automatic", limit: 1 });
              assert.equal(invocationCount(directory.root, "parent"), 0, "Idle next-turn entries require an explicitly authorized turn.");
            }
            await inbox.dispatchPending({ parent, trigger: policy, limit: 1 });
            assert.equal(invocationCount(directory.root, "parent"), 1);
            assert.equal(inbox.inspect({ parent, storeId: opened.store.storeId, notificationId: completion.notificationId })?.state, "acknowledged");
          }
          assert.equal(destination.releases(), 1);
        }
        const retained = await opened.store.read({ kind: "run", taskId: completion.taskId, runId: completion.runId });
        assert.equal(retained.kind, "run");
        assert.deepEqual(retained.run?.outcome, completion.envelope.outcome);
      });
    }
  }
});

test("inbox identity conflicts and expiry preserve the accepted entry and immutable child result", { timeout: 10_000 }, async (t) => {
  const directory = await temporaryRoot();
  setParent(directory.root, idleParent);
  const opened = await openSqliteDelegationStore({ root: join(directory.root, "database"), inboxSchema: sqliteParentInboxSchema, limits: { notificationTtlMs: 500 } });
  const owner = await opened.store.acquireOwner();
  const inbox = createSqliteParentInbox({ database: opened.database, host: createParentHost(directory.root).host });
  t.after(async () => { await inbox.dispose(); await opened.store.releaseOwner(owner); await directory.remove(); });
  const completion = await settleRun(opened.store, owner);
  const call = { envelope: completion.envelope, signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 1_000).toISOString() };
  const accepted = await inbox.port.accept(call);
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(await inbox.port.accept(call), accepted);
  await assert.rejects(inbox.port.accept({ ...call, envelope: { ...completion.envelope, outcome: { kind: "failed", error: {
    category: "unknown", code: "replacement", message: "Conflicting result", recovery: { kind: "unknown" },
  } } } }), /conflicting content/u);
  assert.equal(inbox.inspect({ parent, storeId: opened.store.storeId, notificationId: completion.notificationId })?.state, "pending");
  const foreignParent = { ...parent, parentId: "foreign-parent" };
  assert.throws(() => inbox.inspect({ parent: foreignParent, storeId: opened.store.storeId, notificationId: completion.notificationId }));
  await assert.rejects(inbox.port.inspect({ parent: foreignParent, storeId: opened.store.storeId, notificationId: completion.notificationId,
    signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 1_000).toISOString() }));
  setParent(directory.root, { ...idleParent, resultAccess: false });
  const dispositions = await inbox.dispatchPending({ parent, trigger: "automatic" });
  assert.equal(dispositions[0]?.state, "dismissed");
  assert.equal(invocationCount(directory.root, "parent"), 0);
  const retained = await opened.store.read({ kind: "run", taskId: completion.taskId, runId: completion.runId });
  assert.equal(retained.kind, "run");
  assert.deepEqual(retained.run?.outcome, completion.envelope.outcome);
  setParent(directory.root, idleParent);
  const expired = await settleRun(opened.store, owner);
  assert.equal((await inbox.port.accept({ ...call, envelope: expired.envelope, deadlineAt: new Date(Date.now() + 1_000).toISOString() })).status, "accepted");
  await setTimeout(Math.max(1, Date.parse(expired.envelope.expiresAt) - Date.now() + 1));
  const expiry = await inbox.dispatchPending({ parent, trigger: "automatic" });
  assert.equal(expiry[0]?.state, "dismissed");
  assert.equal(expiry[0]?.reason, "expired");
  assert.equal(invocationCount(directory.root, "parent"), 0);
  const expiredRun = await opened.store.read({ kind: "run", taskId: expired.taskId, runId: expired.runId });
  assert.equal(expiredRun.kind, "run");
  assert.deepEqual(expiredRun.run?.outcome, expired.envelope.outcome);
});

test("an active durable parent producer retains the lifetime lock until its exact lease quiesces", { timeout: 10_000 }, async (t) => {
  const directory = await temporaryRoot();
  setParent(directory.root, idleParent);
  const opened = openSqliteDelegationStore({ root: join(directory.root, "database"), inboxSchema: sqliteParentInboxSchema });
  const owner = await opened.store.acquireOwner();
  let entered!: () => void;
  const dispatchEntered = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: () => void;
  const finishDispatch = new Promise<void>((resolve) => { finish = resolve; });
  const destination = createParentHost(directory.root, { async onDispatch() { entered(); await finishDispatch; } });
  const inbox = createSqliteParentInbox({ database: opened.database, host: destination.host });
  const cleanup: { contender?: ReturnType<typeof startScenario> } = {};
  let released = false;
  t.after(async () => { finish(); await cleanup.contender?.stop(); await inbox.dispose(); if (!released) await opened.store.releaseOwner(owner); await directory.remove(); });
  const completion = await settleRun(opened.store, owner);
  await inbox.port.accept({ envelope: completion.envelope, signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 1_000).toISOString() });
  const dispatch = inbox.dispatchPending({ parent, trigger: "automatic" });
  await dispatchEntered;
  await assert.rejects(opened.store.releaseOwner(owner), hasCode("recovery_required"));
  const contender = startScenario(directory.root, "contender");
  cleanup.contender = contender;
  assert.deepEqual(await contender.complete(), { denied: true });
  assert.equal(destination.releases(), 0);
  finish();
  assert.equal((await dispatch)[0]?.state, "acknowledged");
  assert.equal(destination.releases(), 1);
  assert.equal((await inbox.dispose()).status, "closed");
  await opened.store.releaseOwner(owner);
  released = true;
  assert.throws(() => opened.assertCurrent(), hasCode("owner_lost"));
});
