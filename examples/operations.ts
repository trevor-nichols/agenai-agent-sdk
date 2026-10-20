import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createOperationExample, exampleOperationId, type Scenario } from './operations/fixture.js';
import { invokeConfirmedCompaction } from './operations/invoke.js';

const scenarios: readonly Scenario[] = [
  'unsupported', 'missing', 'fields', 'declined', 'effect', 'no_effect', 'pre_abort', 'entered_abort',
];
const reports = [];
for (const scenario of scenarios) {
  const cancel = new AbortController();
  const owner = await createOperationExample(scenario, cancel);
  if (scenario === 'pre_abort') cancel.abort(new DOMException('User canceled.', 'AbortError'));
  try {
    const outcome = await invokeConfirmedCompaction({ session: owner.session,
      operationId: exampleOperationId, signal: cancel.signal,
      // Replace this simulated decision with your abort-aware UI and its displayed consequences.
      async confirm(offer) { assert.equal(offer.confirmation, 'required'); return scenario !== 'declined'; },
      async acceptOutput() { await setImmediate(); owner.steps.push('output.accepted'); },
    });
    const expected = { unsupported: 'unsupported', missing: 'unavailable', fields: 'unsupported_descriptor',
      declined: 'declined', effect: 'settled', no_effect: 'settled', pre_abort: 'canceled_before_execution',
      entered_abort: 'uncertain' } as const;
    assert.equal(outcome.status, expected[scenario]);
    if (outcome.status === 'settled') {
      assert.equal(outcome.result.status, 'completed');
      assert.equal(outcome.compactionObserved, scenario === 'effect');
    }
    if (scenario === 'effect') assert.deepEqual(owner.steps, ['output.accepted', 'output.returned', 'operation.completed']);
    const dispatched = ['effect', 'no_effect', 'entered_abort'].includes(scenario) ? 1 : 0;
    assert.equal(owner.dispatches(), dispatched);
    assert.equal(owner.turns(), 0);
    // Uncertain means stop mutation and close; never replay the operation or invent a prompt turn.
    reports.push({ scenario, status: outcome.status, dispatches: dispatched,
      compactionObserved: 'compactionObserved' in outcome ? outcome.compactionObserved : false });
  } finally { await owner.cleanup(); }
  assert.deepEqual(owner.steps.slice(-2), ['session.closed', 'instance.disposed']);
}
console.log(JSON.stringify({ example: 'operations', evidence: 'synthetic', scenarios: reports, turns: 0, cleanup: 'joined' }));
