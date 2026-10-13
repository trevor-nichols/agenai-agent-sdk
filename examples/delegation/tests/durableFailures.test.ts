// ------------------------------------------------------------------------------------------------
//                durableFailures.test.ts - New classified outcomes survive process and delivery boundaries
// ------------------------------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import type { DurableFailureResult } from "../fixtures/failure.js";
import { invocationCount, temporaryRoot } from "../fixtures/journal.js";
import { startScenario } from "../fixtures/process.js";

for (const policy of ["collect", "next_turn", "automatic"] as const) test(`${policy} retains a newly classified failure across fresh-process collection and parent delivery`, { timeout: 20_000 }, async (t) => {
  const directory = await temporaryRoot();
  const writer = startScenario(directory.root, "settle_failure", { policy });
  const children = [writer];
  t.after(async () => { for (const child of children) await child.stop(); await directory.remove(); });
  const settled = await writer.complete() as DurableFailureResult;
  const expected = { kind: "failed", error: { category: "quota_exhausted", code: "allowance_exhausted",
    message: "The child allowance is exhausted.", recovery: { kind: "wait_for_quota" } } };
  assert.deepEqual(settled.envelope.outcome, expected);
  assert.equal(settled.envelope.policy, policy);
  assert.equal(settled.childInvocations, 1);
  assert.equal(settled.parentInvocations, 0);
  const reader = startScenario(directory.root, "reopen_failure", { policy });
  children.push(reader);
  const reopened = await reader.complete() as DurableFailureResult;
  assert.notEqual(reopened.processId, settled.processId);
  assert.deepEqual(reopened.envelope, settled.envelope);
  assert.deepEqual(reopened.envelope.outcome, expected);
  assert.deepEqual(reopened.inbox, settled.inbox);
  if (policy === "collect") {
    assert.equal(reopened.inbox, undefined);
    assert.equal(reopened.dispatch, undefined);
  } else {
    assert.ok(reopened.inbox);
    assert.deepEqual(reopened.dispatch, { envelope: settled.envelope, inboxId: reopened.inbox.inboxId });
  }
  assert.equal(JSON.stringify(reopened).includes("private-"), false);
  assert.equal(reopened.childInvocations, 1);
  assert.equal(reopened.parentInvocations, policy === "collect" ? 0 : 1);
  assert.equal(invocationCount(directory.root, "child"), 1);
  assert.equal(invocationCount(directory.root, "parent"), policy === "collect" ? 0 : 1);
  t.diagnostic(JSON.stringify({ tuple: directory.tuple, policy, writer: settled.processId, reader: reopened.processId,
    storeId: reopened.envelope.storeId, taskId: reopened.envelope.taskId, runId: reopened.envelope.runId,
    notificationId: reopened.envelope.notificationId, inboxId: reopened.inbox?.inboxId,
    outcome: reopened.envelope.outcome, childInvocations: reopened.childInvocations, parentInvocations: reopened.parentInvocations }));
});
