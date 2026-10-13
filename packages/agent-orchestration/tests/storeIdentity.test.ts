// ------------------------------------------------------------------------------------------------
//                storeIdentity.test.ts - Scoped replay, ownership and atomic mutation fences
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createStoreFixture, digest, hasCode, parent } from "./fixtures/execution/store.js";

test("admission replay returns its original receipt after later transitions and rejects conflicting input", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture();
  const admitted = await fixture.admit();
  await fixture.receipt(await fixture.intent("prepare"));
  assert.deepEqual(await fixture.admit(), { ...admitted, duplicate: true });
  await assert.rejects(fixture.store.commit({ ...fixture.admission, inputDigest: digest("different task") }), hasCode("operation_conflict"));
  const capacity = await fixture.store.read({ kind: "capacity" });
  assert.equal(capacity.kind, "capacity");
  assert.equal(capacity.capacity.tasks, 1);
  assert.equal(capacity.capacity.runs, 1);
  const wrongScope = await fixture.store.read({ kind: "operation", parent: { ...parent, scopeId: "other-scope" }, operationId: fixture.admission.operationId });
  assert.equal(wrongScope.kind, "operation");
  assert.equal(wrongScope.operation, undefined);
});

test("concurrent commands using one revision admit exactly one mutation without leaking capacity", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture();
  await fixture.admit();
  const fence = await fixture.fence();
  const commands = [fence, { ...fence, operationId: randomUUID(), inputDigest: digest("competing preparation") }]
    .map((item) => ({ ...item, kind: "dispatch_intent" as const, operationKind: "prepare" as const, at: "2026-10-10T12:00:01.000Z" }));
  const results = await Promise.allSettled(commands.map((command) => fixture.store.commit(command)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && hasCode("stale_revision")(rejected.reason));
  assert.equal((await fixture.run()).phase, "preparing");
  const operations = await fixture.store.read({ kind: "operations", taskId: fixture.taskId, runId: fixture.runId });
  assert.equal(operations.kind, "operations");
  assert.equal(operations.page.items.filter((operation) => operation.kind === "prepare").length, 1);
});

test("replacement ownership fences old writers and distinguishes queued from dispatched recovery", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture();
  await fixture.admit();
  const oldFence = await fixture.fence();
  await fixture.store.releaseOwner(fixture.owner);
  const replacement = await fixture.store.acquireOwner();
  assert.ok(replacement.epoch > fixture.owner.epoch);
  await assert.rejects(fixture.store.commit({ ...oldFence, kind: "cancel", at: "2026-10-10T12:00:01.000Z", reason: "Old process" }), hasCode("owner_lost"));
  await assert.rejects(fixture.store.releaseOwner(fixture.owner), hasCode("owner_lost"));
  const scan = await fixture.store.scan({ kind: "recoverable_runs", at: "2026-10-10T12:00:01.000Z" });
  assert.equal(scan.kind, "recoverable_runs");
  assert.deepEqual(scan.page.items.map((run) => [run.runId, run.dispatch]), [[fixture.runId, "none"]]);
  await fixture.store.commit({ ...oldFence, owner: replacement, kind: "dispatch_intent", operationKind: "prepare", at: "2026-10-10T12:00:01.000Z" });
  await fixture.store.releaseOwner(replacement);
  const nextOwner = await fixture.store.acquireOwner();
  const dispatched = await fixture.store.scan({ kind: "recoverable_runs", at: "2026-10-10T12:00:02.000Z" });
  assert.equal(dispatched.kind, "recoverable_runs");
  assert.equal(dispatched.page.items[0]?.preparation, "intended");
  await fixture.store.releaseOwner(nextOwner);
});

test("request delivery commits only its exact retained identity and cannot overwrite a successor request", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture();
  await fixture.running();
  const at = "2026-10-10T12:00:01.000Z";
  const first = { requestId: "first-request", requestKind: "approval" as const, openedAt: at, state: "waiting" as const };
  await fixture.store.commit({ ...await fixture.fence(), kind: "request_state", state: "opened", request: first, at });
  const operation = await fixture.fence();
  await fixture.store.commit({ ...operation, kind: "request_state", state: "resolution_intended", request: { ...first, state: "resolution_intended" }, at });
  const second = { ...first, requestId: "successor-request" };
  await fixture.store.commit({ ...await fixture.fence(), kind: "request_state", state: "opened", request: second, at });
  const command = { ...await fixture.fence(operation.operationId, operation.inputDigest), kind: "operation_receipt" as const, disposition: "delivered" as const, at };
  const delivered = await fixture.store.commit(command);
  assert.deepEqual(await fixture.store.commit(command), { ...delivered, duplicate: true });
  const run = await fixture.run();
  assert.equal(run.phase, "waiting");
  assert.deepEqual(run.pendingRequest, second);
  const record = await fixture.store.read({ kind: "operation", parent, operationId: operation.operationId });
  assert.equal(record.kind, "operation");
  assert.equal(record.operation?.disposition, "delivered");
  assert.deepEqual(record.operation?.request, { requestId: "first-request", requestKind: "approval" });
  await assert.rejects(fixture.store.commit({ ...await fixture.fence(operation.operationId, operation.inputDigest), kind: "operation_receipt", disposition: "completed", at }), hasCode("operation_conflict"));
});
