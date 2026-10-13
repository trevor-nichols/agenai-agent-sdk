// ------------------------------------------------------------------------------------------------
//                inboxCrash.ts - Acceptance and parent dispatch crash qualification
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createDelegationCoordinator, type DelegationParentDeliveryPort } from "@agen-ai/agent-orchestration";
import { createSqliteParentInbox, sqliteParentInboxSchema } from "../inbox/index.js";
import { openSqliteDelegationStore } from "../sqlite/index.js";
import { type CrashIdentity } from "./crash.js";
import { createReferenceHost, input, parent } from "./host.js";
import { barrier, invocationCount, persistJson, readJson, recordInvocation } from "./journal.js";
import { createParentHost, idleParent, setParent } from "./parent.js";
import { withCommit } from "./store.js";

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 3_000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, "Durable notification reconciliation timed out."); await setTimeout(1); }
}

export async function crashInbox(root: string, stage: string) {
  setParent(root, idleParent);
  const opened = openSqliteDelegationStore({ root: join(root, "database"), inboxSchema: sqliteParentInboxSchema,
    ...(stage === "inbox_accept_expired" ? { limits: { notificationTtlMs: 1_000 } } : {}) });
  const destination = createParentHost(root, { onDispatch: () => barrier("crash", { stage }) });
  const inbox = createSqliteParentInbox({ database: opened.database, host: destination.host });
  let accepted!: () => void;
  const acceptance = new Promise<void>((resolve) => { accepted = resolve; });
  const port: DelegationParentDeliveryPort = { ...inbox.port, async accept(call) {
    if (stage === "future_retry") {
      const retryAt = new Date(Date.now() + 1_500).toISOString();
      persistJson(root, "retry.json", { retryAt });
      return { status: "blocked", reason: "busy", retryAt };
    }
    const result = await inbox.port.accept(call);
    if (result.status === "accepted") {
      accepted();
      persistJson(root, "accepted.json", { ...result, expiresAt: call.envelope.expiresAt });
      if (stage !== "parent_intent") await barrier("crash", { stage, inboxId: result.inboxId });
    }
    return result;
  } };
  const reference = await createReferenceHost({ root, onInvoke: () => recordInvocation(root, "child") });
  const spawn = { operationId: randomUUID(), target: reference.target.reference, expectedPolicyRevision: 1, input, completionPolicy: "automatic" as const };
  let identity: CrashIdentity;
  const store = withCommit(opened.store, async (command) => {
    const receipt = await opened.store.commit(command);
    if (command.kind === "admit") identity = { taskId: command.taskId, runId: command.admission.runId, spawn };
    if (command.kind === "settle") identity = { ...identity, notificationId: receipt.notificationId! };
    if (command.kind === "admit" || command.kind === "settle") persistJson(root, "identity.json", identity!);
    if (stage === "future_retry" && command.kind === "delivery_receipt" && command.result.status === "blocked") await barrier("crash", { stage });
    return receipt;
  });
  const coordinator = await createDelegationCoordinator({ host: reference.host, store, limits: store.limits, parentDelivery: port });
  const client = await coordinator.bindParent({ scope: parent });
  const admitted = await client.spawn(spawn);
  await client.wait({ taskId: admitted.taskId, timeoutMs: 2_000 });
  await acceptance;
  if (stage === "parent_intent") await inbox.dispatchPending({ parent, trigger: "automatic" });
  await new Promise<void>(() => {});
}

export async function recoverInbox(root: string, stage: string) {
  const identity = readJson<CrashIdentity>(root, "identity.json");
  const original = stage === "future_retry" ? undefined : readJson<{ inboxId: string }>(root, "accepted.json");
  const retry = stage === "future_retry" ? readJson<{ retryAt: string }>(root, "retry.json") : undefined;
  const opened = openSqliteDelegationStore({ root: join(root, "database"), inboxSchema: sqliteParentInboxSchema });
  const inbox = createSqliteParentInbox({ database: opened.database, host: createParentHost(root).host });
  let accepts = 0;
  let inspections = 0;
  const port: DelegationParentDeliveryPort = { ...inbox.port,
    async accept(call) { if (retry) assert.ok(Date.now() >= Date.parse(retry.retryAt)); accepts += 1; return inbox.port.accept(call); },
    async inspect(call) { if (retry) assert.ok(Date.now() >= Date.parse(retry.retryAt)); inspections += 1; return inbox.port.inspect(call); },
  };
  const reference = await createReferenceHost({ root, onInvoke: () => recordInvocation(root, "child") });
  const coordinator = await createDelegationCoordinator({ host: reference.host, store: opened.store, limits: opened.store.limits, parentDelivery: port });
  const client = await coordinator.bindParent({ scope: parent });
  const view = await client.inspect({ taskId: identity.taskId });
  assert.deepEqual(view.runs.items[0]?.outcome, { kind: "succeeded", result: { text: "Durable result.", truncated: false, references: [] } });
  await waitFor(async () => {
    const result = await opened.store.read({ kind: "notification", notificationId: identity.notificationId! });
    assert.equal(result.kind, "notification");
    return result.notification?.state === "accepted";
  });
  const retained = inbox.inspect({ parent, storeId: opened.store.storeId, notificationId: identity.notificationId! });
  if (original) assert.equal(retained?.inboxId, original.inboxId);
  if (stage !== "parent_intent") {
    assert.ok(inspections > 0, "An unresolved acknowledgement must inspect its durable acceptance.");
    assert.equal(accepts, stage === "future_retry" ? 1 : 0);
  }
  if (stage === "parent_intent") {
    assert.equal(retained?.state, "recovery_required");
    assert.deepEqual(await inbox.dispatchPending({ parent, trigger: "automatic" }), []);
    assert.equal(invocationCount(root, "parent"), 1);
  } else if (stage === "accepted_revoked") {
    assert.equal((await inbox.dispatchPending({ parent, trigger: "automatic" }))[0]?.state, "blocked");
    assert.equal(invocationCount(root, "parent"), 0);
    assert.equal(inbox.inspect({ parent, storeId: opened.store.storeId, notificationId: identity.notificationId! })?.state, "pending");
  } else {
    assert.equal(retained?.state, "pending");
    assert.equal(invocationCount(root, "parent"), 0);
  }
  assert.equal(invocationCount(root, "child"), 1);
  assert.equal((await inbox.dispose()).status, "closed");
  assert.equal((await coordinator.dispose({ mode: "drain", timeoutMs: 1_000 })).status, "closed");
  await reference.registry.dispose();
  return { stage, inboxId: retained?.inboxId, childInvocations: invocationCount(root, "child"), parentInvocations: invocationCount(root, "parent") };
}
