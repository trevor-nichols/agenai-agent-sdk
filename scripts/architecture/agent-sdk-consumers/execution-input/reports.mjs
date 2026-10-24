// ------------------------------------------------------------------------------------------------
//                reports.mjs - Independent observable contracts for installed input consumers
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';

export function assertExecutionInputExample(report) {
  assert.deepEqual(report, {
    example: 'execution-input', evidence: 'synthetic', nativeProviderSupport: 'none',
    scenarios: [
      { scenario: 'accepted-consumed', receiptStatus: 'accepted', settlement: {
        status: 'consumed', messageId: 'execution-input:accepted-consumed:instruction',
        turnId: 'execution-input:accepted-consumed:turn', placement: 'owned_native_continuation',
      } },
      { scenario: 'accepted-unconfirmed', receiptStatus: 'accepted', settlement: {
        status: 'unconfirmed', messageId: 'execution-input:accepted-unconfirmed:instruction',
        reason: 'provider_does_not_report_consumption',
      } },
      { scenario: 'native-rejected', receiptStatus: 'rejected', errorCode: 'teaching_native_refusal', settlement: null },
      { scenario: 'delivery-uncertain', receiptStatus: 'delivery_uncertain', errorCode: 'teaching_receipt_lost', settlement: null },
      { scenario: 'unsupported', receiptStatus: 'unsupported', settlement: null },
    ].map(({ scenario, receiptStatus, errorCode, settlement }) => ({
      scenario,
      receipt: { status: receiptStatus,
        ...(scenario === 'unsupported' ? {} : { messageId: `execution-input:${scenario}:instruction` }),
        ...(errorCode === undefined ? {} : { errorCode }),
      },
      settlement,
      output: { events: ['turn.started', 'item.started', 'content.delta', 'content.delta', 'item.completed', 'turn.completed'],
        text: 'Original task remains owned.\nTeaching provider completed.\n', terminals: 1, outcomes: ['completed'] },
      outputWhileAwaitingReceipt: scenario !== 'unsupported',
      outputWhileAwaitingSettlement: scenario === 'accepted-consumed' || scenario === 'accepted-unconfirmed',
      provider: { starts: 1, outputReaders: 1, inputCalls: scenario === 'unsupported' ? 0 : 1,
        producerJoins: 1, sessionCloses: 1, instanceDisposals: 1 },
      uncertaintyFence: scenario === 'delivery-uncertain' ? 'session_unusable' : null,
      cleanup: 'joined',
    })),
  });
}

export function assertAcpExecutionInputUnsupported(report) {
  assert.deepEqual(report, {
    proof: 'packed-acp-execution-input-unsupported', evidence: 'synthetic-peer',
    scenarios: ['generic-acp', 'grok-labels-and-adverts', 'grok-1.0.62-structured-output'].flatMap((profile) =>
      ['borrowed', 'owned'].map((ownership) => ({
        profile, ownership, input: ['unsupported', 'unsupported', 'unsupported'],
        readers: 1, turns: 1, nativePrompts: 1, nativeInputRequests: 0, unknownInputReply: -32601,
        output: 'Original packed prompt output.', terminalCount: 1, ownedReleases: ownership === 'owned' ? 1 : 0,
        borrowedStreamsPreserved: ownership === 'borrowed', cleanup: 'joined',
      }))),
  });
}
