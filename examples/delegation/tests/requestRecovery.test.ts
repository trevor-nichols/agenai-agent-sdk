// ------------------------------------------------------------------------------------------------
//                requestRecovery.test.ts - Fresh-process recovery never replays an accepted answer
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { invocationCount, temporaryRoot } from '../fixtures/journal.js';
import { startScenario } from '../fixtures/process.js';
import type { recoverRequestReceipt } from '../fixtures/requestRecovery.js';

for (const loss of ['before_commit', 'after_commit'] as const) {
  test(`accepted answer survives receipt failure ${loss} and fresh-process recovery without replay`, { timeout: 20_000 }, async (t) => {
    const directory = await temporaryRoot();
    const writer = startScenario(directory.root, 'request_receipt_failure', { loss });
    const children = [writer];
    t.after(async () => { for (const child of children) await child.stop(); await directory.remove(); });
    const crashed = await writer.wait('crash');
    assert.deepEqual(crashed.detail, { loss, receiptWrites: 1, disposition: loss === 'before_commit' ? 'intent' : 'delivered' });
    assert.equal(invocationCount(directory.root, 'child'), 1);
    assert.equal(invocationCount(directory.root, 'answer'), 1);
    await writer.kill();
    const reader = startScenario(directory.root, 'recover_request_receipt', { loss });
    children.push(reader);
    const result = await reader.complete() as Awaited<ReturnType<typeof recoverRequestReceipt>>;
    assert.notEqual(result.processId, writer.child.pid);
    assert.equal(result.loss, loss);
    assert.equal(result.childInvocations, 1);
    assert.equal(result.answerInvocations, 1);
    assert.equal(result.disposition, loss === 'before_commit' ? 'intent' : 'delivered');
    assert.equal(result.outcome?.kind, 'recovery_required');
    t.diagnostic(JSON.stringify({ tuple: directory.tuple, writer: writer.child.pid, ...result }));
  });
}
