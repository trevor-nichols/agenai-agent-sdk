import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { addressAdmission, deniedCoverage } from '../../../../../../../packages/ai/sandbox-docker/src/network/policy.js';
import { PRIVATE_POOL, requireAllocationReadback, selectAllocation } from './allocation.js';
import { baseline, compose, memberFixture } from './fixtures.js';
import { LIMITS, TransitionModel } from './model.js';
import { projectExternal, requireRegisteredTransition } from './projection.js';

// Authoring gate: these own the proposed research decisions, not production concurrency.
// Regressions are early slot release, broad ownership subtraction, stale health, and lost cleanup.
// No existing production test owns this not-yet-implemented coordinator; no production seam is added.
const external = projectExternal(baseline, []);
const a = memberFixture(0); const b = memberFixture(1);

test('private pool is denied before dispatch and exact reservations survive collision/exhaustion/readback', () => {
  const exclusions = deniedCoverage(['11.230.251.0/24', '::/0']);
  const admission = addressAdmission(exclusions);
  const reserved: string[] = [];
  for (let index = 0; index < PRIVATE_POOL.length; index += 1) {
    const allocation = selectAllocation([], reserved, [exclusions, []]);
    assert.equal(admission(allocation.gateway), false);
    assert.equal(admission(allocation.subnet.split('/')[0]), false);
    reserved.push(allocation.subnet);
  }
  assert.throws(() => selectAllocation([], reserved, [exclusions]), /exhausted/u);
  assert.throws(() => selectAllocation(['10.240.0.0/24'], [], [exclusions]), /exhausted/u);
  assert.equal(selectAllocation(['10.240.0.0/28'], [], [exclusions]).subnet, '10.240.0.16/28');
  assert.throws(() => requireAllocationReadback({ subnet: PRIVATE_POOL[0], gateway: '10.240.0.1' },
    { subnet: '11.230.251.0/24', gateway: '11.230.251.1' }), /readback/u);
});

test('exact member projection admits the registered empty-to-endpoint transition while A remains active', () => {
  const alternatives = [[a.active], [a.active, b.empty], [a.active, b.active]];
  for (const [index, members] of [[{ fixture: a, phase: 'active' as const }],
    [{ fixture: a, phase: 'active' as const }, { fixture: b, phase: 'empty' as const }],
    [{ fixture: a, phase: 'active' as const }, { fixture: b, phase: 'active' as const }]].entries()) {
    assert.equal(requireRegisteredTransition(compose(members), external, alternatives), index);
  }
});

test('foreign Engine/VM changes remain rejected inside every registered phase', () => {
  const alternatives = [[a.active], [a.active, b.empty], [a.active, b.active]];
  const observations = [compose([{ fixture: a, phase: 'active' }]),
    compose([{ fixture: a, phase: 'active' }, { fixture: b, phase: 'empty' }]),
    compose([{ fixture: a, phase: 'active' }, { fixture: b, phase: 'active' }])];
  for (const observation of observations) {
    for (const change of [
      { ...observation, engine: { ...observation.engine, hostname: 'foreign-hostname' } },
      { ...observation, vm: { ...observation.vm, snapshot: { ...observation.vm.snapshot, networkNamespace: 'net:[999]' } } },
      { ...observation, engine: { ...observation.engine, networks: observation.engine.networks.map((network, index) => index === 0
        ? { ...network, Containers: { ...network.Containers, ['f'.repeat(64)]: { Name: 'foreign', EndpointID: '', MacAddress: '', IPv4Address: '', IPv6Address: '' } } } : network) } },
      { ...observation, vm: { ...observation.vm, snapshot: { ...observation.vm.snapshot,
        routes: observation.vm.snapshot.routes.map((route, index) => index === 0 ? { ...route, gateways: ['11.1.1.1'] } : route) } } },
    ]) assert.throws(() => requireRegisteredTransition(change, external, alternatives), /outside every/u);
  }
});

test('member-local projection corruption cannot be hidden by ownership subtraction', () => {
  const observation = compose([{ fixture: a, phase: 'active' }, { fixture: b, phase: 'empty' }]);
  const alternatives = [[a.active, b.empty]];
  for (const change of [
    { ...observation, engine: { ...observation.engine, networks: observation.engine.networks.map((network) => network.Id === b.network.Id
      ? { ...network, IPAM: { ...network.IPAM, Config: [{ Subnet: '11.0.0.0/24', Gateway: '11.0.0.1' }] } } : network) } },
    { ...observation, vm: { ...observation.vm, snapshot: { ...observation.vm.snapshot,
      interfaces: observation.vm.snapshot.interfaces.map((device) => device.index === 10 ? { ...device, name: 'replacement-veth' } : device) } } },
    { ...observation, vm: { ...observation.vm, snapshot: { ...observation.vm.snapshot,
      routes: [...observation.vm.snapshot.routes, { ...observation.vm.snapshot.routes[0], interfaceIndex: 9 }] } } },
  ]) assert.throws(() => requireRegisteredTransition(change, external, alternatives), /outside every/u);
});

function readyModel() {
  const model = new TransitionModel(); model.persistMember('A'); model.activate('A'); model.observe(0, 1, true); return model;
}
function enter(model: TransitionModel, member: string, resource: string, now = 1) {
  const id = model.enqueue(member, resource); assert.equal(model.next(now), id);
  model.persistResourceIntent(id); model.persistTransitionIntent(id); model.dispatch(id); return id;
}

test('cancelled queued intent cannot dispatch and persists its cancellation before capacity is reclaimed', () => {
  const model = readyModel(); model.persistMember('B');
  const entered = enter(model, 'B', 'observer-create'); const queued = model.enqueue('B', 'network-create');
  model.cancel(queued); assert.equal(model.transitions.get(queued)?.phase, 'cancel_pending');
  assert.throws(() => model.dispatch(queued), /cannot advance/u);
  model.persistUndispatchedCancellation(queued);
  assert.equal(model.transitions.has(entered), true);
  assert.equal(model.next(20), null);
});

test('cancellation after entry and late completion retain the slot, exact ID, allocation and dirty generation', () => {
  const model = readyModel(); model.persistMember('B'); const subnet = model.members.get('B')?.subnet;
  const id = enter(model, 'B', 'network-create'); model.cancel(id);
  assert.equal(model.transitions.get(id)?.phase, 'entered'); assert.equal(model.next(2), null);
  assert.throws(() => model.retire('B'), /obligations/u);
  model.deadline(30_001); assert.equal(model.mode, 'fenced'); assert.equal(model.transitions.get(id)?.phase, 'uncertain');
  assert.throws(() => model.activate('B'), /fenced/u);
  assert.throws(() => model.work('A', 'tls'), /closed/u);
  assert.equal(model.mode, 'fenced');
  model.returned(id, 'exact-late-network-id');
  assert.equal(model.members.get('B')?.resources.has('exact-late-network-id'), true);
  assert.equal(model.members.get('B')?.subnet, subnet); assert.equal(model.dirty, true);
  model.persistMemberResult(id); model.persistSettlement(id);
  assert.equal(model.mode, 'fenced'); assert.throws(() => model.retire('B'), /obligations/u);
  assert.throws(() => model.close(false), /obligations/u);
});

test('each effect requires both persistence boundaries and complete observation before the next effect', () => {
  const model = readyModel(); const id = model.enqueue('A', 'observer-create'); assert.equal(model.next(1), id);
  assert.throws(() => model.dispatch(id), /cannot advance/u);
  model.persistResourceIntent(id); assert.throws(() => model.dispatch(id), /cannot advance/u);
  model.persistTransitionIntent(id); model.dispatch(id); model.returned(id, 'observer-id');
  assert.throws(() => model.persistSettlement(id), /cannot advance/u);
  model.persistMemberResult(id); model.persistSettlement(id);
  const second = model.enqueue('A', 'network-create'); assert.equal(model.next(2), 'observe');
  model.observe(2, 3, true); assert.equal(model.next(3), second);
});

test('independent reader/file work and heartbeat scheduling progress during another pending effect', async () => {
  const model = readyModel(); model.persistMember('B'); const id = enter(model, 'B', 'network-create');
  const effect = Promise.withResolvers<string>();
  let effectSettled = false;
  const entered = effect.promise.then((resourceId) => { effectSettled = true; model.returned(id, resourceId); });
  const output = new PassThrough();
  const soleReader = (async () => { const chunks: Buffer[] = []; for await (const chunk of output) chunks.push(chunk); return Buffer.concat(chunks).toString(); })();
  const scratch = await mkdtemp('/private/tmp/agenai-transition-model-');
  try {
    const heartbeat = new Promise<void>((resolve) => setImmediate(() => { model.work('A', 'heartbeat'); resolve(); }));
    output.end('original-reader-bytes'); model.work('A', 'reader');
    await writeFile(`${scratch}/A.txt`, 'independent-file-bytes'); model.work('A', 'file');
    assert.equal(await soleReader, 'original-reader-bytes');
    assert.equal(await readFile(`${scratch}/A.txt`, 'utf8'), 'independent-file-bytes');
    await heartbeat; assert.equal(effectSettled, false); assert.equal(model.transitions.get(id)?.phase, 'entered');
  } finally { await rm(scratch, { recursive: true, force: true }); }
  effect.resolve('network-id'); await entered;
  model.persistMemberResult(id); model.persistSettlement(id);
});

test('health is served after one effect and before further mutations; total observation overrun fences', () => {
  const model = readyModel(); model.persistMember('B'); const id = enter(model, 'B', 'network-create');
  model.returned(id, 'network-id'); model.persistMemberResult(id); model.persistSettlement(id);
  model.enqueue('B', 'broker-start'); assert.equal(model.next(30_000), 'observe');
  model.observe(30_000, 40_000, true); assert.equal(model.mode, 'open');
  assert.equal(30_000 + LIMITS.observationMs + LIMITS.pollMs < LIMITS.freshnessMs, true);
  assert.equal(LIMITS.freshnessMs < LIMITS.leaseMs, true);
  model.observe(40_001, 50_002, true); assert.equal(model.mode, 'fenced');
});

test('membership, queue, stale observations and retained tombstones have visible finite refusal', () => {
  const encodedBudget = LIMITS.members * LIMITS.memberBytes + (LIMITS.queuedTransitions + LIMITS.enteredEffects) * LIMITS.transitionBytes
    + LIMITS.tombstones * 256 + 16 * 1024;
  assert.equal(encodedBudget <= LIMITS.journalBytes, true);
  const model = readyModel(); for (const member of ['B', 'C', 'D']) model.persistMember(member);
  assert.throws(() => model.persistMember('E'), /capacity/u);
  const cancelled: number[] = [];
  for (let index = 0; index < LIMITS.queuedTransitions; index += 1) cancelled.push(model.enqueue('A', `create-${index}`));
  for (const id of cancelled) model.cancel(id);
  assert.throws(() => model.enqueue('A', 'one-too-many'), /capacity/u);
  model.persistUndispatchedCancellation(cancelled[0]); assert.equal(typeof model.enqueue('A', 'reclaimed-only-after-settlement'), 'number');
  model.deadline(LIMITS.freshnessMs + 1); assert.equal(model.mode, 'fenced');
  const tombstones = readyModel();
  for (let index = 0; index < LIMITS.tombstones; index += 1) {
    const id = tombstones.enqueue('A', 'never-dispatched'); tombstones.cancel(id); tombstones.persistUndispatchedCancellation(id);
  }
  assert.throws(() => tombstones.enqueue('A', 'past-tombstone-bound'), /capacity/u);
});

test('known stable member failure preserves the peer; unresolved/shared/last-path loss fences synchronously', () => {
  const local = readyModel(); local.persistMember('B'); local.activate('B');
  assert.equal(local.observationPath('B'), 'A'); assert.equal(local.observationPath('A'), 'B');
  assert.equal(local.failure({ kind: 'member', member: 'B', topology: 'known_stable', independentCensus: true }), 'member');
  local.work('A', 'reader');
  for (const facts of [{ kind: 'member' as const, member: 'B', topology: 'unresolved' as const, independentCensus: true },
    { kind: 'member' as const, member: 'A', topology: 'known_stable' as const, independentCensus: false },
    { kind: 'member' as const, member: 'A', topology: 'known_stable' as const, independentCensus: true }, { kind: 'shared' as const }]) {
    const model = readyModel(); model.persistMember('B'); assert.equal(model.failure(facts), 'group');
    assert.throws(() => model.work('A', 'tls'), /closed/u); assert.equal(model.dirty, true);
  }
});

test('stopped retained networks stay owned with zero observers and re-entry validates their complete projection', () => {
  const retained = compose([{ fixture: a, phase: 'retained' }, { fixture: b, phase: 'retained' }]);
  assert.deepEqual(projectExternal(retained, [a.retained, b.retained]), external);
  assert.throws(() => requireRegisteredTransition(retained, external, [[]]), /outside every/u);
  for (const lateCompletion of [false, true]) {
    const model = readyModel(); const id = enter(model, 'A', 'network-create'); model.returned(id, 'retained-network');
    model.persistMemberResult(id); model.persistSettlement(id); model.stop('A');
    assert.equal(model.mode, 'quiescent'); assert.throws(() => model.retire('A'), /obligations/u);
    assert.equal(model.next(3), null); assert.throws(() => model.observe(3, 4, true), /No live path/u);
    model.persistMember('B'); assert.notEqual(model.members.get('B')?.subnet, model.members.get('A')?.subnet);
    assert.equal(model.observationPath(), null);
    assert.throws(() => model.enqueue('B', 'network-create'), /only registered/u);
    assert.throws(() => model.bootstrapObserver('B', true, true, false), /re-entry/u);
    model.bootstrapObserver('B', true, true, true);
    assert.equal(model.trace.at(-1), 'bootstrap-observer-only:B');
    assert.throws(() => model.enqueue('B', 'network-create'), /only registered/u);
    const observer = enter(model, 'B', 'observer-create', 2);
    model.returned(observer, 'replacement-observer'); model.persistMemberResult(observer); model.persistSettlement(observer);
    const start = enter(model, 'B', 'observer-start', 3);
    if (lateCompletion) { model.deadline(30_003); assert.equal(model.mode, 'fenced'); }
    model.returned(start, 'replacement-observer'); model.persistMemberResult(start); model.persistSettlement(start);
    if (lateCompletion) {
      assert.throws(() => model.completeBootstrap('B', true), /fenced/u);
      assert.equal(model.mode, 'fenced'); assert.equal(model.next(30_004), null);
      assert.throws(() => model.enqueue('B', 'network-create'), /fenced/u);
    } else {
      model.completeBootstrap('B', true); assert.equal(model.observationPath(), 'B'); assert.equal(model.next(3), 'observe');
    }
  }
});

test('exact cleanup is available after route loss, wrong-daemon and absent-name uncertainty retain ownership', () => {
  const model = readyModel(); const id = enter(model, 'A', 'network-create'); model.returned(id, 'original-network-id');
  model.persistMemberResult(id); model.persistSettlement(id); model.failure({ kind: 'shared' });
  assert.throws(() => model.confirmRemoved('A', 'foreign-resource', true, true), /unrecorded/u);
  assert.throws(() => model.confirmRemoved('A', 'original-network-id', false, true), /authority/u);
  assert.throws(() => model.confirmRemoved('A', 'original-network-id', true, false), /absence/u);
  assert.equal(model.members.get('A')?.resources.has('original-network-id'), true);
  model.confirmRemoved('A', 'original-network-id', true, true); model.retire('A');
  model.close(true); assert.equal(model.dirty, false);
});
