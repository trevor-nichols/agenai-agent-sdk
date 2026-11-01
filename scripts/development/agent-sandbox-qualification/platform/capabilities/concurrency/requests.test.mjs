import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerRequests } from './requests.mjs';

function supervisor({ maximumMessages = 64, handle = async () => 'handled', recordCheckpoint } = {}) {
  const members = {}, replies = [], failures = [];
  const requests = createWorkerRequests({ maximumMessages, members: () => members,
    recordCheckpoint: recordCheckpoint ?? ((value) => { members[value.label] = value; }),
    handle: (kind, value, snapshot, requestId) => handle(kind, value, snapshot, requestId),
    reply: (id, outcome) => replies.push({ id, ...outcome }), fail: (error) => failures.push(error) });
  return { members, replies, failures, requests };
}

const within = (promise, label) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle.`)), 1000).unref())]);

test('answers a checkpoint while an earlier ordered request waits for the progress it unblocks', async () => {
  // Models nn03r7a2: an observation waits for the coordinator, whose entered effect awaits the checkpoint receipt.
  let checkpointAnswered;
  const progress = new Promise((resolve) => { checkpointAnswered = resolve; });
  const { replies, failures, requests } = supervisor({ handle: async (kind) => { await progress; return kind; } });
  requests.receive({ kind: 'observation', id: 1, value: { phase: 'continuity', member: 'a' } });
  requests.receive({ kind: 'checkpoint', id: 2, value: { label: 'b', record: { phase: 'starting' } } });
  assert.deepEqual(replies, [{ id: 2, value: undefined }]);
  checkpointAnswered();
  await within(requests.settled(), 'The ordered observation');
  assert.deepEqual(replies, [{ id: 2, value: undefined }, { id: 1, value: 'observation' }]);
  assert.deepEqual(failures, []);
  assert.equal(requests.count, 2);
});

test('answers an effect phase on arrival and records it after the ordered request it followed', async () => {
  // Models a fault entered inside B's persist callback while A's observation waits for the progress it blocks.
  let effectAnswered;
  const progress = new Promise((resolve) => { effectAnswered = resolve; });
  const handled = [];
  const { replies, failures, requests } = supervisor({ handle: async (kind, value) => {
    if (kind === 'observation') await progress;
    handled.push({ kind, value }); return kind;
  } });
  requests.receive({ kind: 'observation', id: 1, value: { name: 'continuity:a' } });
  requests.receive({ kind: 'effect_phase', id: 2, value: { name: 'fault-entered' } });
  assert.deepEqual(replies, [{ id: 2, value: undefined }]);
  effectAnswered();
  await within(requests.settled(), 'The ordered observation and effect phase');
  assert.deepEqual(handled.map(({ kind, value }) => `${kind}:${value.name}`), ['observation:continuity:a', 'effect_phase:fault-entered']);
  const { acknowledged } = handled[1].value;
  assert.equal(acknowledged.requestId, 2); assert(Date.parse(acknowledged.at) <= Date.now());
  assert.deepEqual(replies, [{ id: 2, value: undefined }, { id: 1, value: 'observation' }]);
  assert.deepEqual(failures, []);
});

test('gives each ordered request the member checkpoints received before it', async () => {
  const seen = [];
  const { members, requests } = supervisor({ handle: async (_kind, value, snapshot) => { seen.push({ id: value, snapshot }); } });
  const first = { label: 'a', record: { phase: 'starting' } }, second = { label: 'a', record: { phase: 'running' } };
  requests.receive({ kind: 'checkpoint', id: 1, value: first });
  requests.receive({ kind: 'observation', id: 2, value: 'before-running' });
  requests.receive({ kind: 'checkpoint', id: 3, value: second });
  requests.receive({ kind: 'observation', id: 4, value: 'after-running' });
  await requests.settled();
  assert.deepEqual(seen, [{ id: 'before-running', snapshot: { a: first } }, { id: 'after-running', snapshot: { a: second } }]);
  assert.deepEqual(members, { a: second });
});

test('passes each ordered request its worker request id for cut binding', async () => {
  const ids = [];
  const { requests } = supervisor({ handle: async (_kind, _value, _snapshot, requestId) => { ids.push(requestId); } });
  requests.receive({ kind: 'observation', id: 4, value: {} });
  requests.receive({ kind: 'effect_phase', id: 5, value: { name: 'fault-entered' } });
  await requests.settled();
  assert.deepEqual(ids, [4, 5]);
});

test('settles ordered requests and enqueued tasks one at a time in arrival order', async () => {
  const events = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const { replies, requests } = supervisor({ handle: async (kind, value) => {
    events.push(`start ${value}`); if (value === 'first') await first; events.push(`end ${value}`); return value;
  } });
  requests.receive({ kind: 'phase', id: 1, value: 'first' });
  requests.receive({ kind: 'phase', id: 2, value: 'second' });
  requests.enqueue(async () => { events.push('handoff'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start first']);
  releaseFirst();
  await requests.settled();
  assert.deepEqual(events, ['start first', 'end first', 'start second', 'end second', 'handoff']);
  assert.deepEqual(replies.map(({ id }) => id), [1, 2]);
});

test('refuses requests beyond the bounded census without answering them', async () => {
  const { replies, failures, members, requests } = supervisor({ maximumMessages: 1 });
  requests.receive({ kind: 'phase', id: 1, value: 'admitted' });
  requests.receive({ kind: 'checkpoint', id: 2, value: { label: 'a', record: {} } });
  requests.receive(null);
  await requests.settled();
  assert.deepEqual(replies, [{ id: 1, value: 'handled' }]);
  assert.deepEqual(members, {});
  assert.deepEqual(failures.map(({ message }) => message), Array(2).fill('Original worker control protocol exceeded its bounded request census.'));
});

test('returns handler and checkpoint failures to the worker and retains them for the supervisor', async () => {
  const { replies, failures, requests } = supervisor({
    handle: async () => { throw new Error('Required phase lacks complete original native observer bytes.'); },
    recordCheckpoint: () => { throw new Error('Malformed original checkpoint.'); } });
  requests.receive({ kind: 'observation', id: 1, value: {} });
  requests.receive({ kind: 'checkpoint', id: 2, value: {} });
  await requests.settled();
  assert.deepEqual(replies.map(({ id, failure }) => ({ id, message: failure.message })), [
    { id: 2, message: 'Malformed original checkpoint.' },
    { id: 1, message: 'Required phase lacks complete original native observer bytes.' }]);
  assert.deepEqual(failures.map(({ message }) => message).sort(),
    ['Malformed original checkpoint.', 'Required phase lacks complete original native observer bytes.']);
});

test('keeps the IPC listener alive when a failure cannot be described', async () => {
  const unreadable = { get name() { throw new Error('Unreadable failure name.'); } };
  const { replies, failures, requests } = supervisor({ recordCheckpoint: () => { throw unreadable; } });
  assert.doesNotThrow(() => requests.receive({ kind: 'checkpoint', id: 1, value: {} }));
  requests.receive({ kind: 'phase', id: 2, value: 'after' });
  await requests.settled();
  assert.deepEqual(replies, [{ id: 2, value: 'handled' }]);
  assert.equal(failures[0], unreadable); assert.equal(failures[1].message, 'Unreadable failure name.');
});
