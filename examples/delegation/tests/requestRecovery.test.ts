// ------------------------------------------------------------------------------------------------
//                requestRecovery.test.ts - Fresh-process recovery never replays an accepted answer
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { parseAgentApprovalRequest } from '@agen-ai/agent-protocol';
import { invocationCount, temporaryRoot } from '../fixtures/journal.js';
import { formatThreeFixture, materializeFormatThreeStore } from '../fixtures/migration/materialize.js';
import { assertRetainedRequestHistory, inspectRequestHistory } from '../fixtures/requestHistory.js';
import { startScenario } from '../fixtures/process.js';
import type { recoverRequestReceipt } from '../fixtures/requestRecovery.js';

for (const loss of ['before_commit', 'after_commit'] as const) {
  test(`accepted remembered answer survives receipt failure ${loss} and preserves original format-three history without replay`, { timeout: 20_000 }, async (t) => {
    const directory = await temporaryRoot();
    materializeFormatThreeStore(join(directory.root, 'database'));
    const historicalId = formatThreeFixture.ids[0]!;
    const originalHistory = inspectRequestHistory(directory.root, historicalId.operationId, historicalId.runId);
    const writer = startScenario(directory.root, 'request_receipt_failure', { loss });
    const children = [writer];
    t.after(async () => { for (const child of children) await child.stop(); await directory.remove(); });
    const crashed = await writer.wait('crash');
    assert.ok(crashed.detail && typeof crashed.detail === 'object' && 'display' in crashed.detail);
    const display = parseAgentApprovalRequest(crashed.detail.display);
    assert.deepEqual(crashed.detail, { loss, receiptWrites: 1, disposition: loss === 'before_commit' ? 'intent' : 'delivered',
      selectedOptionId: 'recovery:remember', display: {
        requestKind: 'approval', requestId: display.requestId,
        prompt: 'Allow the synthetic edit and ask this provider to remember?', subject: { kind: 'tool', title: 'Synthetic file edit', itemId: 'synthetic-edit' },
        options: [
          { optionId: 'recovery:once', label: 'Allow once', decision: 'approved',
            consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } },
          { optionId: 'recovery:remember', label: 'Allow and remember', description: 'Synthetic provider choice for durable recovery qualification.',
            decision: 'approved', consequence: { kind: 'provider_managed_remembrance', duration: { kind: 'unknown' }, applicability: { kind: 'unknown' },
              explanation: 'The provider is asked to remember this decision. Duration and future matching are unspecified. Delivery does not establish persistence or revocation.' } },
        ],
      } });
    assert.equal(invocationCount(directory.root, 'child'), 1);
    assert.equal(invocationCount(directory.root, 'answer'), 1);
    await writer.kill();
    assertRetainedRequestHistory(inspectRequestHistory(directory.root, historicalId.operationId, historicalId.runId), originalHistory);
    const reader = startScenario(directory.root, 'recover_request_receipt', { loss });
    children.push(reader);
    const result = await reader.complete() as Awaited<ReturnType<typeof recoverRequestReceipt>>;
    assert.notEqual(result.processId, writer.child.pid);
    assert.equal(result.loss, loss);
    assert.equal(result.childInvocations, 1);
    assert.equal(result.answerInvocations, 1);
    assert.equal(result.disposition, loss === 'before_commit' ? 'intent' : 'delivered');
    assert.equal(result.outcome?.kind, 'recovery_required');
    assertRetainedRequestHistory(inspectRequestHistory(directory.root, historicalId.operationId, historicalId.runId), originalHistory);
    t.diagnostic(JSON.stringify({ tuple: directory.tuple, writer: writer.child.pid, ...result }));
  });
}
