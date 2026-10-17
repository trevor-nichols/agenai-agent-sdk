import assert from 'node:assert/strict';

function ordered(transcript, observations) {
  let previous = -1;
  for (const observation of observations) {
    const index = transcript.indexOf(observation);
    assert.ok(index > previous, `Missing or out-of-order observation: ${observation}`);
    previous = index;
  }
}

export function assertLiveRequestExample(report) {
  assert.equal(report.example, 'live-request-output');
  assert.equal(report.evidence, 'synthetic');
  for (const [key, expected] of Object.entries({
    starts: 1, outputReaders: 1, acceptedAnswers: 1, closes: 1,
    openedRequests: 2, retiredRequests: 1, answerEntriesA: 0, answerEntriesB: 1,
    producerJoined: true, handlerJoined: true, completed: true, cleanup: 'joined',
  })) assert.equal(report[key], expected, key);
  ordered(report.transcript, [
    'turn.started',
    'request.opened:live-request:A',
    'output:Independent work continues while A awaits a decision.',
    'request.unavailable:live-request:A:withdrawn',
    'request.opened:live-request:B',
    'output:Independent work completed while the request remained open.',
    'answer.submitted:live-request:B',
    'provider.accepted:live-request:B:destination=Archive',
    'answer.delivered:live-request:B',
    'output:Continuing with Archive.',
    'turn.completed:completed', 'session.closed', 'handler.joined',
  ]);
  assert.equal(report.transcript.includes('answer.submitted:live-request:A'), false);
  assert.equal(report.transcript.filter((entry) => entry.startsWith('handler.retired:')).length, 1);
}

export function assertSessionContinuationExample(report) {
  assert.equal(report.example, 'session-continuations');
  assert.equal(report.evidence, 'synthetic');
  assert.equal(report.humanWait, 'until_withdrawn_or_closed');
  assert.deepEqual(report.deadlines, [{ kind: 'no_deadline' }, { kind: 'no_deadline' }]);
  assert.deepEqual(report.receipts, ['delivered', 'delivered']);
  assert.deepEqual(report.outcomes, ['started']);
  for (const [key, expected] of Object.entries({
    responseTimeoutMs: 2_000, cleanupTimeoutMs: 2_000, parkedBeforeDispatch: true,
    starts: 0, continuations: 1, outputReaders: 1, nativeAnswerEntries: 2, workStarts: 1,
    noWorkActions: 1, callbacksJoined: true, producersJoined: true, closes: 2, cleanup: 'joined',
  })) assert.equal(report[key], expected, key);
  assert.deepEqual(report.output, ['turn.started', 'item.started', 'content.delta', 'item.completed', 'turn.completed']);
  ordered(report.transcript, ['reader.parked', 'dispatched:form:submit', 'output:turn.started', 'output:turn.completed']);
  assert.deepEqual(report.refusals.map(({ name, code, openingEntries, nativeAnswerEntries, workStarts, presentations, executions }) => ({
    name, code, openingEntries, nativeAnswerEntries, workStarts, presentations, executions,
  })), ['unsupported', 'missing-interactions', 'missing-continuation-handler'].map((name) => ({
    name, code: 'native_continuations_unsupported',
    openingEntries: name === 'missing-continuation-handler' ? 1 : 0,
    nativeAnswerEntries: 0, workStarts: 0, presentations: 0, executions: 0,
  })));
  assert.equal(report.refusals.find(({ name }) => name === 'missing-continuation-handler').closes, 1);
}

export function assertAcpContinuationExample(report) {
  assert.equal(report.example, 'session-continuations-acp');
  assert.equal(report.evidence, 'synthetic');
  assert.equal(report.mapping, 'grok-build-1.0.60-session-requests-v1');
  for (const [key, expected] of Object.entries({
    operation: 'resume', requestKind: 'plan_review', timing: 'after_open_return', action: 'approve',
    receipt: 'delivered', outcome: 'started', continuations: 1,
    loads: 1, prompts: 0, nativeResponses: 1, parkedBeforeResponse: true, callbacksJoined: 1,
    peerProcessGone: true, nativeQualification: 'not_performed', cleanup: 'joined',
  })) assert.equal(report[key], expected, key);
  assert.deepEqual(report.deadline, { kind: 'no_deadline' });
  assert.deepEqual(report.output, ['Controlled continuation output.']);
  ordered(report.transcript, ['opening.returned', 'review.offered', 'reader.parked',
    'output:turn.started', 'output:turn.completed', 'session.closed', 'peer.process_gone']);
}
