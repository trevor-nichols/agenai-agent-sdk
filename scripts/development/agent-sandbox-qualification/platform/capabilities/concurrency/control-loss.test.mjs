import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Evidence } from '../../coordinator/evidence.mjs';
import { captureControlLossAdmission, classifyControlLoss, observeHelperExit } from './control-loss.mjs';

class SandboxStateError extends Error {
  constructor(message) { super(message); this.name = 'SandboxStateError'; }
}

const sdk = { SandboxStateError };
const selected = { expectedDomain: 'member_local' };
const control = { report: { captured: { label: 'b' }, injected: { at: '2026-10-30T00:00:00.000Z', label: 'b' } } };
const observations = [{ member: 'a', phase: 'cleanup_continuity', continuity: { checkpoint: 'original-peer-after-failure' } }];

// Independent public-port observations let qualification prove its own receipt and ordering.
// They do not model or qualify SDK infrastructure-loss propagation.
function member(label) {
  let state = { kind: 'ready' }, rejection;
  const entry = { label, owner: { get state() { return state; }, recoveryRecord: { operationId: `original-${label}` } },
    sandbox: { files: { async stat(path) {
      assert.equal(path, '.');
      if (rejection) throw rejection;
      return { kind: 'completed', entry: { kind: 'directory', path: '.', byteLength: 0, permissions: 0o755 } };
    } } } };
  return { entry, state(value) { state = value; }, reject(error) { rejection = error; } };
}

async function setup(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ms006-control-receipt-'));
  const evidence = new Evidence(join(directory, 'evidence')); await evidence.initialize(Buffer.from('{}'));
  t.after(async () => { await evidence.close(); await rm(directory, { recursive: true, force: true }); });
  const a = member('a'), b = member('b');
  const coordinator = { state: { kind: 'active', generation: 'original-generation' } };
  const input = { control, coordinator, members: [a.entry, b.entry], sdk, selected, timeoutMs: 50,
    signal: AbortSignal.timeout(3000), evidence };
  return { a, b, coordinator, evidence, input };
}

test('control-loss callback does not continue while original B remains ready', async (t) => {
  const { b, input } = await setup(t);
  const driverFailure = Object.assign(new Error('Later file driver failure'), { name: 'SandboxOperationError', code: 'driver_failure' });
  b.reject(driverFailure);
  const progress = ['original-control-lost'];
  const callback = async () => {
    await captureControlLossAdmission(input);
    progress.push('workflow-continued');
  };
  await assert.rejects(callback(), /did not close unsafe original B admission/u);
  assert.deepEqual(progress, ['original-control-lost']);
  assert.deepEqual(b.entry.owner.state, { kind: 'ready' });
  await assert.rejects(b.entry.sandbox.files.stat('.'), (error) => error === driverFailure);
});

test('ordinary later failure and successful cleanup cannot qualify without the original admission receipt', async (t) => {
  const { a, b, coordinator, evidence } = await setup(t);
  b.reject(Object.assign(new Error('Later stream failed'), { name: 'SandboxOperationError', code: 'stream_failure' }));
  await assert.rejects(b.entry.sandbox.files.stat('.'), { code: 'stream_failure' });
  a.state({ kind: 'destroyed' }); b.state({ kind: 'destroyed' });
  await assert.rejects(classifyControlLoss({ injected: true, control, admission: undefined, coordinator,
    selected, observations, evidence, sdk }), /original pre-cleanup admission receipt/u);
  assert.deepEqual([a.entry.owner.state, b.entry.owner.state], [{ kind: 'destroyed' }, { kind: 'destroyed' }]);
});

test('local control loss retains B exact public rejection before callback continuation and later cleanup', async (t) => {
  const { a, b, coordinator, evidence, input } = await setup(t);
  const original = new SandboxStateError('Original B admission closed.');
  const progress = ['original-control-lost'];
  const closure = setTimeout(() => { b.state({ kind: 'stopping' }); b.reject(original); }, 10);
  t.after(() => clearTimeout(closure));
  const admission = await captureControlLossAdmission({ ...input, timeoutMs: 1000 });
  progress.push('workflow-continued');
  assert.equal(admission.rejections[0].error, original);
  assert.deepEqual(admission.receipt.memberStates, [{ label: 'a', state: { kind: 'ready' } }, { label: 'b', state: { kind: 'stopping' } }]);
  assert.equal(admission.receipt.rejections[0].failure.message, 'Original B admission closed.');
  assert.deepEqual(progress, ['original-control-lost', 'workflow-continued']);
  const stored = JSON.parse(await readFile(admission.receipt.evidence.path, 'utf8'));
  assert.equal(stored.rejections[0].failure.message, 'Original B admission closed.');
  a.state({ kind: 'destroyed' }); b.state({ kind: 'destroyed' });
  assert.deepEqual(await classifyControlLoss({ injected: true, control, admission, coordinator, selected, observations, evidence, sdk }),
    { domain: 'member_local' });
  await assert.rejects(classifyControlLoss({ injected: true, control, admission, coordinator, selected, observations: [], evidence, sdk }),
    /original peer did not prove/u);
  coordinator.state = { kind: 'fenced', failure: { kind: 'authority_lost', source: 'control' } };
  await assert.rejects(classifyControlLoss({ injected: true, control, admission, coordinator, selected, observations, evidence, sdk }),
    /later coordinator transition/u);
});

test('a selected control loss that fences the original group fails at its admission receipt', async (t) => {
  const { a, b, coordinator, input } = await setup(t);
  coordinator.state = { kind: 'fenced', failure: { kind: 'authority_lost', source: 'control' } };
  a.state({ kind: 'stopping' }); b.state({ kind: 'stopping' });
  b.reject(new SandboxStateError('Original B fenced.')); a.reject(new SandboxStateError('Original A fenced.'));
  await assert.rejects(captureControlLossAdmission(input), /must not fence the original group/u);
});

// Models nn13r7g1 (route_observer, source control) and nn14r7g1 (egress_broker, source host): the selected helper's own
// exit after a member-local receipt was an SDK over-fence, so a later fence now fails the row whatever its cause.
test('a fence after a member-local receipt fails even when it reports the selected helper absence', async (t) => {
  for (const [role, source, message] of [
    ['route_observer', 'control', 'A registered Desktop producer disappeared or acquired another network.'],
    ['egress_broker', 'host', 'Owned bridge has an unexpected native endpoint census.']]) {
    const { b, coordinator, evidence, input } = await setup(t);
    const selectedLoss = { role, expectedDomain: 'member_local' };
    b.state({ kind: 'stopping' }); b.reject(new SandboxStateError('Original B admission closed.'));
    const admission = await captureControlLossAdmission({ ...input, selected: selectedLoss });
    coordinator.state = { kind: 'fenced', failure: { kind: 'authority_lost', source, message } };
    await assert.rejects(classifyControlLoss({ injected: true, control, admission, coordinator, selected: selectedLoss,
      observations, evidence, sdk }), /later coordinator transition/u);
  }
});

test('the helper witness polls the exact selected helper until it stops and records the peer helper beside it', async () => {
  const states = { 'b-id': ['running', 'running', 'exited'], 'a-id': ['running', 'running', 'running'] };
  const calls = [];
  const engine = { async request(method, path, body, options) {
    assert.deepEqual([method, body, options], ['GET', undefined, { allowed: [200, 404] }]);
    const id = /^\/containers\/([a-z-]+)\/json$/u.exec(path)[1]; calls.push(id);
    const status = states[id].shift();
    return { status: 200, data: { Id: id, State: { Status: status, Running: status === 'running', ExitCode: 0, FinishedAt: '2026-10-31T11:20:14.018Z' } } };
  } };
  const witness = await observeHelperExit({ engine, selected: { label: 'b', id: 'b-id' }, peer: { label: 'a', id: 'a-id' }, timeoutMs: 1000, intervalMs: 1 });
  assert.equal(witness.polls, 3);
  assert.deepEqual([witness.selected.running, witness.selected.status, witness.peer.running], [false, 'exited', true]);
  assert.deepEqual(calls.filter((id) => id === 'b-id').length, 3);
  const replaced = { async request() { return { status: 200, data: { Id: 'other', State: { Status: 'running', Running: true } } }; } };
  await assert.rejects(observeHelperExit({ engine: replaced, selected: { label: 'b', id: 'b-id' }, peer: { label: 'a', id: 'a-id' }, timeoutMs: 10 }),
    /another container/u);
});
