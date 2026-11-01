import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SandboxCleanupError, SandboxStartError } from '@agen-ai/sandbox';
import type { SandboxRecoveryRecord } from '@agen-ai/sandbox';
import { createCoordinatedDockerSandboxBackend, DockerDesktopCoordinatorError } from '../src/index.js';
import type { DockerDesktopCoordinator, DockerDesktopCoordinatorMemberConfiguration } from '../src/index.js';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';
import { gate, sandboxRequest } from './fixtures/engine.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const architecture = Object.getOwnPropertyDescriptor(process, 'arch');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
test.after(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  if (architecture) Object.defineProperty(process, 'arch', architecture);
});

function failure(owner: DockerDesktopCoordinator, expected: unknown) {
  return (cause: unknown) => {
    assert(cause instanceof DockerDesktopCoordinatorError);
    assert.equal(cause.owner, owner); assert.deepEqual(cause.failure, expected);
    return true;
  };
}

type Fixture = Awaited<ReturnType<typeof desktopCoordinatorLifecycleFixture>>;

function memberConfiguration(fixture: Fixture): DockerDesktopCoordinatorMemberConfiguration {
  const options = fixture.options(); assert(options.egress);
  if (options.egress.routeAuthority.kind !== 'local_docker_desktop') assert.fail('Expected an original Desktop route authority.');
  return { ...options, profile: 'desktop-apple-virtualization-native-arm64',
    egress: { ...options.egress, routeAuthority: options.egress.routeAuthority,
      control: { heartbeatMs: 1000, leaseTimeoutMs: 60_000 } } };
}

async function closeFixture(owner: DockerDesktopCoordinator, fixture: Fixture): Promise<void> {
  await fixture.releaseCommit();
  await owner.close({ timeoutMs: 1000 }).catch(() => {});
  if (owner.state.kind !== 'closed') {
    try { await fixture.terminateHolder(); }
    catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) throw cause; }
  }
  await fixture.close();
}

test('cleanup opening is inert for invalid input and clean absence closes without executing host or VM observers',
  { timeout: 15_000 }, async () => {
    const fixture = await desktopCoordinatorLifecycleFixture();
    const owner = fixture.createOwner();
    try {
      let getters = 0;
      for (const input of [{ expectedGeneration: 'invalid' }, { unexpected: true },
        { get expectedGeneration() { getters += 1; return 'invalid'; } }]) {
        await assert.rejects(Reflect.apply(owner.reopenCleanup, owner, [input]), failure(owner, { kind: 'invalid_input' }));
      }
      assert.equal(getters, 0);
      const cancelled = new AbortController(); cancelled.abort();
      await assert.rejects(owner.reopenCleanup(undefined, { signal: cancelled.signal }),
        failure(owner, { kind: 'interrupted', by: 'signal', effect: 'not_entered' }));
      assert.deepEqual(await fixture.events(), []); assert.deepEqual(fixture.requests, []);
      assert.deepEqual(await owner.reopenCleanup(), { kind: 'absent' });
      assert.deepEqual(owner.state, { kind: 'closed', result: 'clean', generation: null });
      await assert.rejects(readFile(join(fixture.spillDirectory, 'host-calls.jsonl')), { code: 'ENOENT' });
      assert.deepEqual(fixture.commands, []); assert.deepEqual(fixture.effects, []);
      await assert.rejects(owner.reopenCleanup(), failure(owner, { kind: 'invalid_state' }));
      await assert.rejects(owner.activate(), failure(owner, { kind: 'invalid_state' }));
      await owner.close();
      assert.deepEqual(owner.state, { kind: 'closed', result: 'clean', generation: null });
    } finally { await closeFixture(owner, fixture); }
  });

test('fresh cleanup validates every original generation binding before any canonical mutation', { timeout: 30_000 }, async () => {
  const fixture = await desktopCoordinatorLifecycleFixture();
  const original = fixture.createOwner();
  const capability = await original.activate();
  const snapshot = await fixture.current();
  assert(snapshot && typeof snapshot === 'object');
  await fixture.terminateHolder();
  const text = JSON.stringify(snapshot);
  const value: unknown = JSON.parse(text);
  assert(value && typeof value === 'object' && 'generation' in value);
  const beforeEffects = fixture.effects.length;
  const hostCalls = (await fixture.observedHostCalls()).length;
  const alternate = `sha256:${'9'.repeat(64)}`;
  try {
    for (const [field, scope] of [['endpointBindingDigest', 'endpoint'], ['coordinationPolicyDigest', 'configuration'],
      ['hostPreparationDigest', 'configuration'], ['engineBindingDigest', 'configuration'], ['nativeAssetDigest', 'configuration']] as const) {
      const changed: unknown = JSON.parse(text);
      assert(changed && typeof changed === 'object' && 'generation' in changed);
      assert(changed.generation && typeof changed.generation === 'object' && 'identity' in changed.generation);
      assert(changed.generation.identity && typeof changed.generation.identity === 'object');
      Reflect.set(changed.generation.identity, field, alternate);
      const bytes = JSON.stringify(changed); await fixture.replaceCanonical(bytes);
      const owner = fixture.createOwner();
      await assert.rejects(owner.reopenCleanup({ expectedGeneration: capability.generation }),
        failure(owner, { kind: 'identity_conflict', scope }));
      assert.equal(JSON.stringify(await fixture.current()), bytes);
      await owner.close();
    }
    await fixture.replaceCanonical(text);
    const changedClaim: unknown = JSON.parse(text);
    assert(changedClaim && typeof changedClaim === 'object' && 'generation' in changedClaim);
    assert(changedClaim.generation && typeof changedClaim.generation === 'object' && 'basis' in changedClaim.generation);
    assert(changedClaim.generation.basis && typeof changedClaim.generation.basis === 'object');
    Reflect.set(changedClaim.generation.basis, 'exclusionDigest', alternate);
    const claimBytes = JSON.stringify(changedClaim); await fixture.replaceCanonical(claimBytes);
    const differentClaim = fixture.createOwner();
    await assert.rejects(differentClaim.reopenCleanup({ expectedGeneration: capability.generation }),
      failure(differentClaim, { kind: 'identity_conflict', scope: 'generation' }));
    assert.equal(JSON.stringify(await fixture.current()), claimBytes);
    await differentClaim.close();
    await fixture.replaceCanonical(text);
    const wrong = fixture.createOwner();
    await assert.rejects(wrong.reopenCleanup({ expectedGeneration: '4047283c-2b78-4f34-9807-13800728f192' }),
      failure(wrong, { kind: 'identity_conflict', scope: 'generation' }));
    await wrong.close();
    const corrupt = fixture.createOwner(); await fixture.replaceCanonical('{');
    await assert.rejects(corrupt.reopenCleanup(), failure(corrupt, { kind: 'journal_invalid', reason: 'corrupt' }));
    await corrupt.close();
    assert.equal(fixture.effects.length, beforeEffects);
    assert.equal((await fixture.observedHostCalls()).length, hostCalls);
    assert.deepEqual(fixture.commands, []);
  } finally {
    await fixture.replaceCanonical(text);
    const cleanup = fixture.createOwner();
    await cleanup.reopenCleanup({ expectedGeneration: capability.generation });
    await closeFixture(cleanup, fixture);
  }
});

for (const publication of ['healthy', 'failed', 'persistent_failure'] as const) {
  test(`fresh cleanup removes the exact original without route observers or replay through ${publication} canonical publication`,
    { timeout: 25_000 }, async () => {
      const fixture = await desktopCoordinatorLifecycleFixture();
      const original = fixture.createOwner();
      const capability = await original.activate();
      const configuration = memberConfiguration(fixture);
      const entered = gate(); const release = gate();
      const backend = createCoordinatedDockerSandboxBackend({ ...configuration, coordinator: capability });
      let acquired: SandboxRecoveryRecord | undefined;
      const reservation = backend.reserve(sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] }),
        { kind: 'persisted', async persist(record) {
          if (record.phase === 'starting' && record.resources.some((resource) => resource.role === 'route_observer' && resource.identity.kind === 'identified')) {
            acquired = record; entered.resolve(); await release.promise;
          }
        } });
      const startup = reservation.start(); void startup.catch(() => {});
      const cleanup = fixture.createOwner();
      try {
        await Promise.race([entered.promise, startup.then(() => assert.fail('The original identity checkpoint did not block.'))]);
        assert(acquired);
        await fixture.terminateHolder(); release.resolve();
        await assert.rejects(startup, SandboxStartError);
        await reservation.stop().catch(() => {});
        const id = acquired.resources.find((resource) => resource.role === 'route_observer')?.identity;
        assert(id?.kind === 'identified'); assert.equal(fixture.containers.has(id.id), true);
        const hostCalls = (await fixture.observedHostCalls()).length;
        const effects = fixture.effects.length;
        await writeFile(fixture.descriptor.hostObserver.executable.path, 'the original host observer is unavailable');
        const opened = await cleanup.reopenCleanup({ expectedGeneration: capability.generation });
        assert.equal(opened.kind, 'opened');
        if (opened.kind !== 'opened') assert.fail('Dirty original membership must retain cleanup authority.');
        const recovery = opened.recovery;
        assert.equal(recovery.generation, capability.generation);
        assert.equal(recovery.members.length, 1);
        assert.equal(Object.isFrozen(recovery.members), true);
        assert.equal(Object.isFrozen(recovery.members[0]), true);
        const record = recovery.members[0];
        const copied = { ...recovery };
        assert.throws(() => copied.reconcile({ configuration, record }), /original recovery capability/u);
        await assert.rejects(Reflect.apply(recovery.reconcile, recovery, [{ configuration, record, extra: true }]), TypeError);
        const result = await recovery.reconcile({ configuration, record });
        assert.equal(result.kind, 'matched');
        if (result.kind !== 'matched') assert.fail('The exact original armed container must yield a cleanup owner.');
        if (publication !== 'healthy') {
          await fixture.failDiscard(publication === 'persistent_failure');
          await fixture.failNextCommit();
          await assert.rejects(result.owner.destroy(), (cause: unknown) => {
            assert(cause instanceof SandboxCleanupError);
            assert.equal(cause.owner, result.owner);
            return true;
          });
          assert.equal(fixture.containers.size, 0);
          assert.equal(recovery.members.length, 1);
          if (publication === 'persistent_failure') {
            await assert.rejects(result.owner.destroy(), SandboxCleanupError);
            await assert.rejects(cleanup.close(), (cause: unknown) => cause instanceof DockerDesktopCoordinatorError && cause.owner === cleanup);
            assert.equal(recovery.members.length, 1);
            assert.equal(fixture.containers.size, 0);
            assert.equal((await fixture.events()).filter((entry) => entry.command === 'CLOSE').length, 0);
            await fixture.failDiscard(false);
          }
        }
        await result.owner.destroy(); await result.owner.destroy();
        assert.equal(result.owner.recoveryRecord.phase, 'destroyed');
        assert.equal(fixture.containers.size, 0);
        assert.deepEqual(recovery.members, []);
        assert.equal((await recovery.reconcile({ configuration, record })).kind, 'conflict');
        assert.equal((await fixture.observedHostCalls()).length, hostCalls);
        assert.deepEqual(fixture.commands, []);
        assert.deepEqual(fixture.effects.slice(effects).map((effect) => [effect.method, effect.path]), [['DELETE', `/v1.52/containers/${id.id}`]]);
        await cleanup.close();
        const settled = fixture.createOwner();
        assert.deepEqual(await settled.reopenCleanup({ expectedGeneration: capability.generation }), { kind: 'absent' });
        assert.deepEqual(settled.state, { kind: 'closed', result: 'clean', generation: capability.generation });
      } finally { release.resolve(); await startup.catch(() => {}); await closeFixture(cleanup, fixture); }
    });
}

for (const boundary of ['interruption', 'publication_failure'] as const) {
  test(`cleanup opening retains the same retry owner through ${boundary} without restoring live admission`, { timeout: 20_000 }, async () => {
    const fixture = await desktopCoordinatorLifecycleFixture(boundary === 'interruption' ? 'paused_generation' : 'normal');
    await fixture.releaseCommit();
    const original = fixture.createOwner();
    const capability = await original.activate();
    await fixture.terminateHolder();
    const cleanup = fixture.createOwner();
    try {
      if (boundary === 'interruption') {
        await fixture.pauseCommit();
        const controller = new AbortController();
        const opening = cleanup.reopenCleanup({ expectedGeneration: capability.generation }, { signal: controller.signal }); void opening.catch(() => {});
        await fixture.waitFor('COMMIT_WAITING', 2); controller.abort();
        await assert.rejects(opening, failure(cleanup, { kind: 'interrupted', by: 'signal', effect: 'owned' }));
        await fixture.releaseCommit(); await cleanup.settle();
      } else {
        await fixture.failNextCommit();
        await assert.rejects(cleanup.reopenCleanup({ expectedGeneration: capability.generation }),
          failure(cleanup, { kind: 'persistence_failed', boundary: 'settlement' }));
        assert.equal(await fixture.hasTemp(), true);
      }
      const retried = await cleanup.reopenCleanup({ expectedGeneration: capability.generation });
      assert.equal(retried.kind, 'opened');
      if (retried.kind !== 'opened') assert.fail('The original dirty generation requires a retained recovery handle.');
      assert.equal(retried.recovery.generation, capability.generation);
      assert.deepEqual(retried.recovery.members, []);
      assert.equal(await fixture.hasTemp(), false);
      await assert.rejects(cleanup.activate(), (cause: unknown) => cause instanceof DockerDesktopCoordinatorError && cause.owner === cleanup);
      await cleanup.close();
      assert.deepEqual(cleanup.state, { kind: 'closed', result: 'clean', generation: capability.generation });
    } finally { await closeFixture(cleanup, fixture); }
  });
}

test('the original public failed-start reservation retries destruction after a failed retirement acknowledgement without replay',
  { timeout: 25_000 }, async () => {
    const fixture = await desktopCoordinatorLifecycleFixture();
    const coordinator = fixture.createOwner();
    const capability = await coordinator.activate();
    const backend = createCoordinatedDockerSandboxBackend({ ...memberConfiguration(fixture), coordinator: capability });
    const reservation = backend.reserve(sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] }),
      { kind: 'persisted', async persist(record) {
        if (record.resources.some((resource) => resource.role === 'route_observer' && resource.identity.kind === 'identified')) {
          throw new Error('The original caller checkpoint failed after acquisition.');
        }
      } });
    try {
      await assert.rejects(reservation.start(), SandboxStartError);
      const original = reservation.recoveryRecord;
      assert.equal(original.resources.find((resource) => resource.role === 'route_observer')?.identity.kind, 'identified');
      await fixture.failRetirementAfterRename(original.operationId);
      await assert.rejects(reservation.destroy(), (cause: unknown) => {
        assert(cause instanceof SandboxCleanupError);
        assert.equal(cause.owner, reservation);
        return true;
      });
      const canonical = await fixture.current();
      assert(canonical && typeof canonical === 'object' && 'generation' in canonical);
      assert(canonical.generation && typeof canonical.generation === 'object' && 'members' in canonical.generation);
      assert.deepEqual(canonical.generation.members, []);
      assert.equal(fixture.containers.size, 0); assert.equal(fixture.networks.size, 0); assert.equal(fixture.volumes.size, 0);
      const effects = fixture.effects.map(({ method, path }) => [method, path]);
      await fixture.failDiscard(true); await fixture.failNextCommit();
      await assert.rejects(reservation.destroy(), SandboxCleanupError);
      assert.deepEqual(fixture.effects.map(({ method, path }) => [method, path]), effects);
      await fixture.failDiscard(false);
      await reservation.destroy();
      assert.equal(reservation.state.kind, 'destroyed');
      assert.deepEqual(fixture.effects.map(({ method, path }) => [method, path]), effects);
      await coordinator.close();
      await reservation.stop(); await reservation.destroy();
      assert.deepEqual(coordinator.state, { kind: 'closed', result: 'clean', generation: capability.generation });
      assert.deepEqual(fixture.effects.map(({ method, path }) => [method, path]), effects);
    } finally { await reservation.destroy().catch(() => {}); await closeFixture(coordinator, fixture); }
  });
