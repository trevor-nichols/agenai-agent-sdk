import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Evidence } from '../../coordinator/evidence.mjs';
import { assertTopologyFenceOutcome, captureTopologyFence } from './topology-fence.mjs';

class SandboxStateError extends Error {
  constructor(message) { super(message); this.name = 'SandboxStateError'; }
}
class SandboxOperationError extends Error {
  constructor(code, message) { super(message); this.name = 'SandboxOperationError'; this.code = code; }
}
const sdk = { SandboxStateError, SandboxOperationError };
const stoppedExit = 'Original primary exited during active membership: {"kind":"unavailable","reason":"sandbox_stopped"}';

// Public-port observations let qualification prove its own receipt and ordering. They do not model
// or qualify the SDK's fence propagation; the native case remains the only proof of that.
function member(label) {
  let state = { kind: 'ready' };
  const entry = { label, owner: { id: `docker-${label}`, get state() { return state; }, recoveryRecord: { operationId: `original-${label}` } },
    sandbox: { files: { async stat(path) {
      assert.equal(path, '.');
      if (state.kind !== 'ready') throw new SandboxStateError('Live files require ready compute and no other entered file operation.');
      return { kind: 'completed', entry: { kind: 'directory', path: '.', byteLength: 0, permissions: 0o755 } };
    } } } };
  return { entry, state(value) { state = value; } };
}

async function setup(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'concurrency-topology-fence-'));
  const evidence = new Evidence(join(directory, 'evidence')); await evidence.initialize(Buffer.from('{}'));
  t.after(async () => { await evidence.close(); await rm(directory, { recursive: true, force: true }); });
  const a = member('a'), b = member('b');
  const coordinator = { state: { kind: 'active', generation: 'original-generation',
    members: [{ sandboxId: 'docker-a', kind: 'active' }, { sandboxId: 'docker-b', kind: 'active' }] } };
  const fence = () => {
    coordinator.state = { kind: 'fenced', failure: { kind: 'authority_lost', source: 'host' }, generation: 'original-generation',
      members: [{ sandboxId: 'docker-a', kind: 'draining' }, { sandboxId: 'docker-b', kind: 'draining' }] };
    a.state({ kind: 'stopping' }); b.state({ kind: 'stopping' });
  };
  const input = { coordinator, members: [a.entry, b.entry], sdk, timeoutMs: 1000, signal: AbortSignal.timeout(3000), evidence };
  return { a, b, coordinator, fence, input };
}

// The SDK fails a stopped member's readers with its typed fence failure; Node's own close is no longer a stop signature.
const fencedReader = () => new SandboxOperationError('driver_failure', 'The shared Desktop coordinator authority was lost.');

async function readerPrematureClose() {
  const stream = new Readable({ read() {} }); stream.on('error', () => {});
  const reading = (async () => { try { for await (const _chunk of stream); } catch (error) { return error; } return undefined; })();
  setImmediate(() => stream.destroy());
  return reading;
}

test('a selected topology fence holds the original workflow until every member admission closes', async (t) => {
  const { fence, input } = await setup(t);
  const progress = [];
  const fenced = await captureTopologyFence({ ...input, async inject() {
    progress.push('injected'); setTimeout(() => { progress.push('fenced'); fence(); }, 30);
  } });
  progress.push('workflow-resumed');
  assert.deepEqual(progress, ['injected', 'fenced', 'workflow-resumed']);
  assert.deepEqual(fenced.receipt.memberStatesBefore, [{ label: 'a', state: { kind: 'ready' } }, { label: 'b', state: { kind: 'ready' } }]);
  assert.deepEqual(fenced.receipt.memberStates, [{ label: 'a', state: { kind: 'stopping' } }, { label: 'b', state: { kind: 'stopping' } }]);
  assert.deepEqual(fenced.receipt.coordinator.failure, { kind: 'authority_lost', source: 'host' });
  assert.deepEqual(fenced.rejections.map(({ label, error }) => [label, error.name]), [['a', 'SandboxStateError'], ['b', 'SandboxStateError']]);
  const stored = JSON.parse(await readFile(fenced.receipt.evidence.path, 'utf8'));
  assert.deepEqual(stored.rejections.map(({ label, failure }) => [label, failure.name]), [['a', 'SandboxStateError'], ['b', 'SandboxStateError']]);
  assert.equal(stored.completedAt, fenced.receipt.completedAt);
});

test('unregistered topology never enters a group whose member already left ready or active membership', async (t) => {
  let injected = false;
  const stopped = await setup(t);
  stopped.b.state({ kind: 'stopping' });
  await assert.rejects(captureTopologyFence({ ...stopped.input, async inject() { injected = true; } }), /Original B must be ready/u);
  const draining = await setup(t);
  draining.coordinator.state.members[1] = { sandboxId: 'docker-b', kind: 'draining' };
  await assert.rejects(captureTopologyFence({ ...draining.input, async inject() { injected = true; } }),
    /Original B must be an active coordinated member/u);
  assert.equal(injected, false);
});

test('an unnoticed topology change fails instead of resuming the original workflow', async (t) => {
  const { input } = await setup(t);
  await assert.rejects(captureTopologyFence({ ...input, timeoutMs: 50, async inject() {} }), /did not fence the original group/u);
});

test('a fenced coordinator cannot stand in for a member whose public admission still accepts work', async (t) => {
  const { a, coordinator, fence, input } = await setup(t);
  await assert.rejects(captureTopologyFence({ ...input, async inject() { fence(); a.state({ kind: 'ready' }); } }),
    /Original A public live-file admission did not reject/u);
  assert.equal(coordinator.state.kind, 'fenced');
});

test('typed fenced stop signatures qualify only behind the original receipt; raw and unrelated branches still fail', async (t) => {
  const { coordinator, fence, input } = await setup(t);
  const receipt = await captureTopologyFence({ ...input, async inject() { fence(); } });
  const outcome = (primary) => assertTopologyFenceOutcome({ primary, fence: receipt, coordinator, sdk });
  const [first, second] = [fencedReader(), fencedReader()];
  // nn16r7e1/nn17r7e1 primary: one surviving-member reader; their retained reader sets add the stopped exit receipt.
  assert.deepEqual(outcome(first), { fencedAt: receipt.receipt.fencedAt, members: ['a', 'b'] });
  outcome(new AggregateError([first, second, new Error(stoppedExit)], 'Original reader failures retained.'));
  outcome(new AggregateError([new SandboxStateError('Fenced.'), new SandboxOperationError('driver_failure', 'Authority lost.')]));
  assert.throws(() => assertTopologyFenceOutcome({ primary: first, fence: undefined, coordinator, sdk }), /pre-resume fence receipt/u);
  const unrelated = /An unrelated error cannot satisfy/u;
  const rawClose = await readerPrematureClose();
  assert.equal(rawClose.code, 'ERR_STREAM_PREMATURE_CLOSE');
  assert.throws(() => outcome(rawClose), unrelated);
  assert.throws(() => outcome(new AggregateError([first, rawClose, new Error(stoppedExit)])), unrelated);
  assert.throws(() => outcome(new Error('Original primary exited during active membership: {"kind":"exited","code":1}')), unrelated);
  assert.throws(() => outcome(new AggregateError([first, new Error('Original primary stderr: TLS fixture changed')])), unrelated);
  assert.throws(() => outcome(new SandboxOperationError('persistence_failure', 'Checkpoint rejected.')), unrelated);
  assert.throws(() => outcome(new AggregateError([])), unrelated);
  coordinator.state = { ...coordinator.state, failure: { kind: 'authority_lost', source: 'native_holder' } };
  assert.throws(() => outcome(first), /later coordinator transition/u);
});
