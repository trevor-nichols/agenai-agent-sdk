// ------------------------------------------------------------------------------------------------
//                storeReadBoundary.test.ts - Closed bounded commands and detached paged records
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createInMemoryDelegationStore, DelegationValidationError, type DelegationStoreCommand } from "../src/index.js";
import { at, createStoreFixture, digest } from "./fixtures/execution/store.js";

test("paged scans contain each retained run once and reject a cursor from another query", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture();
  const expected = new Set<string>();
  for (let index = 0; index < 3; index += 1) {
    const runId = randomUUID();
    expected.add(runId);
    await fixture.store.commit({ ...fixture.admission, taskId: randomUUID(), operationId: randomUUID(), inputDigest: digest(`task ${index}`),
      admission: { ...fixture.admission.admission, runId } });
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await fixture.store.scan({ kind: "queued", at, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(result.kind, "queued");
    assert.ok(result.page.items.length <= 1);
    assert.ok(Buffer.byteLength(JSON.stringify(result.page)) <= 65_536);
    seen.push(...result.page.items.map((run) => run.runId));
    cursor = result.page.cursor;
    if (cursor !== undefined) await assert.rejects(fixture.store.scan({ kind: "recoverable_runs", at, limit: 1, cursor }));
  } while (cursor !== undefined);
  assert.equal(seen.length, expected.size);
  assert.deepEqual(new Set(seen), expected);
  await assert.rejects(fixture.store.scan({ kind: "queued", at, limit: 101 }));
});

test("store records capture caller data and cannot be modified through read results", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture();
  const command = structuredClone(fixture.admission);
  await fixture.store.commit(command);
  Object.assign(command.admission.target, { targetRevision: 9 });
  const first = await fixture.run();
  assert.equal(first.admittedTarget.targetRevision, 1);
  try { Object.assign(first.admittedTarget, { targetRevision: 7 }); } catch { /* Frozen public values may reject mutation. */ }
  assert.equal((await fixture.run()).admittedTarget.targetRevision, 1);
});

test("closed command parsing rejects sensitive or executable additions without retaining a task", { timeout: 10_000 }, async () => {
  assert.throws(() => createInMemoryDelegationStore({ storeId: "invalid-store-id" }), DelegationValidationError);
  for (const limits of [{ maxRuns: Number.MAX_SAFE_INTEGER }, { maxOrdinaryOperations: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => createInMemoryDelegationStore({ limits }), DelegationValidationError);
  }
  const fixture = await createStoreFixture();
  const invalid = [
    { ...fixture.admission, requestContext: { nativeSecret: "private-provider-context" } },
    { ...fixture.admission, output: { kind: "json_schema", schema: {} } },
    { ...fixture.admission, admission: { ...fixture.admission.admission, output: { kind: "json_schema", schema: {} } } },
    { ...fixture.admission, admission: { ...fixture.admission.admission, input: { ...fixture.admission.admission.input, output: { kind: "json_schema", schema: {} } } } },
    { ...fixture.admission, admission: { ...fixture.admission.admission, input: { parts: [{ type: "text", text: "x".repeat(16_001) }] } } },
    { ...fixture.admission, owner: { ...fixture.owner, nativeToken: "secret" } },
    { ...fixture.admission, admission: { ...fixture.admission.admission, rawRequest: { prompt: "secret" } } },
  ];
  for (const command of invalid) await assert.rejects(fixture.store.commit(command as DelegationStoreCommand));
  const capacity = await fixture.store.read({ kind: "capacity" });
  assert.equal(capacity.kind, "capacity");
  assert.equal(capacity.capacity.tasks, 0);
  assert.equal(capacity.capacity.reservedBytes, 0);
});

test("settlement rejects legacy or private failure fields and preserves one bounded classified outcome", { timeout: 10_000 }, async () => {
  const fixture = await createStoreFixture();
  await fixture.running();
  const error = { category: "quota_exhausted", code: "x".repeat(128), message: "", recovery: { kind: "wait_for_quota" } } as const;
  const command = { ...await fixture.fence(), kind: "settle", at, outcome: { kind: "failed", error } } as const;
  const before = await fixture.run();
  for (const invalid of [
    { code: "legacy_failure", message: "Legacy code/message needs explicit migration." },
    { ...error, category: "invented" },
    { ...error, code: "x".repeat(129) },
    { ...error, context: { component: "private-session" } },
    { ...error, recovery: { kind: "wait_for_quota", quota: { sourceId: "private-source", poolId: "private-pool", windowId: "private-window", observedAt: at } } },
    { ...error, message: "\u0000".repeat(400) },
  ]) {
    await assert.rejects(fixture.store.commit({ ...command, outcome: { kind: "failed", error: invalid } } as DelegationStoreCommand), DelegationValidationError);
    assert.deepEqual(await fixture.run(), before);
  }
  const receipt = await fixture.store.commit(command);
  assert.deepEqual(await fixture.store.commit(command), { ...receipt, duplicate: true });
  assert.deepEqual((await fixture.run()).outcome, command.outcome);
  assert.ok(receipt.notificationId);
  const notification = await fixture.store.read({ kind: "notification", notificationId: receipt.notificationId });
  assert.equal(notification.kind, "notification");
  assert.deepEqual(notification.notification?.envelope.outcome, command.outcome);
});
