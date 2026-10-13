// ------------------------------------------------------------------------------------------------
//                inboxCrashRecovery.test.ts - Durable acceptance and parent-dispatch uncertainty
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { invocationCount, readJson, temporaryRoot } from "../fixtures/journal.js";
import { idleParent, setParent } from "../fixtures/parent.js";
import { startScenario } from "../fixtures/process.js";

for (const stage of ["inbox_accept", "inbox_accept_expired", "parent_intent", "accepted_revoked", "future_retry"]) {
  test(`SIGKILL at ${stage} retains one inbox entry and never replays parent execution`, { timeout: 20_000 }, async (t) => {
    const directory = await temporaryRoot();
    const executor = startScenario(directory.root, stage);
    const children = [executor];
    t.after(async () => { for (const child of children) await child.stop(); await directory.remove(); });
    await executor.wait("crash");
    assert.equal(invocationCount(directory.root, "child"), 1);
    assert.equal(invocationCount(directory.root, "parent"), stage === "parent_intent" ? 1 : 0);
    if (stage === "accepted_revoked") setParent(directory.root, { ...idleParent, executionAllowed: false });
    await executor.kill();
    if (stage === "inbox_accept_expired") {
      const { expiresAt } = readJson<{ expiresAt: string }>(directory.root, "accepted.json");
      await setTimeout(Math.max(1, Date.parse(expiresAt) - Date.now() + 1));
    }
    const replacement = startScenario(directory.root, "recover_inbox", { stage });
    children.push(replacement);
    const result = await replacement.complete() as { stage: string; childInvocations: number; parentInvocations: number };
    assert.equal(result.stage, stage);
    assert.equal(result.childInvocations, 1);
    assert.equal(result.parentInvocations, stage === "parent_intent" ? 1 : 0);
  });
}
