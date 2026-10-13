// ------------------------------------------------------------------------------------------------
//                ownership.ts - Independent owner exclusion and stale-token qualification
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { join } from "node:path";
import type { DelegationStoreCommand } from "@agen-ai/agent-orchestration";
import { openSqliteDelegationStore } from "../sqlite/index.js";
import { barrier, persistJson, readJson } from "./journal.js";
import { admission, hasCode } from "./store.js";

export async function ownershipScenario(root: string, mode: string) {
  if (mode === "contender") {
    assert.throws(() => openSqliteDelegationStore({ root: join(root, "database") }), hasCode("owner_lost"));
    return { denied: true };
  }
  const opened = await openSqliteDelegationStore({ root: join(root, "database") });
  const owner = await opened.store.acquireOwner();
  if (mode === "owner") {
    const command = admission(owner);
    const receipt = await opened.store.commit(command);
    persistJson(root, "owner-admission.json", { command, receipt });
    await barrier("owned", { storeId: owner.storeId, epoch: owner.epoch });
  } else {
    const original = readJson<{ command: Extract<DelegationStoreCommand, { kind: "admit" }>; receipt: unknown }>(root, "owner-admission.json");
    assert.ok(owner.epoch > original.command.owner.epoch);
    assert.notEqual(owner.nonce, original.command.owner.nonce);
    const before = await opened.store.read({ kind: "capacity" });
    await assert.rejects(opened.store.commit(original.command), hasCode("owner_lost"));
    assert.deepEqual(await opened.store.read({ kind: "capacity" }), before);
    const duplicate = await opened.store.commit({ ...original.command, owner });
    assert.deepEqual(duplicate, { ...original.receipt as object, duplicate: true });
    await opened.store.releaseOwner(owner);
    assert.throws(() => opened.assertCurrent(), hasCode("owner_lost"));
    return { storeId: owner.storeId, epoch: owner.epoch, duplicate };
  }
  await new Promise<void>(() => {});
}
