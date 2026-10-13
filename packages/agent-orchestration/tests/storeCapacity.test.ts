// ------------------------------------------------------------------------------------------------
//                storeCapacity.test.ts - Reserved settlement and control under bounded retention
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { at, createStoreFixture, digest, hasCode } from "./fixtures/execution/store.js";

test("ordinary ledger exhaustion preserves canonical cancellation, interruption and both cleanup slots", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture({ maxOrdinaryOperationsPerRun: 3 });
  await fixture.running();
  await assert.rejects(fixture.intent("steer"), hasCode("capacity_exceeded"));
  const cancel = { ...await fixture.fence(), kind: "cancel" as const, at, reason: "User canceled" };
  const first = await fixture.store.commit(cancel);
  const repeated = await fixture.store.commit(cancel);
  assert.equal(repeated.operationId, first.operationId);
  assert.equal(repeated.duplicate, true);
  await assert.rejects(fixture.store.commit({ ...await fixture.fence(), kind: "cancel", at, reason: "Repeated user cancel" }), hasCode("operation_conflict"));
  await fixture.receipt(await fixture.intent("interrupt"));
  const close = await fixture.intent("session_close");
  await assert.rejects(fixture.receipt(close, "delivered"));
  await fixture.receipt(close, "uncertain");
  const retry = { ...await fixture.fence(close.operationId, close.inputDigest), kind: "dispatch_intent" as const, operationKind: "session_close" as const, attempt: 2 as const, at };
  const retried = await fixture.store.commit(retry);
  assert.deepEqual(await fixture.store.commit(retry), { ...retried, duplicate: true });
  await fixture.receipt(close);
  await fixture.receipt(await fixture.intent("binding_cleanup"));
  const settled = await fixture.store.commit({ ...await fixture.fence(), kind: "settle", at,
    outcome: { kind: "canceled", confirmation: "provider_terminal" } });
  assert.equal(settled.status, "settled");
  assert.ok(settled.notificationId);
  const operations = await fixture.store.read({ kind: "operations", taskId: fixture.taskId, runId: fixture.runId });
  assert.equal(operations.kind, "operations");
  assert.equal(operations.page.items.filter((operation) => operation.kind === "cancel").length, 1);
  assert.deepEqual(new Set(operations.page.items.filter((operation) => ["cancel", "interrupt", "session_close", "binding_cleanup"].includes(operation.kind)).map((operation) => operation.kind)),
    new Set(["cancel", "interrupt", "session_close", "binding_cleanup"]));
});

test("observation saturation records one omission indication and still atomically settles one completion", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture({ maxRunObservations: 1 });
  await fixture.running();
  for (let index = 1; index <= 4; index += 1) {
    await fixture.store.commit({ ...await fixture.fence(), kind: "observe", observation: {
      storeId: fixture.store.storeId, taskId: fixture.taskId, runId: fixture.runId, index,
      at, kind: "text", text: `Output ${index}`,
    } });
  }
  const observations = await fixture.store.read({ kind: "observations", taskId: fixture.taskId, runId: fixture.runId });
  assert.equal(observations.kind, "observations");
  assert.equal(observations.gap, true);
  assert.equal(observations.page.items.filter((observation) => observation.kind === "text").length, 1);
  assert.equal(observations.page.items.filter((observation) => observation.kind === "omitted").length, 1);
  const outcome = { kind: "succeeded" as const, result: { text: "Bounded final answer", truncated: false, references: [] } };
  const command = { ...await fixture.fence(), kind: "settle" as const, at, outcome };
  const settled = await fixture.store.commit(command);
  assert.deepEqual(await fixture.store.commit(command), { ...settled, duplicate: true });
  assert.ok(settled.notificationId);
  const notification = await fixture.store.read({ kind: "notification", notificationId: settled.notificationId });
  assert.equal(notification.kind, "notification");
  assert.equal(notification.notification?.state, "collectible");
  assert.deepEqual(notification.notification?.envelope.outcome, outcome);
  await assert.rejects(fixture.store.commit({ ...await fixture.fence(), kind: "settle", at,
    outcome: { kind: "failed", error: { category: "unknown", code: "late_failure", message: "Cannot replace final truth", recovery: { kind: "unknown" } } } }), hasCode("operation_conflict"));
});

test("failed admission leaves task, input and reserved capacity unchanged", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture({ maxTasks: 1 });
  await fixture.admit();
  const before = await fixture.store.read({ kind: "capacity" });
  await assert.rejects(fixture.store.commit({ ...fixture.admission, taskId: randomUUID(), operationId: randomUUID(), inputDigest: digest("second admission"),
    admission: { ...fixture.admission.admission, runId: randomUUID() } }), hasCode("capacity_exceeded"));
  assert.deepEqual(await fixture.store.read({ kind: "capacity" }), before);
});
