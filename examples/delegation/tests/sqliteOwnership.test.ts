// ------------------------------------------------------------------------------------------------
//                sqliteOwnership.test.ts - Lifetime process exclusion and fenced takeover
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { linkSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { createDelegationCoordinator, type DelegationOwnerToken } from "@agen-ai/agent-orchestration";
import { openSqliteDelegationStore } from "../sqlite/index.js";
import { createReferenceHost } from "../fixtures/host.js";
import { temporaryRoot } from "../fixtures/journal.js";
import { startScenario } from "../fixtures/process.js";
import { hasCode } from "../fixtures/store.js";

test("a live process excludes another owner and SIGKILL permits a fenced takeover without new admission", { timeout: 30_000 }, async (t) => {
  const directory = await temporaryRoot();
  t.diagnostic(`Qualified runtime/storage: ${JSON.stringify(directory.tuple)}`);
  const owner = startScenario(directory.root, "owner");
  const children = [owner];
  t.after(async () => { for (const child of children) await child.stop(); await directory.remove(); });
  const acquired = (await owner.wait("owned")).detail as { storeId: string; epoch: number };
  const contender = startScenario(directory.root, "contender");
  children.push(contender);
  assert.deepEqual(await contender.complete(), { denied: true });
  await owner.kill();
  const replacement = startScenario(directory.root, "takeover");
  children.push(replacement);
  const recovered = await replacement.complete() as { storeId: string; epoch: number; duplicate: { duplicate: boolean } };
  assert.equal(recovered.storeId, acquired.storeId);
  assert.ok(recovered.epoch > acquired.epoch);
  assert.equal(recovered.duplicate.duplicate, true);
});

test("incompatible delivery setup can close its unused lock and an acquired owner cannot bypass quiescence", { timeout: 10_000 }, async (t) => {
  const directory = await temporaryRoot();
  let nativeCalls = 0;
  const reference = await createReferenceHost({ root: directory.root, onInvoke() { nativeCalls += 1; } });
  let opened = openSqliteDelegationStore({ root: join(directory.root, "database") });
  const cleanup: { owner?: DelegationOwnerToken } = {};
  t.after(async () => { if (cleanup.owner) await opened.store.releaseOwner(cleanup.owner); else opened.closeUnused(); await reference.registry.dispose(); await directory.remove(); });
  await assert.rejects(createDelegationCoordinator({ host: reference.host, store: opened.store, limits: opened.store.limits,
    parentDelivery: { persistence: "volatile", async accept() { return { status: "uncertain" }; }, async inspect() { return { status: "absent" }; } } }), hasCode("unsupported_operation"));
  opened.closeUnused();
  opened.closeUnused();
  opened = openSqliteDelegationStore({ root: join(directory.root, "database") });
  const owner = await opened.store.acquireOwner();
  cleanup.owner = owner;
  assert.throws(() => opened.closeUnused(), hasCode("owner_lost"));
  opened.assertCurrent();
  assert.equal(nativeCalls, 0);
  const capacity = await opened.store.read({ kind: "capacity" });
  assert.equal(capacity.kind, "capacity");
  assert.equal(capacity.capacity.tasks, 0);
});

test("opening rejects auxiliary aliases and partial roots before changing external files", async (t) => {
  const cases = [
    { name: "task.sqlite-shm", initialized: true },
    { name: "task.sqlite-wal", initialized: true },
    { name: "owner.sqlite-journal", initialized: true },
    { name: "task.sqlite-shm", initialized: false },
  ];
  for (const entry of cases) await t.test(`${entry.initialized ? "initialized" : "auxiliary-only"} ${entry.name}`, async (child) => {
    const directory = await temporaryRoot();
    const root = join(directory.root, "database");
    const cleanup: { opened?: ReturnType<typeof openSqliteDelegationStore> } = {};
    child.after(async () => { cleanup.opened?.closeUnused(); await directory.remove(); });
    if (entry.initialized) openSqliteDelegationStore({ root }).closeUnused();
    const marker = join(directory.root, "outside-marker");
    const auxiliary = join(root, entry.name);
    const content = Buffer.alloc(32 * 1_024, 0x6d);
    writeFileSync(marker, content, { mode: 0o600 });
    if (entry.initialized) linkSync(marker, auxiliary);
    else writeFileSync(auxiliary, content, { mode: 0o600 });
    const identity = lstatSync(auxiliary, { bigint: true });
    const files = readdirSync(root).sort();
    let openingError: unknown;
    try { cleanup.opened = openSqliteDelegationStore({ root }); }
    catch (error) { openingError = error; }
    assert.ok(readFileSync(marker).equals(content), "Rejected opening must preserve external marker bytes.");
    assert.deepEqual(readdirSync(root).sort(), files, "Rejected opening must preserve auxiliary links and create no database files.");
    const retained = lstatSync(auxiliary, { bigint: true });
    assert.equal(retained.ino, identity.ino);
    assert.equal(retained.dev, identity.dev);
    assert.equal(retained.nlink, entry.initialized ? 2n : 1n);
    assert.ok(hasCode("store_failed")(openingError), "Invalid auxiliary input must reject with store_failed.");
  });
});
