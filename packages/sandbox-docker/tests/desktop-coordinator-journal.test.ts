import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { beginCoordinatorGeneration, createInitialCoordinatorSnapshot, planCoordinatorTransition } from '../src/network/desktop/coordinator/journal/plans.js';
import type { CoordinatorEvent, CoordinatorPlan } from '../src/network/desktop/coordinator/journal/plans.js';
import { COORDINATOR_JOURNAL_LIMITS, encodeCoordinatorSnapshot, parseCoordinatorSnapshot, snapshotDigest } from '../src/network/desktop/coordinator/journal/schema.js';
import type { CoordinatorSnapshot, DirtyGeneration, ResourceRole } from '../src/network/desktop/coordinator/journal/schema.js';

const digest = `sha256:${'a'.repeat(64)}`;
const authorityId = '00000000-0000-4000-8000-000000000001';
const generationId = '00000000-0000-4000-8000-000000000002';
const daemonId = 'original-engine';
const backendRevision = 'engine-1.52-v7-desktop-apple-virtualization-native-arm64';
const profile = 'desktop-apple-virtualization-native-arm64';

function accepted(plan: CoordinatorPlan): CoordinatorSnapshot {
  if (plan.kind === 'rejected') assert.fail(plan.reason);
  return plan.snapshot;
}

function dirty(snapshot: CoordinatorSnapshot): DirtyGeneration {
  assert.equal(snapshot.generation.kind, 'dirty');
  if (snapshot.generation.kind !== 'dirty') assert.fail('Expected dirty generation');
  return snapshot.generation;
}

function next(snapshot: CoordinatorSnapshot, event: CoordinatorEvent): CoordinatorSnapshot {
  return accepted(planCoordinatorTransition(snapshot, event));
}

function activate(): CoordinatorSnapshot {
  const initial = createInitialCoordinatorSnapshot({ authorityId, daemonId });
  return accepted(beginCoordinatorGeneration(initial, {
    identity: { generationId, ordinal: 1, coordinationRevision: 'desktop-coordination-v1', coordinationPolicyDigest: digest,
      engineBindingDigest: digest, endpointBindingDigest: digest, hostPreparationDigest: digest, nativeAssetDigest: digest },
    basis: { kind: 'host_engine_only', hostDigest: digest, engineDigest: digest, exclusionDigest: digest, atSequence: 1 },
  }));
}

function reservation(index: number): SandboxRecoveryRecord {
  const operationId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return parseSandboxRecoveryRecord({ format: 'agenai.sandbox-recovery.v3', backendId: 'agenai-docker', backendRevision,
    namespace: 'journal-protocol', operationId, sandboxId: `docker-${operationId}`, imageDigest: digest, policyDigest: digest,
    configurationDigest: digest, phase: 'reserved', authority: { kind: 'unverified' },
    resources: ['compute', 'storage', 'export', 'route_observer'].map((role) => ({ role, name: `${operationId}-${role}`, identity: { kind: 'planned' } })),
  });
}

function register(snapshot: CoordinatorSnapshot, index: number, slot = index - 1): CoordinatorSnapshot {
  return next(snapshot, { kind: 'register', record: reservation(index), slot,
    binding: { profile, backendRevision, configurationIdentityDigest: digest } });
}

function record(snapshot: CoordinatorSnapshot, memberId = dirty(snapshot).members[0].memberId): SandboxRecoveryRecord {
  const member = dirty(snapshot).members.find((item) => item.memberId === memberId);
  if (member === undefined) assert.fail('Missing member');
  return member.checkpoint.record;
}

function createResource(snapshot: CoordinatorSnapshot, role: ResourceRole, id: string,
  memberId = dirty(snapshot).members[0].memberId): CoordinatorSnapshot {
  const previous = record(snapshot, memberId);
  const creating = parseSandboxRecoveryRecord({ ...previous, phase: 'starting', authority: { kind: 'verified', backendIdentity: daemonId },
    resources: previous.resources.map((resource) => resource.role === role ? { ...resource, identity: { kind: 'creating' } } : resource) });
  snapshot = next(snapshot, { kind: 'checkpoint', memberId: previous.operationId, record: creating, mode: 'caller_persisted' });
  snapshot = next(snapshot, { kind: 'queue', memberId: previous.operationId, role, action: 'create' });
  const effectSequence = dirty(snapshot).queue[0].effectSequence;
  const arm = planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest });
  assert.equal(arm.kind, 'arm');
  snapshot = accepted(arm);
  snapshot = next(snapshot, { kind: 'returned', effectSequence, id });
  const identified = parseSandboxRecoveryRecord({ ...creating,
    resources: creating.resources.map((resource) => resource.role === role ? { ...resource, identity: { kind: 'identified', id, fingerprint: digest } } : resource) });
  return next(snapshot, { kind: 'settle', effectSequence, outcome: 'present', receiptDigest: digest, record: identified,
    presence: { kind: 'present', id, fingerprint: digest, inspectionDigest: digest, runtime: role === 'storage' ? 'not_applicable' : 'created' } });
}

function startObserver(snapshot: CoordinatorSnapshot, memberId: string, id: string): CoordinatorSnapshot {
  snapshot = next(snapshot, { kind: 'queue', memberId, role: 'route_observer', action: 'start' });
  const effectSequence = dirty(snapshot).queue.find((entry) => entry.memberId === memberId && entry.role === 'route_observer' && entry.action === 'start')?.effectSequence;
  assert.notEqual(effectSequence, undefined);
  if (effectSequence === undefined) assert.fail('Missing queued observer start');
  snapshot = accepted(planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest }));
  return next(snapshot, { kind: 'settle', effectSequence, outcome: 'started', receiptDigest: digest,
    presence: { kind: 'present', id, fingerprint: digest, inspectionDigest: digest, runtime: 'running' } });
}

function startedObserver(): CoordinatorSnapshot {
  const snapshot = createResource(register(activate(), 1), 'route_observer', 'observer-id');
  return startObserver(snapshot, record(snapshot).operationId, 'observer-id');
}

function stopObserver(snapshot: CoordinatorSnapshot, memberId: string): CoordinatorSnapshot {
  for (const action of ['control_close', 'delete'] as const) {
    snapshot = next(snapshot, { kind: 'queue', memberId, role: 'route_observer', action });
    const effectSequence = dirty(snapshot).queue.find((entry) => entry.memberId === memberId && entry.role === 'route_observer' && entry.action === action)?.effectSequence;
    if (effectSequence === undefined) assert.fail('Missing queued observer cleanup');
    snapshot = accepted(planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest }));
    snapshot = next(snapshot, { kind: 'settle', effectSequence, outcome: action === 'delete' ? 'absent' : 'control_joined', receiptDigest: digest,
      presence: action === 'delete' ? { kind: 'absent', reference: 'observer-id', fingerprint: digest,
        inspectedAtSequence: snapshot.sequence + 1, noLateProducerAfter: snapshot.sequence }
        : { kind: 'present', id: 'observer-id', fingerprint: digest, inspectionDigest: digest, runtime: 'exited' } });
  }
  return snapshot;
}

function openWithObserver(): CoordinatorSnapshot {
  const snapshot = startedObserver();
  return next(snapshot, { kind: 'full_basis', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest: digest,
    externalEngineDigest: digest, externalVmDigest: digest, exclusionDigest: digest, projectionDigest: digest, atSequence: snapshot.sequence + 1 } });
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
  return value;
}

test('stored coordinator protocol is closed, canonical, immutable and bounded including its native frame', () => {
  const snapshot = register(activate(), 1);
  const encoded = encodeCoordinatorSnapshot(snapshot);
  assert.equal(encodeCoordinatorSnapshot(parseCoordinatorSnapshot(JSON.stringify(reverseKeys(JSON.parse(encoded))))), encoded);
  assert.equal(snapshotDigest(parseCoordinatorSnapshot(encoded)), snapshotDigest(snapshot));
  assert.ok(Object.isFrozen(dirty(snapshot).members[0].checkpoint.record.resources));
  for (const mutate of [
    (wire: Record<string, unknown>) => { wire.extra = true; },
    (wire: Record<string, unknown>) => { wire.engineKey = `sha256:${'b'.repeat(64)}`; },
    (wire: Record<string, unknown>) => { wire.previousDigest = null; },
    (wire: Record<string, unknown>) => { wire.daemonId = '\ud800'; },
    (wire: Record<string, unknown>) => { wire.generation = { kind: 'future' }; },
  ]) {
    const wire = JSON.parse(encoded);
    mutate(wire);
    assert.throws(() => parseCoordinatorSnapshot(JSON.stringify(wire)));
  }
  const exactPayload = COORDINATOR_JOURNAL_LIMITS.framedBytes - COORDINATOR_JOURNAL_LIMITS.nativeHeaderBytes;
  assert.equal(parseCoordinatorSnapshot(encoded + ' '.repeat(exactPayload - Buffer.byteLength(encoded))).sequence, snapshot.sequence);
  assert.throws(() => parseCoordinatorSnapshot(encoded + ' '.repeat(exactPayload - Buffer.byteLength(encoded) + 1)));
  const wire = JSON.parse(encoded);
  wire.generation.members[0].checkpoint.record.resources[0].identity = { kind: 'identified', id: 'forged', fingerprint: digest };
  assert.throws(() => parseCoordinatorSnapshot(JSON.stringify(wire)));
});

test('registration reserves four members and cleanup queue capacity before any arm', () => {
  let snapshot = openWithObserver();
  for (let index = 2; index <= 4; index += 1) snapshot = register(snapshot, index);
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'register', record: reservation(5), slot: 4,
    binding: { profile, backendRevision, configurationIdentityDigest: digest } }).kind, 'rejected');
  for (const member of dirty(snapshot).members) for (const role of ['compute', 'storage', 'export'] as const) {
    snapshot = next(snapshot, { kind: 'queue', memberId: member.memberId, role, action: 'create' });
  }
  const firstId = dirty(snapshot).members[0].memberId;
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'queue', memberId: firstId, role: 'route_observer', action: 'create' }).kind, 'rejected');
  for (const member of dirty(snapshot).members) snapshot = next(snapshot, { kind: 'queue', memberId: member.memberId, role: 'member', action: 'member_retire' });
  assert.equal(dirty(snapshot).queue.length, 16);
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'clean_close' }).kind, 'rejected');
  const wire = JSON.parse(encodeCoordinatorSnapshot(snapshot));
  wire.generation.queue[1].effectSequence = wire.generation.queue[0].effectSequence;
  assert.throws(() => parseCoordinatorSnapshot(JSON.stringify(wire)));
});

test('work settlement requires its original token and cannot replace fresh-process absence proof', () => {
  let snapshot = register(activate(), 1);
  const memberId = record(snapshot).operationId;
  const token = '20000000-0000-4000-8000-000000000001';
  snapshot = next(snapshot, { kind: 'member_state', memberId, state: { kind: 'starting' } });
  snapshot = next(snapshot, { kind: 'work_enter', memberId, scope: 'initialization', token });
  const expected = { kind: 'rejected', reason: 'Only the original entered scope can join' };
  assert.deepEqual(planCoordinatorTransition(snapshot, { kind: 'work_join', memberId, scope: 'initialization',
    token: '20000000-0000-4000-8000-000000000002' }), expected);
  const recovered = next(snapshot, { kind: 'reopen_cleanup' });
  assert.deepEqual(planCoordinatorTransition(recovered, { kind: 'work_join', memberId, scope: 'initialization', token }), expected);
  const settled = next(snapshot, { kind: 'work_join', memberId, scope: 'initialization', token });
  assert.deepEqual(dirty(settled).members[0].work.initialization, { kind: 'joined' });
});

test('admission closure never substitutes for full observer authority before growth or producers enter', () => {
  for (const original of [register(activate(), 1), startedObserver()]) for (const closeFirst of [false, true]) {
    let snapshot = closeFirst ? next(original, { kind: 'close_admission' }) : original;
    const memberId = record(snapshot).operationId;
    snapshot = next(snapshot, { kind: 'member_state', memberId, state: { kind: 'starting' } });
    assert.equal(planCoordinatorTransition(snapshot, { kind: 'queue', memberId, role: 'compute', action: 'create' }).kind, 'rejected');
    assert.equal(planCoordinatorTransition(snapshot, { kind: 'member_state', memberId, state: { kind: 'active' } }).kind, 'rejected');
    for (const scope of ['primary', 'writers'] as const) {
      assert.equal(planCoordinatorTransition(snapshot, { kind: 'work_enter', memberId, scope, token: '20000000-0000-4000-8000-000000000001' }).kind, 'rejected');
    }
  }
  let snapshot = next(openWithObserver(), { kind: 'close_admission' });
  const memberId = record(snapshot).operationId;
  snapshot = next(snapshot, { kind: 'member_state', memberId, state: { kind: 'starting' } });
  snapshot = next(snapshot, { kind: 'queue', memberId, role: 'compute', action: 'create' });
  snapshot = next(snapshot, { kind: 'work_enter', memberId, scope: 'initialization', token: '20000000-0000-4000-8000-000000000002' });
  assert.deepEqual(dirty(snapshot).members[0].work.initialization, { kind: 'owned', token: '20000000-0000-4000-8000-000000000002' });
});

test('a stop decided before a concurrent caller sink failure leaves its member in cleanup', () => {
  let snapshot = next(startedObserver(), { kind: 'member_state', memberId: record(startedObserver()).operationId, state: { kind: 'starting' } });
  const memberId = record(snapshot).operationId;
  snapshot = next(snapshot, { kind: 'caller_sink_failed', memberId });
  const pending = dirty(snapshot).members[0].state;
  assert.deepEqual(pending, { kind: 'cleanup_pending', fault: 'storage' });
  for (const kind of ['stopping', 'retained'] as const) {
    assert.deepEqual(dirty(next(snapshot, { kind: 'member_state', memberId, state: { kind } })).members[0].state, pending, kind);
  }
  for (const kind of ['reserved', 'starting', 'active'] as const) {
    assert.equal(planCoordinatorTransition(snapshot, { kind: 'member_state', memberId, state: { kind } }).kind, 'rejected', kind);
  }
});

test('a registered observer establishes full authority after admission closes without reopening membership', () => {
  let snapshot = next(startedObserver(), { kind: 'close_admission' });
  const vmDigest = `sha256:${'b'.repeat(64)}`;
  snapshot = next(snapshot, { kind: 'full_basis', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest,
    externalEngineDigest: digest, externalVmDigest: vmDigest, exclusionDigest: digest, projectionDigest: digest, atSequence: snapshot.sequence + 1 } });
  const stored = dirty(parseCoordinatorSnapshot(encodeCoordinatorSnapshot(snapshot)));
  assert.equal(stored.state.kind, 'admission_closed');
  assert.equal(stored.basis.kind, 'full');
  if (stored.basis.kind === 'full') assert.equal(stored.basis.vmDigest, vmDigest);
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'register', record: reservation(2), slot: 1,
    binding: { profile, backendRevision, configurationIdentityDigest: digest } }).kind, 'rejected');
  for (const closure of [{ kind: 'fence', fault: 'no_observer' }, { kind: 'reopen_cleanup' }] as const) {
    snapshot = next(snapshot, closure);
    assert.equal(planCoordinatorTransition(snapshot, { kind: 'full_basis', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest,
      externalEngineDigest: digest, externalVmDigest: vmDigest, exclusionDigest: digest, projectionDigest: digest, atSequence: snapshot.sequence + 1 } }).kind, 'rejected');
  }
});

test('deliberate observer quiescence admits only a new observer and preserves irreversible admission closure', () => {
  for (const closeFirst of [false, true]) {
    let snapshot = register(openWithObserver(), 2);
    const memberId = record(snapshot).operationId;
    const waitingId = reservation(2).operationId;
    if (closeFirst) snapshot = next(snapshot, { kind: 'close_admission' });
    snapshot = stopObserver(snapshot, memberId);
    snapshot = next(snapshot, { kind: 'quiesce', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest: digest,
      externalEngineDigest: digest, externalVmDigest: digest, exclusionDigest: digest, projectionDigest: digest, atSequence: snapshot.sequence + 1 } });
    assert.equal(dirty(snapshot).state.kind, closeFirst ? 'admission_closed' : 'quiescent');
    assert.equal(planCoordinatorTransition(snapshot, { kind: 'queue', memberId: waitingId, role: 'compute', action: 'create' }).kind, 'rejected');
    const registration = planCoordinatorTransition(snapshot, { kind: 'register', record: reservation(3), slot: 2,
      binding: { profile, backendRevision, configurationIdentityDigest: digest } });
    if (closeFirst) {
      assert.equal(registration.kind, 'rejected');
    } else {
      snapshot = accepted(registration);
      const newId = reservation(3).operationId;
      assert.equal(planCoordinatorTransition(snapshot, { kind: 'queue', memberId: newId, role: 'compute', action: 'create' }).kind, 'rejected');
      snapshot = createResource(snapshot, 'route_observer', 'replacement-observer', newId);
      assert.equal(dirty(snapshot).state.kind, 'quiescent');
    }
    if (closeFirst) {
      assert.equal(planCoordinatorTransition(snapshot, { kind: 'queue', memberId: waitingId, role: 'route_observer', action: 'create' }).kind, 'rejected');
    } else {
      snapshot = createResource(snapshot, 'route_observer', 'waiting-observer', waitingId);
      snapshot = startObserver(snapshot, waitingId, 'waiting-observer');
      assert.equal(planCoordinatorTransition(snapshot, { kind: 'queue', memberId: waitingId, role: 'compute', action: 'create' }).kind, 'rejected',
        'A replacement observer cannot reuse the full basis captured before it started');
      snapshot = next(snapshot, { kind: 'full_basis', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest: digest,
        externalEngineDigest: digest, externalVmDigest: digest, exclusionDigest: digest, projectionDigest: digest, atSequence: snapshot.sequence + 1 } });
      snapshot = next(snapshot, { kind: 'queue', memberId: waitingId, role: 'compute', action: 'create' });
      assert.equal(dirty(snapshot).queue.at(-1)?.memberId, waitingId);
    }
    snapshot = next(snapshot, { kind: 'fence', fault: 'no_observer' });
    assert.equal(planCoordinatorTransition(snapshot, { kind: 'quiesce', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest: digest,
      externalEngineDigest: digest, externalVmDigest: digest, exclusionDigest: digest, projectionDigest: digest, atSequence: snapshot.sequence + 1 } }).kind, 'rejected');
  }
});

test('an entered observer shutdown cannot renew authority or admit producers from its last running receipt', () => {
  for (const peer of [false, true]) {
    let snapshot = openWithObserver();
    const originalId = record(snapshot).operationId;
    if (peer) {
      snapshot = createResource(register(snapshot, 2), 'route_observer', 'peer-observer', reservation(2).operationId);
      snapshot = startObserver(snapshot, reservation(2).operationId, 'peer-observer');
      snapshot = next(snapshot, { kind: 'full_basis', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest: digest,
        externalEngineDigest: digest, externalVmDigest: digest, exclusionDigest: digest, projectionDigest: digest, atSequence: snapshot.sequence + 1 } });
    }
    snapshot = next(snapshot, { kind: 'member_state', memberId: originalId, state: { kind: 'starting' } });
    snapshot = next(snapshot, { kind: 'queue', memberId: originalId, role: 'route_observer', action: 'control_close' });
    const effectSequence = dirty(snapshot).queue[0].effectSequence;
    snapshot = accepted(planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest }));
    assert.equal(planCoordinatorTransition(snapshot, { kind: 'work_enter', memberId: originalId, scope: 'primary',
      token: '20000000-0000-4000-8000-000000000001' }).kind, peer ? 'commit' : 'rejected');
    assert.equal(planCoordinatorTransition(snapshot, { kind: 'full_basis', basis: { kind: 'full', hostDigest: digest, engineDigest: digest, vmDigest: digest,
      externalEngineDigest: digest, externalVmDigest: digest, exclusionDigest: digest, projectionDigest: digest, atSequence: snapshot.sequence + 1 } }).kind, peer ? 'commit' : 'rejected');
  }
});

test('queued growth loses dispatch authority when priority cleanup removes its last observer', () => {
  let snapshot = next(openWithObserver(), { kind: 'close_admission' });
  const original = record(snapshot);
  const creating = parseSandboxRecoveryRecord({ ...original,
    resources: original.resources.map((resource) => resource.role === 'compute' ? { ...resource, identity: { kind: 'creating' } } : resource) });
  snapshot = next(snapshot, { kind: 'checkpoint', memberId: original.operationId, record: creating, mode: 'caller_persisted' });
  snapshot = next(snapshot, { kind: 'queue', memberId: original.operationId, role: 'compute', action: 'create' });
  const effectSequence = dirty(snapshot).queue[0].effectSequence;
  snapshot = stopObserver(snapshot, original.operationId);
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest }).kind, 'rejected');
  assert.equal(dirty(snapshot).entered, null);
  assert.equal(dirty(snapshot).queue[0].effectSequence, effectSequence);
});

test('growth requested before a peer cleanup keeps its physical slot while later growth still yields to cleanup', () => {
  let base = openWithObserver();
  const originalId = record(base).operationId;
  const peerId = reservation(2).operationId;
  base = createResource(register(base, 2), 'storage', 'peer-storage', peerId);
  const original = record(base, originalId);
  base = next(base, { kind: 'checkpoint', memberId: originalId, mode: 'caller_persisted', record: parseSandboxRecoveryRecord({ ...original,
    resources: original.resources.map((resource) => resource.role === 'compute' ? { ...resource, identity: { kind: 'creating' } } : resource) }) });
  const growth = { kind: 'queue', memberId: originalId, role: 'compute', action: 'create' } as const;
  const cleanup = { kind: 'queue', memberId: peerId, role: 'storage', action: 'delete' } as const;
  const queued = (snapshot: CoordinatorSnapshot, memberId: string): number =>
    dirty(snapshot).queue.find((entry) => entry.memberId === memberId)?.effectSequence ?? assert.fail('Missing queued effect');
  const arm = (snapshot: CoordinatorSnapshot, effectSequence: number) =>
    planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest });

  let snapshot = next(next(base, growth), cleanup);
  snapshot = accepted(arm(snapshot, queued(snapshot, originalId)));
  assert.equal(dirty(snapshot).entered?.memberId, originalId);
  assert.equal(arm(snapshot, queued(snapshot, peerId)).kind, 'rejected');

  snapshot = next(next(base, cleanup), growth);
  assert.equal(arm(snapshot, queued(snapshot, originalId)).kind, 'rejected');
  assert.equal(arm(snapshot, queued(snapshot, peerId)).kind, 'arm');
});

test('settled caller rejection permanently closes growth while exact canonical cleanup can retire and clean-close', () => {
  let snapshot = register(activate(), 1);
  const initial = record(snapshot);
  const creating = parseSandboxRecoveryRecord({ ...initial, phase: 'starting', authority: { kind: 'verified', backendIdentity: daemonId },
    resources: initial.resources.map((resource) => resource.role === 'route_observer' ? { ...resource, identity: { kind: 'creating' } } : resource) });
  snapshot = next(snapshot, { kind: 'checkpoint', memberId: initial.operationId, record: creating, mode: 'caller_persisted' });
  snapshot = next(snapshot, { kind: 'queue', memberId: initial.operationId, role: 'route_observer', action: 'create' });
  const effectSequence = dirty(snapshot).queue[0].effectSequence;
  snapshot = accepted(planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest }));
  snapshot = next(snapshot, { kind: 'caller_sink_failed', memberId: initial.operationId });
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'queue', memberId: initial.operationId, role: 'compute', action: 'create' }).kind, 'rejected');
  snapshot = next(snapshot, { kind: 'settle', effectSequence, outcome: 'not_dispatched', receiptDigest: digest,
    presence: { kind: 'not_entered', provedAtSequence: snapshot.sequence + 1 } });
  const destroyed = parseSandboxRecoveryRecord({ ...creating, phase: 'destroyed' });
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'checkpoint', memberId: initial.operationId, record: destroyed, mode: 'caller_persisted' }).kind, 'rejected');
  snapshot = next(snapshot, { kind: 'checkpoint', memberId: initial.operationId, record: destroyed, mode: 'canonical_cleanup' });
  assert.equal(dirty(snapshot).members[0].checkpoint.callerSink.kind, 'failed');
  snapshot = next(snapshot, { kind: 'retire', memberId: initial.operationId, record: destroyed, mode: 'canonical_cleanup' });
  const wire = JSON.parse(encodeCoordinatorSnapshot(snapshot));
  assert.ok(Array.isArray(wire.generation.retired[0]));
  assert.equal(wire.generation.retired[0].length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(wire.generation.retired[0])) <= 256);
  wire.generation.retired[0].push('extra');
  assert.throws(() => parseCoordinatorSnapshot(JSON.stringify(wire)));
  snapshot = next(snapshot, { kind: 'close_admission' });
  snapshot = next(snapshot, { kind: 'clean_close' });
  assert.equal(snapshot.generation.kind, 'clean');
});

test('fresh cleanup retains abandoned create uncertainty while serial known-ID deletion remains possible', () => {
  let snapshot = createResource(openWithObserver(), 'storage', 'storage-id');
  const original = record(snapshot);
  const creating = parseSandboxRecoveryRecord({ ...original,
    resources: original.resources.map((resource) => resource.role === 'compute' ? { ...resource, identity: { kind: 'creating' } } : resource) });
  snapshot = next(snapshot, { kind: 'checkpoint', memberId: original.operationId, record: creating, mode: 'caller_persisted' });
  snapshot = next(snapshot, { kind: 'queue', memberId: original.operationId, role: 'compute', action: 'create' });
  const abandonedSequence = dirty(snapshot).queue[0].effectSequence;
  snapshot = accepted(planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence: abandonedSequence, expectedBeforeDigest: digest, expectedInputDigest: digest }));
  snapshot = next(snapshot, { kind: 'returned', effectSequence: abandonedSequence, id: 'original-returned-compute' });
  snapshot = next(snapshot, { kind: 'reopen_cleanup' });
  assert.equal(dirty(snapshot).entered, null);
  assert.equal(dirty(snapshot).members[0].roles.find((ledger) => ledger.role === 'compute')?.create.kind, 'uncertain');
  assert.deepEqual(dirty(snapshot).members[0].roles.find((ledger) => ledger.role === 'compute')?.presence,
    { kind: 'possibly_present', createEffect: abandonedSequence, returnedId: 'original-returned-compute' });
  const reopened = next(snapshot, { kind: 'reopen_cleanup' });
  assert.equal(snapshotDigest(reopened), snapshotDigest(snapshot));
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'settle_recovered_work', memberId: original.operationId, proofDigest: digest }).kind, 'rejected');
  const substituted = parseSandboxRecoveryRecord({ ...creating, resources: creating.resources.map((resource) => resource.role === 'compute'
    ? { ...resource, identity: { kind: 'identified', id: 'replacement-compute', fingerprint: digest } } : resource) });
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'resolve_uncertain', memberId: original.operationId, role: 'compute', action: 'create',
    outcome: 'present', receiptDigest: digest, record: substituted,
    presence: { kind: 'present', id: 'replacement-compute', fingerprint: digest, inspectionDigest: digest, runtime: 'created' } }).kind, 'rejected');
  snapshot = next(snapshot, { kind: 'queue', memberId: original.operationId, role: 'storage', action: 'delete' });
  const deletion = dirty(snapshot).queue[0].effectSequence;
  const arm = planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence: deletion, expectedBeforeDigest: digest, expectedInputDigest: digest });
  assert.equal(arm.kind, 'arm');
  if (arm.kind === 'arm') assert.equal(arm.recipe.reference, 'storage-id');
  snapshot = accepted(arm);
  snapshot = next(snapshot, { kind: 'settle', effectSequence: deletion, outcome: 'absent', receiptDigest: digest,
    presence: { kind: 'absent', reference: 'storage-id', fingerprint: digest, inspectedAtSequence: snapshot.sequence + 1, noLateProducerAfter: snapshot.sequence } });
  assert.equal(dirty(snapshot).members[0].roles.find((ledger) => ledger.role === 'compute')?.create.kind, 'uncertain');
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'retire', memberId: original.operationId,
    record: parseSandboxRecoveryRecord({ ...creating, phase: 'destroyed' }), mode: 'canonical_cleanup' }).kind, 'rejected');
  const wire = JSON.parse(encodeCoordinatorSnapshot(snapshot));
  wire.generation.members[0].roles.find((ledger: { role: string }) => ledger.role === 'compute').presence = {
    kind: 'absent', reference: creating.resources.find((resource) => resource.role === 'compute')?.name,
    fingerprint: null, inspectedAtSequence: snapshot.sequence, noLateProducerAfter: snapshot.sequence,
  };
  assert.throws(() => parseCoordinatorSnapshot(JSON.stringify(wire)));
});

test('fencing preserves the entered owner through late results and blocks the next physical dispatch', () => {
  let snapshot = openWithObserver();
  const original = record(snapshot);
  const creating = parseSandboxRecoveryRecord({ ...original,
    resources: original.resources.map((resource) => resource.role === 'compute' ? { ...resource, identity: { kind: 'creating' } } : resource) });
  snapshot = next(snapshot, { kind: 'checkpoint', memberId: original.operationId, record: creating, mode: 'caller_persisted' });
  snapshot = next(snapshot, { kind: 'queue', memberId: original.operationId, role: 'compute', action: 'create' });
  const effectSequence = dirty(snapshot).queue[0].effectSequence;
  snapshot = accepted(planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence, expectedBeforeDigest: digest, expectedInputDigest: digest }));
  snapshot = next(snapshot, { kind: 'fence', fault: 'effect_timeout' });
  snapshot = next(snapshot, { kind: 'queue', memberId: original.operationId, role: 'route_observer', action: 'delete' });
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'arm', effectSequence: dirty(snapshot).queue[0].effectSequence,
    expectedBeforeDigest: digest, expectedInputDigest: digest }).kind, 'rejected');
  assert.equal(dirty(snapshot).entered?.effectSequence, effectSequence);
  snapshot = next(snapshot, { kind: 'returned', effectSequence, id: 'late-compute' });
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'settle', effectSequence, outcome: 'not_dispatched', receiptDigest: digest,
    presence: { kind: 'not_entered', provedAtSequence: snapshot.sequence + 1 } }).kind, 'rejected');
  const identified = parseSandboxRecoveryRecord({ ...creating,
    resources: creating.resources.map((resource) => resource.role === 'compute' ? { ...resource, identity: { kind: 'identified', id: 'late-compute', fingerprint: digest } } : resource) });
  snapshot = next(snapshot, { kind: 'settle', effectSequence, outcome: 'present', receiptDigest: digest, record: identified,
    presence: { kind: 'present', id: 'late-compute', fingerprint: digest, inspectionDigest: digest, runtime: 'created' } });
  assert.equal(dirty(snapshot).entered, null);
  snapshot = next(snapshot, { kind: 'close_admission' });
  assert.equal(dirty(snapshot).state.kind, 'fenced');
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'register', record: reservation(2), slot: 1,
    binding: { profile, backendRevision, configurationIdentityDigest: digest } }).kind, 'rejected');
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'clean_close' }).kind, 'rejected');
});

test('effect and snapshot counters preserve cleanup reserve and refuse precision loss', () => {
  const wire = JSON.parse(encodeCoordinatorSnapshot(register(activate(), 1)));
  wire.sequence = Number.MAX_SAFE_INTEGER - 100;
  wire.generation.nextEffectSequence = Number.MAX_SAFE_INTEGER - COORDINATOR_JOURNAL_LIMITS.cleanupEffectReserve + 1;
  let snapshot = parseCoordinatorSnapshot(JSON.stringify(wire));
  const memberId = record(snapshot).operationId;
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'queue', memberId, role: 'route_observer', action: 'create' }).kind, 'rejected');
  snapshot = next(snapshot, { kind: 'queue', memberId, role: 'member', action: 'member_retire' });
  assert.equal(dirty(snapshot).queue.length, 1);
  const exhausted = JSON.parse(encodeCoordinatorSnapshot(snapshot));
  exhausted.sequence = Number.MAX_SAFE_INTEGER;
  snapshot = parseCoordinatorSnapshot(JSON.stringify(exhausted));
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'fence', fault: 'sequence_exhausted' }).kind, 'rejected');
  exhausted.sequence = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => parseCoordinatorSnapshot(JSON.stringify(exhausted)));
});

test('retirement reservations bound generation churn and preserve compact tombstones at the lifetime limit', () => {
  let snapshot = activate();
  for (let index = 1; index <= 256; index += 1) {
    snapshot = register(snapshot, index, 0);
    const original = record(snapshot);
    const destroyed = parseSandboxRecoveryRecord({ ...original, phase: 'destroyed', authority: { kind: 'verified', backendIdentity: daemonId } });
    snapshot = next(snapshot, { kind: 'retire', memberId: original.operationId, record: destroyed, mode: 'canonical_cleanup' });
  }
  assert.equal(dirty(snapshot).retired.length, 256);
  assert.equal(planCoordinatorTransition(snapshot, { kind: 'register', record: reservation(257), slot: 0,
    binding: { profile, backendRevision, configurationIdentityDigest: digest } }).kind, 'rejected');
  assert.equal(parseCoordinatorSnapshot(encodeCoordinatorSnapshot(snapshot)).generation.kind, 'dirty');
  snapshot = next(snapshot, { kind: 'close_admission' });
  assert.equal(next(snapshot, { kind: 'clean_close' }).generation.kind, 'clean');
});
