import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { inspect } from 'node:util';
import type { SandboxDriverReady } from '@agen-ai/sandbox/backend';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi } from '../src/resources/api.js';
import { DockerResourceOwner } from '../src/resources/owner.js';
import { parseCoordinatedDockerConfig } from '../src/policy/config.js';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';
import { desktopVmDocument } from './fixtures/desktopObservation.js';
import { gate, sandboxRequest } from './fixtures/engine.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
test.after(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArchitecture) Object.defineProperty(process, 'arch', originalArchitecture);
});

// Source resource owners acquire real control attachments over the independent Unix daemon.
// Storage checkpoints hold startup before any bridge or primary exists; no native claim is made.
interface ObserverOwner {
  readonly owner: DockerResourceOwner;
  readonly startup: Promise<SandboxDriverReady>;
  readonly release: PromiseWithResolvers<void>;
  readonly failed: PromiseWithResolvers<Error>;
  readonly failures: Error[];
  readonly observerId: string;
  readonly socket: Duplex;
}

type ObserverFixture = Awaited<ReturnType<typeof desktopCoordinatorLifecycleFixture>>;
interface ObserverCleanupFailure {
  readonly step: 'destroy' | 'coordinator' | 'holder' | 'fixture';
  readonly cause: unknown;
}
interface ObserverCleanup {
  readonly failures: readonly ObserverCleanupFailure[];
  readonly startups: readonly PromiseSettledResult<SandboxDriverReady>[];
}

function assertCleanObserverFixture(cleanup: ObserverCleanup) {
  if (cleanup.failures.length) throw new AggregateError(cleanup.failures.map(({ step, cause }) =>
    new Error(`Observer fixture ${step} cleanup failed.`, { cause })), 'Observer fixture cleanup failed.');
  for (const startup of cleanup.startups) assert.equal(startup.status, 'rejected',
    'Closing the fixture must join its deliberately held startup.');
}

async function observerOwners(context: TestContext, count = 2,
  prepared?: ObserverFixture,
  verifyCleanup: (cleanup: ObserverCleanup) => void | Promise<void> = assertCleanObserverFixture) {
  const fixture = prepared ?? await desktopCoordinatorLifecycleFixture();
  const pending: Array<Pick<ObserverOwner, 'owner' | 'startup' | 'release'>> = [];
  let coordinator: ReturnType<ObserverFixture['createOwner']> | undefined = undefined;
  context.after(async () => {
    for (const socket of fixture.sockets.values()) { socket.uncork(); socket.resume(); }
    for (const member of pending) member.release.resolve();
    const failures: ObserverCleanupFailure[] = [];
    async function attempt(step: ObserverCleanupFailure['step'], dispose: () => Promise<unknown>) {
      try { await dispose(); }
      catch (cause) { failures.push({ step, cause }); }
    }
    await Promise.all(pending.map((member) => attempt('destroy', () => member.owner.destroy())));
    const startups = await Promise.allSettled(pending.map((member) => member.startup));
    if (coordinator) {
      const original = coordinator;
      await attempt('coordinator', () => original.close({ timeoutMs: 100 }));
      if (original.state.kind !== 'closed') await attempt('holder', () => fixture.terminateHolder());
    }
    await attempt('fixture', () => fixture.close());
    const cleanup = { failures, startups };
    // Startup is deliberately held; cancellation and retained ownership remain in the TAP diagnostics.
    context.diagnostic(inspect(cleanup, { depth: null }));
    await verifyCleanup(cleanup);
  });
  coordinator = fixture.createOwner();
  const capability = await coordinator.activate();
  const options = fixture.options(); assert(options.egress);
  const config = parseCoordinatedDockerConfig({ ...options, coordinator: capability,
    egress: { ...options.egress, control: { heartbeatMs: 1000, leaseTimeoutMs: 60_000 } } });
  const api = new DockerApi(new DockerEngine(fixture.endpoint.slice(7)), 2000);
  const request = sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] });
  const owned: ObserverOwner[] = [];
  for (let index = 0; index < count; index += 1) {
    const reached = gate(); const release = gate(); const failed = gate<Error>();
    const failures: Error[] = [];
    const owner = new DockerResourceOwner(api, config, request);
    const startup = Promise.resolve().then(() => owner.start({
      async checkpoint(record) {
        if (record.resources.some((resource) => resource.role === 'storage' && resource.identity.kind === 'creating')) {
          reached.resolve(); await release.promise;
        }
      },
      onInfrastructureFailure(error) { failures.push(error); failed.resolve(error); },
    }));
    pending.push({ owner, startup, release });
    void startup.catch(() => {});
    await Promise.race([reached.promise, startup.then(() => assert.fail('Startup must reach the original storage checkpoint.'))]);
    const observer = owner.recoveryRecord.resources.find((resource) => resource.role === 'route_observer');
    assert(observer?.identity.kind === 'identified');
    const socket = fixture.sockets.get(observer.identity.id); assert(socket);
    owned.push({ owner, startup, release, failed, failures, observerId: observer.identity.id, socket });
  }
  await coordinator.settle();
  return { fixture, coordinator, owned };
}

test('a failed observer joins its lost attachment then deletes only itself after an independent peer proof', { timeout: 20_000 }, async (context) => {
  const entered = gate();
  let heldPeer: Pick<ObserverOwner, 'socket' | 'observerId'> | undefined;
  const fixture = await desktopCoordinatorLifecycleFixture('normal', {}, { vm(options) {
    if (heldPeer) {
      assert.deepEqual(fixture.commands.at(-1), { id: heldPeer.observerId, kind: 'observe' });
      heldPeer.socket.cork(); heldPeer = undefined; entered.resolve();
    }
    return desktopVmDocument(options);
  } });
  const group = await observerOwners(context, 2, fixture);
  const [target, peer] = group.owned;
  heldPeer = peer;
  const deletionCount = group.fixture.effects.filter((entry) => entry.method === 'DELETE').length;
  target.socket.destroy();
  await target.failed.promise;
  assert.equal(group.coordinator.state.kind, 'active', 'A known control failure with unchanged peer topology must remain local.');
  assert.equal(peer.failures.length, 0);
  target.release.resolve();
  await target.startup.catch(() => {});
  const stopping = target.owner.stop();
  await entered.promise;
  assert.equal(await Promise.race([stopping.then(() => 'settled'), delay(50, 'pending')]), 'pending');
  assert.equal(group.fixture.effects.filter((entry) => entry.method === 'DELETE').length, deletionCount,
    'The target stop must queue behind the held independent observation.');
  assert.equal(group.fixture.containers.get(target.observerId)?.State.Running, true,
    'Joining a lost attachment must not fabricate a native stop.');
  peer.socket.uncork();
  await stopping;
  assert.equal(group.fixture.containers.has(target.observerId), false);
  assert.equal(group.fixture.containers.get(peer.observerId)?.State.Running, true);
  assert.equal(peer.failures.length, 0);
  assert.equal(target.failures.length, 1, 'The original local control failure remains visible once.');
  assert.equal(group.coordinator.state.kind, 'active');
  await target.owner.destroy();
  const state = group.coordinator.state;
  assert.equal(state.kind, 'active');
  if (state.kind === 'active') assert.equal(state.members.length, 1);
});

test('observer attachment loss after stop admission closes still joins the failed handle before exact deletion', { timeout: 20_000 }, async (context) => {
  const group = await observerOwners(context);
  const [target, peer] = group.owned;
  const stopping = target.owner.stop(); void stopping.catch(() => {});
  target.socket.destroy();
  await delay(25);
  target.release.resolve();
  await target.startup.catch(() => {});
  await stopping;
  assert.equal(group.fixture.containers.has(target.observerId), false);
  assert.equal(group.fixture.containers.get(peer.observerId)?.State.Running, true);
  assert.equal(peer.failures.length, 0);
  assert.equal(target.failures.length, 0, 'An already closed member does not dispatch another failure callback.');
  assert.equal(group.coordinator.state.kind, 'active');
});

test('a failed observer whose own producer exits after attachment loss stays member-local', { timeout: 20_000 }, async (context) => {
  const group = await observerOwners(context);
  const [target, peer] = group.owned;
  const container = group.fixture.containers.get(target.observerId); assert(container);
  // StdinOnce ends the helper with its lost attachment; only that released producer may leave.
  container.State = { Running: false, Status: 'exited' };
  target.socket.destroy();
  await target.failed.promise;
  await delay(1_500);
  assert.equal(group.coordinator.state.kind, 'active', 'The failed member retiring its own producer must not fence its peer.');
  assert.equal(peer.failures.length, 0);
  target.release.resolve();
  await target.startup.catch(() => {});
  await target.owner.destroy();
  assert.equal(group.fixture.containers.has(target.observerId), false);
  assert.equal(group.fixture.containers.get(peer.observerId)?.State.Running, true);
  assert.equal(peer.failures.length, 0);
  const state = group.coordinator.state;
  assert.equal(state.kind, 'active');
  if (state.kind === 'active') assert.equal(state.members.length, 1);
});

test('a released observer removed by another party before its exact deletion fences the group', { timeout: 20_000 }, async (context) => {
  const group = await observerOwners(context);
  const [target, peer] = group.owned;
  const container = group.fixture.containers.get(target.observerId); assert(container);
  container.State = { Running: false, Status: 'exited' };
  target.socket.destroy();
  await target.failed.promise;
  await delay(1_500);
  assert.equal(group.coordinator.state.kind, 'active');
  group.fixture.containers.delete(target.observerId);
  target.release.resolve();
  await target.startup.catch(() => {});
  await assert.rejects(target.owner.stop());
  assert.equal(group.coordinator.state.kind, 'fenced', 'Only the original exact delete may explain a released producer absence.');
  await peer.failed.promise;
});

for (const scenario of ['no_peer', 'changed_peer_topology'] as const) test(`observer loss fences the group when ${scenario} cannot prove shared safety`,
  { timeout: 20_000 }, async (context) => {
    const group = await observerOwners(context, scenario === 'no_peer' ? 1 : 2);
    const [target, peer] = group.owned;
    if (scenario === 'changed_peer_topology') {
      const container = group.fixture.containers.get(peer.observerId); assert(container);
      container.State = { Running: false, Status: 'exited' };
    }
    target.socket.destroy();
    await target.failed.promise;
    if (peer) await peer.failed.promise;
    const deadline = Date.now() + 5000;
    while (group.coordinator.state.kind !== 'fenced' && Date.now() < deadline) await delay(5);
    assert.equal(group.coordinator.state.kind, 'fenced');
    assert(target.failures.length > 0);
    if (peer) assert(peer.failures.length > 0);
  });

async function assertObserverFixtureReleased(fixture: ObserverFixture, holderPid: number) {
  assert.equal(fixture.server.listening, false, 'The owned Unix daemon must close after every setup/disposal outcome.');
  assert.equal(fixture.sockets.size, 0);
  await assert.rejects(access(fixture.spillDirectory), { code: 'ENOENT' });
  assert.throws(() => process.kill(holderPid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(-holderPid, 0), { code: 'ESRCH' });
}

test('failed observer fixture setup releases its member, holder and daemon while preserving setup and cleanup errors', { timeout: 20_000 }, async (context) => {
  const fixture = await desktopCoordinatorLifecycleFixture();
  assert.equal(fixture.server.listening, true);
  const setupFailure = new Error('Deliberate observer socket lookup failure.');
  const cleanupFailure = new Error('Deliberate fixture close failure after joining.');
  const originalClose = fixture.close.bind(fixture);
  context.mock.method(fixture, 'close', async () => { await originalClose(); throw cleanupFailure; });
  const originalGet = fixture.sockets.get.bind(fixture.sockets);
  let injected = false;
  context.mock.method(fixture.sockets, 'get', (id: string) => {
    if (!injected && fixture.containers.get(id)?.State.Running) { injected = true; throw setupFailure; }
    return originalGet(id);
  });
  await assert.rejects(observerOwners(context, 1, fixture, (cleanup) => {
    assert.deepEqual(cleanup.failures, [{ step: 'fixture', cause: cleanupFailure }]);
    assert.equal(cleanup.startups.length, 1, 'The member is owned before the failing socket lookup.');
    assert.equal(cleanup.startups[0].status, 'rejected');
  }), (cause) => cause === setupFailure);
  assert.equal(fixture.containers.size, 1, 'The deliberate setup failure follows a real observer start.');
  const holderPid = (await fixture.events()).find((event) => event.command === 'OPEN')?.pid;
  assert(holderPid);
  context.after(async () => {
    context.diagnostic(`Setup regression daemon listening after disposal: ${fixture.server.listening}`);
    await assertObserverFixtureReleased(fixture, holderPid);
    assert.equal(fixture.containers.size, 0);
    assert.equal(fixture.volumes.size, 0);
    assert.equal(fixture.networks.size, 0);
  });
});

test('observer fixture disposal joins its Unix daemon after holder termination rejects and preserves both failures', { timeout: 20_000 }, async (context) => {
  const fixture = await desktopCoordinatorLifecycleFixture();
  const closeFailure = new Error('Deliberate coordinator close failure.');
  const holderFailure = new Error('Deliberate holder termination failure after joining.');
  const originalCreate = fixture.createOwner.bind(fixture);
  const originalTerminate = fixture.terminateHolder.bind(fixture);
  context.mock.method(fixture, 'createOwner', () => {
    const coordinator = originalCreate();
    return { ...coordinator, get state() { return coordinator.state; }, async close() { throw closeFailure; } };
  });
  context.mock.method(fixture, 'terminateHolder', async () => { await originalTerminate(); throw holderFailure; });
  const group = await observerOwners(context, 1, fixture, async (cleanup) => {
    context.diagnostic(`Disposal regression daemon listening after disposal: ${fixture.server.listening}`);
    assert(holderPid);
    await assertObserverFixtureReleased(fixture, holderPid);
    assert.equal(fixture.containers.size, 0);
    assert.deepEqual(cleanup.failures, [{ step: 'coordinator', cause: closeFailure }, { step: 'holder', cause: holderFailure }]);
    assert.equal(cleanup.startups.length, 1);
    assert.equal(cleanup.startups[0].status, 'rejected');
  });
  const holderPid = (await group.fixture.events()).find((event) => event.command === 'OPEN')?.pid;
  assert(holderPid);
  assert.equal(fixture.server.listening, true);
  assert.equal(fixture.containers.size, 1);
});
