// ------------------------------------------------------------------------------------------------
//                crashRecovery.test.ts - Durable execution recovery after independent process loss
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { invocationCount, temporaryRoot } from "../fixtures/journal.js";
import { startScenario } from "../fixtures/process.js";

for (const stage of ["before_admission", "admitted", "preparation", "dispatch", "effect", "waiting", "terminal", "settled", "saturated", "cancellation"]) {
  test(`SIGKILL at ${stage} preserves committed truth without replaying ambiguous child work`, { timeout: 20_000 }, async (t) => {
    const directory = await temporaryRoot();
    const executor = startScenario(directory.root, stage);
    const children = [executor];
    t.after(async () => { for (const child of children) await child.stop(); await directory.remove(); });
    await executor.wait("crash");
    const before = invocationCount(directory.root, "child");
    assert.equal(before, ["effect", "waiting", "terminal", "settled", "saturated", "cancellation"].includes(stage) ? 1 : 0);
    await executor.kill();
    const replacement = startScenario(directory.root, "recover", { stage });
    children.push(replacement);
    const result = await replacement.complete() as { stage: string; invocations: number };
    assert.equal(result.stage, stage);
    assert.equal(result.invocations, stage === "admitted" ? 1 : before);
  });
}
