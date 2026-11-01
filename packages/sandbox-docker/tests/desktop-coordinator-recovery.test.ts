import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { CoordinatorEvent } from '../src/network/desktop/coordinator/journal/plans.js';
import { snapshotDigest } from '../src/network/desktop/coordinator/journal/schema.js';
import { desktopCoordinatorRecoveryFixture, returnedId } from './fixtures/desktopCoordinatorRecovery.js';

const digest = `sha256:${'a'.repeat(64)}`;

test('fresh cleanup settles acknowledged returned-ID absence from the exact canonical creating record',
  { timeout: 15_000 }, async () => {
    const owned = await desktopCoordinatorRecoveryFixture('returned_absent');
    try {
      const original = owned.recovery.members[0];
      const result = await owned.recovery.reconcile(owned.config, original);
      assert.equal(result.kind, 'matched');
      if (result.kind !== 'matched') assert.fail('Acknowledged original absence must retain an exact cleanup owner.');
      await result.owner.destroy();
      assert.equal(result.owner.recoveryRecord.phase, 'destroyed');
      assert.equal(result.owner.recoveryRecord.resources.find((resource) => resource.role === 'route_observer')?.identity.kind, 'creating');
      assert.equal(original.resources.find((resource) => resource.role === 'route_observer')?.identity.kind, 'creating');
      const snapshot = owned.snapshot(); assert(snapshot.generation.kind === 'dirty');
      assert.deepEqual(snapshot.generation.members, []);
      assert.equal(snapshot.generation.retired.length, 1);
      assert.deepEqual(owned.fixture.effects, []);
      const repeated = await owned.recovery.reconcile(owned.config, original);
      assert.equal(repeated.kind, 'conflict');
      await result.owner.destroy();
      assert.equal(owned.snapshot().generation.kind, 'dirty');
    } finally { await owned.close(); }
  });

test('fresh cleanup rejects every noncanonical external continuation before mutation and keeps the original usable', { timeout: 15_000 }, async () => {
  const owned = await desktopCoordinatorRecoveryFixture('returned_absent');
  try {
    const original = owned.recovery.members[0];
    const before = snapshotDigest(owned.snapshot());
    const continuations = [
      { ...original, phase: 'stopped' },
      { ...original, phase: 'reserved' },
      ...[returnedId, 'c'.repeat(64)].map((id) => ({ ...original,
        resources: original.resources.map((resource) => resource.role === 'route_observer'
          ? { ...resource, identity: { kind: 'identified', id, fingerprint: digest } } : resource) })),
    ];
    for (const continuation of continuations) {
      const supplied = parseSandboxRecoveryRecord(continuation);
      assert.deepEqual(await owned.recovery.reconcile(owned.config, supplied), { kind: 'conflict',
        reason: 'Cleanup requires the exact current canonical member record.' });
      assert.equal(snapshotDigest(owned.snapshot()), before);
      assert.deepEqual(owned.fixture.effects, []);
    }
    const actual = await owned.recovery.reconcile(owned.config, original);
    assert.equal(actual.kind, 'matched');
    if (actual.kind !== 'matched') assert.fail('The exact canonical record must remain usable after conflict.');
    await actual.owner.destroy();
    assert.equal(actual.owner.recoveryRecord.phase, 'destroyed');
    assert.deepEqual(owned.recovery.members, []);
  } finally { await owned.close(); }
});

test('an absent create without a returned ID retains dirty ownership and cannot import an uncorroborated ahead identity', { timeout: 15_000 }, async () => {
  const owned = await desktopCoordinatorRecoveryFixture('unknown_absent');
  try {
    const original = owned.recovery.members[0];
    const ahead = parseSandboxRecoveryRecord({ ...original, resources: original.resources.map((resource) => resource.role === 'route_observer'
      ? { ...resource, identity: { kind: 'identified', id: returnedId, fingerprint: digest } } : resource) });
    assert.deepEqual(await owned.recovery.reconcile(owned.config, ahead), { kind: 'conflict',
      reason: 'Cleanup requires the exact current canonical member record.' });
    const result = await owned.recovery.reconcile(owned.config, original);
    assert.equal(result.kind, 'uncertain');
    if (result.kind !== 'uncertain') assert.fail('Unknown original dispatch must expose its retained cleanup owner.');
    await assert.rejects(result.owner.destroy(), { name: 'AggregateError', message: 'Recovered destruction retains original container or late-create ownership.' });
    const snapshot = owned.snapshot(); assert(snapshot.generation.kind === 'dirty');
    const observer = snapshot.generation.members[0].roles.find((role) => role.role === 'route_observer');
    assert.equal(observer?.create.kind, 'uncertain');
    assert.deepEqual(observer?.presence, { kind: 'possibly_present', createEffect: 1, returnedId: null });
    assert.equal(result.owner.recoveryRecord.resources.find((resource) => resource.role === 'route_observer')?.identity.kind, 'creating');
    assert.deepEqual(owned.fixture.effects, []);
    assert.equal(owned.recovery.members.length, 1);
  } finally { await owned.close(); }
});

for (const cut of ['not_dispatched', 'lost_create_ack', 'lost_start_ack', 'lost_delete_ack'] as const) {
  test(`fresh cleanup resolves ${cut} from canonical authority without repeating the original effect`, { timeout: 15_000 }, async () => {
    const owned = await desktopCoordinatorRecoveryFixture(cut);
    try {
      const original = owned.recovery.members[0];
      const before = owned.fixture.effects.map(({ method, path }) => [method, path]);
      const ids = [...owned.fixture.containers.keys()];
      if (cut === 'lost_start_ack') assert.deepEqual([...owned.fixture.containers.values()].map((container) => container.State), [{ Running: true, Status: 'running' }]);
      const result = await owned.recovery.reconcile(owned.config, original);
      assert.equal(result.kind, 'matched');
      if (result.kind !== 'matched') assert.fail('Original exact cleanup must remain available.');
      const repeated = await owned.recovery.reconcile(owned.config, original);
      assert.equal(repeated.kind, 'matched');
      if (repeated.kind !== 'matched') assert.fail('The canonical original must select its same cleanup owner.');
      assert.equal(repeated.owner, result.owner);
      await result.owner.destroy();
      assert.equal(result.owner.recoveryRecord.phase, 'destroyed');
      assert.equal(owned.fixture.containers.size, 0);
      assert.deepEqual(owned.recovery.members, []);
      const snapshot = owned.snapshot(); assert(snapshot.generation.kind === 'dirty');
      assert.equal(snapshot.generation.retired.length, 1);
      const cleanup = cut === 'lost_create_ack' || cut === 'lost_start_ack' ? [['DELETE', `/v1.52/containers/${ids[0]}`]] : [];
      assert.deepEqual(owned.fixture.effects.map(({ method, path }) => [method, path]), [...before, ...cleanup]);
      await result.owner.stop(); await result.owner.destroy();
      assert.deepEqual(owned.fixture.effects.map(({ method, path }) => [method, path]), [...before, ...cleanup]);
      assert.deepEqual(owned.fixture.commands, []);
      assert.equal((await owned.recovery.reconcile(owned.config, original)).kind, 'conflict');
    } finally { await owned.close(); }
  });
}

test('unknown abandoned HTTP create remains dirty through repeated absence and cleans its late exact original without replay', { timeout: 15_000 }, async () => {
  const owned = await desktopCoordinatorRecoveryFixture('late_create');
  try {
    const original = owned.recovery.members[0];
    const result = await owned.recovery.reconcile(owned.config, original);
    assert.equal(result.kind, 'uncertain');
    if (result.kind !== 'uncertain') assert.fail('The original unacknowledged dispatch must retain cleanup ownership.');
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(result.owner.destroy(), { name: 'AggregateError' });
      assert.equal(owned.recovery.members.length, 1);
      const snapshot = owned.snapshot(); assert(snapshot.generation.kind === 'dirty');
      assert.equal(snapshot.generation.retired.length, 0);
      assert.equal(snapshot.generation.members[0].allocation.kind, 'reserved');
      assert.deepEqual(owned.fixture.effects.map(({ method, path }) => [method, path]), [['POST', '/v1.52/containers/create']]);
    }
    await owned.releaseLateCreate();
    const id = [...owned.fixture.containers.keys()][0]; assert.equal(typeof id, 'string');
    await result.owner.destroy();
    assert.equal(result.owner.recoveryRecord.phase, 'destroyed');
    assert.equal(owned.fixture.containers.size, 0);
    assert.deepEqual(owned.recovery.members, []);
    assert.deepEqual(owned.fixture.effects.map(({ method, path }) => [method, path]),
      [['POST', '/v1.52/containers/create'], ['DELETE', `/v1.52/containers/${id}`]]);
  } finally { await owned.close(); }
});

const publicationCuts = [
  { name: 'acquired-create continuation', cut: 'lost_create_ack', matches: (event: CoordinatorEvent) => event.kind === 'resolve_uncertain' && event.action === 'create' },
  { name: 'delete intent', cut: 'created', matches: (event: CoordinatorEvent) => event.kind === 'queue' && event.action === 'delete' },
  { name: 'delete arm', cut: 'created', matches: (event: CoordinatorEvent) => event.kind === 'arm' },
  { name: 'delete settlement', cut: 'created', matches: (event: CoordinatorEvent) => event.kind === 'settle' && event.outcome === 'absent' },
  { name: 'stopped checkpoint', cut: 'created', matches: (event: CoordinatorEvent) => event.kind === 'checkpoint' && event.record.phase === 'stopped' },
  { name: 'retirement', cut: 'created', matches: (event: CoordinatorEvent) => event.kind === 'retire' },
] as const;

for (const boundary of publicationCuts) {
  for (const afterCommit of boundary.name === 'retirement' ? [false] : [false, true]) {
    test(`canonical ${boundary.name} ${afterCommit ? 'acknowledgement' : 'write'} failure preserves exact physical cleanup and the original retry owner`, { timeout: 15_000 }, async () => {
      const owned = await desktopCoordinatorRecoveryFixture(boundary.cut);
      try {
        const result = await owned.recovery.reconcile(owned.config, owned.recovery.members[0]);
        assert.equal(result.kind, 'matched');
        if (result.kind !== 'matched') assert.fail('The original resource must have one cleanup owner.');
        const id = [...owned.fixture.containers.keys()][0]; assert.equal(typeof id, 'string');
        const before = owned.fixture.effects.length;
        owned.failPublication(boundary.matches, afterCommit);
        await assert.rejects(result.owner.destroy());
        assert.equal(owned.fixture.containers.size, 0, 'Exact already-acquired cleanup must remain possible without a canonical acknowledgement.');
        assert.equal(owned.recovery.members.length, 1, 'Physical absence must not manufacture canonical retirement.');
        assert.deepEqual(owned.fixture.effects.slice(before).map(({ method, path }) => [method, path]), [['DELETE', `/v1.52/containers/${id}`]]);
        owned.clearPublicationFailure();
        await result.owner.destroy(); await result.owner.destroy();
        assert.equal(result.owner.recoveryRecord.phase, 'destroyed');
        assert.deepEqual(owned.recovery.members, []);
        assert.deepEqual(owned.fixture.effects.slice(before).map(({ method, path }) => [method, path]), [['DELETE', `/v1.52/containers/${id}`]]);
      } finally { await owned.close(); }
    });
  }
}

test('lost retirement acknowledgement retries the exact canonical tombstone without repeating cleanup', { timeout: 15_000 }, async () => {
  const owned = await desktopCoordinatorRecoveryFixture('created');
  try {
    const result = await owned.recovery.reconcile(owned.config, owned.recovery.members[0]);
    assert.equal(result.kind, 'matched');
    if (result.kind !== 'matched') assert.fail('The original resource must have one cleanup owner.');
    owned.failPublication((event) => event.kind === 'retire', true);
    await assert.rejects(result.owner.destroy(), owned.publicationError);
    assert.equal(owned.fixture.containers.size, 0);
    assert.deepEqual(owned.recovery.members, []);
    const effects = owned.fixture.effects.map(({ method, path }) => [method, path]);
    await assert.rejects(result.owner.destroy(), owned.publicationError);
    assert.deepEqual(owned.fixture.effects.map(({ method, path }) => [method, path]), effects);
    owned.clearPublicationFailure();
    await result.owner.destroy(); await result.owner.stop(); await result.owner.destroy();
    assert.equal(result.owner.recoveryRecord.phase, 'destroyed');
    assert.deepEqual(owned.fixture.effects.map(({ method, path }) => [method, path]), effects);
    const snapshot = owned.snapshot(); assert(snapshot.generation.kind === 'dirty');
    assert.equal(snapshot.generation.retired.length, 1);
  } finally { await owned.close(); }
});

test('canonical non-dispatch never grants deletion authority over a later same-name resource', { timeout: 15_000 }, async () => {
  const owned = await desktopCoordinatorRecoveryFixture('not_dispatched');
  try {
    const result = await owned.recovery.reconcile(owned.config, owned.recovery.members[0]);
    assert.equal(result.kind, 'matched');
    if (result.kind !== 'matched') assert.fail('The exact original non-dispatch proof must yield its cleanup owner.');
    await owned.occupyOriginalName();
    const before = owned.fixture.effects.length;
    await assert.rejects(result.owner.destroy(), { name: 'AggregateError' });
    assert.equal(owned.fixture.containers.size, 1, 'Non-dispatch proof must prevent adoption even when original labels are copied.');
    assert.equal(owned.recovery.members.length, 1);
    assert.deepEqual(owned.fixture.effects.slice(before), []);
    owned.fixture.containers.clear();
    await result.owner.destroy();
    assert.equal(result.owner.recoveryRecord.phase, 'destroyed');
    assert.deepEqual(owned.recovery.members, []);
  } finally { await owned.close(); }
});
