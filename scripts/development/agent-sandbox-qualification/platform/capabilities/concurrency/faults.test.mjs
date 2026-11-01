import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { assertCheckpointFault, assertTerminalCheckpointFault, everyFailureBranch, sdkFenceFailure, stoppedMemberExits,
  supersededContinuityControl } from './faults.mjs';

test('an exact injected persistence failure cannot hide an unrelated sibling error after the selected checkpoint', () => {
  const cause = new Error('Original rejected checkpoint');
  const expected = Object.assign(new Error('Sandbox recovery checkpoint failed.', { cause }), { name: 'SandboxOperationError', code: 'persistence_failure' });
  const record = { operationId: 'original-b', phase: 'starting', resources: [{ role: 'compute', identity: { kind: 'creating' } }] };
  const selected = { kind: 'persistence', boundary: 'creating' };
  const entry = { owner: { recoveryRecord: record }, operationFailures: [{ operation: 'start', error: expected, record }] };
  const options = { selected, entry, cause, fault: { boundary: 'creating', record } };
  assert.deepEqual(assertCheckpointFault({ ...options, primary: new Error('Public prepare failed', { cause: expected }) }),
    { operation: 'start', code: 'persistence_failure', operationId: 'original-b', originalRecord: record });
  assert.throws(() => assertCheckpointFault({ ...options, primary: new AggregateError([expected, new Error('Unrelated TLS fixture changed')]) }),
    /unrelated failure also entered/u);
  assert.throws(() => assertCheckpointFault({ ...options, primary: expected, cause: new Error('Copied callback cause') }),
    /exact rejected callback cause/u);
});

test('typed fence failures accept only original SDK authority outcomes, never a raw stopped-stream signature', () => {
  class SandboxStateError extends Error { constructor(message) { super(message); this.name = 'SandboxStateError'; } }
  class SandboxOperationError extends Error { constructor(code, message) { super(message); this.name = 'SandboxOperationError'; this.code = code; } }
  const sdk = { SandboxStateError, SandboxOperationError };
  const coordinator = (kind) => Object.assign(new Error('Docker Desktop coordinator failed.'), { name: 'DockerDesktopCoordinatorError', failure: { kind } });
  for (const accepted of [new SandboxStateError('Fenced.'), new SandboxOperationError('driver_failure', 'Lost.'),
    new SandboxOperationError('stream_failure', 'Closed.'), new SandboxOperationError('cancelled', 'Stopping.'), coordinator('authority_lost')]) {
    assert.equal(sdkFenceFailure(accepted, sdk), true, accepted.message);
  }
  for (const rejected of [new SandboxOperationError('persistence_failure', 'Checkpoint rejected.'), coordinator('retained_ownership'),
    Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })]) {
    assert.equal(sdkFenceFailure(rejected, sdk), false, rejected.message);
  }
});

test('a rejected terminal B checkpoint is accepted only after physical destruction settled without an operation failure', () => {
  const cause = new Error('Original rejected terminal checkpoint');
  const record = { operationId: 'original-b', phase: 'destroyed', resources: [] };
  const selected = { kind: 'persistence', boundary: 'destroyed' };
  const options = () => ({ selected, injected: true, cause, fault: { boundary: 'destroyed', record },
    entry: { owner: { recoveryRecord: record, state: { kind: 'destroyed' } }, operationFailures: [] } });
  assert.deepEqual(assertTerminalCheckpointFault(options()),
    { operation: 'destroy', disposition: 'canonical_cleanup_settled', operationId: 'original-b' });
  const uncertain = options(); uncertain.entry.owner.state = { kind: 'uncertain', operation: 'destroy' };
  assert.throws(() => assertTerminalCheckpointFault(uncertain), /Physical destruction must settle/u);
  const stale = options(); stale.entry.owner.recoveryRecord = { ...record, resources: [{ role: 'compute' }] };
  assert.throws(() => assertTerminalCheckpointFault(stale), /B's final original record/u);
  const failed = options(); failed.entry.operationFailures = [{ operation: 'destroy', error: new Error('destroy failed'), record }];
  assert.throws(() => assertTerminalCheckpointFault(failed), /cannot fail an original operation/u);
  const otherMember = options(); otherMember.fault = { boundary: 'destroyed', record: { ...record, operationId: 'original-a' } };
  assert.throws(() => assertTerminalCheckpointFault(otherMember), /exact original terminal B checkpoint/u);
  assert.throws(() => assertTerminalCheckpointFault({ ...options(), injected: false }), /exact original terminal B checkpoint/u);
});

// A reader of a raw stream destroyed without a reason sees Node's own error; the SDK no longer surfaces it.
async function readerOfClosedAttachment() {
  const stream = new Readable({ read() {} });
  const reading = (async () => { for await (const _chunk of stream) { /* no original output */ } })();
  stream.destroy();
  return reading.then(() => assert.fail('A closed attachment reader completed.'), (error) => error);
}

function workflowFailure(primary, cleanupFailures) {
  return Object.assign(new AggregateError([primary, ...cleanupFailures.map(({ error }) => error)], 'Concurrent sandbox workflow failed.'),
    { name: 'ConcurrentSandboxWorkflowError', primaryFailure: { error: primary }, cleanupFailures });
}

test('only the exact retained exit of a member the failure domain stopped satisfies an injected control loss', async () => {
  const rawClose = await readerOfClosedAttachment();
  assert.equal(rawClose.code, 'ERR_STREAM_PREMATURE_CLOSE');
  const bExit = new Error('Original primary exited during active membership: {"kind":"unavailable","reason":"sandbox_stopped"}');
  const aExit = new Error(bExit.message);
  const bReaders = new AggregateError([rawClose, bExit], 'Original reader failures retained.');
  const aReaders = new AggregateError([aExit], 'Original reader failures retained.');
  const cleanup = [{ member: 'b', operation: 'readers', error: bReaders }, { member: 'a', operation: 'readers', error: aReaders }];
  const accepted = (primary, labels) => {
    const exits = stoppedMemberExits(workflowFailure(primary, cleanup), labels);
    return everyFailureBranch(primary, (original) => exits.has(original));
  };
  assert.equal(accepted(bExit, ['b']), true, 'The stopped member\'s retained exit is its stop report.');
  assert.equal(accepted(aExit, ['b']), false, 'A member-local B failure cannot explain a stopped A.');
  assert.equal(accepted(aExit, ['a', 'b']), true);
  assert.equal(accepted(rawClose, ['b']), false, 'A raw reader close is no longer an SDK stop signature.');
  assert.equal(accepted(new Error(bExit.message), ['b']), false, 'A copied exit message is not the retained reader error.');
  // Models nn12r7e1: the supervisor's 404 broker exec, returned through the worker channel.
  const supervisor = new Error('Engine POST /containers/68325ec783e6/exec returned 404', { cause: { name: 'Error', message: 'returned 404' } });
  assert.equal(accepted(supervisor, ['a', 'b']), false);
  assert.equal(accepted(new AggregateError([bExit, supervisor]), ['b']), false);
  const continuity = [{ member: 'b', operation: 'continuity', error: bReaders }];
  assert.equal(stoppedMemberExits(workflowFailure(bExit, continuity), ['b']).size, 0);
});

test('after a selected fault only live peers held by an active observing coordinator keep their broker controls', () => {
  const active = { kind: 'active', members: [{ sandboxId: 'docker-a', kind: 'active' }, { sandboxId: 'docker-b', kind: 'active' }] };
  const fenced = { kind: 'fenced', failure: { kind: 'authority_lost', source: 'control' }, members: active.members };
  const observation = (member, coordinator) => ({ phase: 'continuity_before', member, sandboxId: `docker-${member}`, coordinator });
  const controlLoss = { faultEntered: true, failedMember: 'b' };
  assert.equal(supersededContinuityControl(observation('b', fenced), {}), null, 'Without a selected fault every control still runs.');
  assert.equal(supersededContinuityControl(observation('b', active), controlLoss), 'selected_failed_member');
  assert.equal(supersededContinuityControl(observation('a', active), controlLoss), null);
  assert.equal(supersededContinuityControl(observation('a', fenced), controlLoss), 'coordinator_not_active');
  const topology = { faultEntered: true, failedMember: null, topologyInjected: true };
  assert.equal(supersededContinuityControl(observation('a', active), topology), 'selected_topology_fence',
    'Injected topology fences the whole group even before the observing coordinator reports it.');
  assert.equal(supersededContinuityControl(observation('b', fenced), topology), 'selected_topology_fence');
});
