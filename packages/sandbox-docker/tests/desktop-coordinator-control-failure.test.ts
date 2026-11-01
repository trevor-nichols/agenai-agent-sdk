import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import type { SandboxDriverReady } from '@agen-ai/sandbox/backend';
import { DockerEngine } from '../src/engine/client.js';
import { DockerApi } from '../src/resources/api.js';
import { DockerResourceOwner } from '../src/resources/owner.js';
import { parseCoordinatedDockerConfig } from '../src/policy/config.js';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';
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

async function observerOwners(count = 2) {
  const fixture = await desktopCoordinatorLifecycleFixture();
  const coordinator = fixture.createOwner();
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
    const startup = owner.start({
      async checkpoint(record) {
        if (record.resources.some((resource) => resource.role === 'storage' && resource.identity.kind === 'creating')) {
          reached.resolve(); await release.promise;
        }
      },
      onInfrastructureFailure(error) { failures.push(error); failed.resolve(error); },
    });
    void startup.catch(() => {});
    await Promise.race([reached.promise, startup.then(() => assert.fail('Startup must reach the original storage checkpoint.'))]);
    const observer = owner.recoveryRecord.resources.find((resource) => resource.role === 'route_observer');
    assert(observer?.identity.kind === 'identified');
    const socket = fixture.sockets.get(observer.identity.id); assert(socket);
    owned.push({ owner, startup, release, failed, failures, observerId: observer.identity.id, socket });
  }
  await coordinator.settle();
  return { fixture, coordinator, owned,
    async close() {
      for (const member of owned) { member.socket.resume(); member.release.resolve(); }
      await Promise.allSettled(owned.map((member) => member.owner.destroy()));
      await Promise.allSettled(owned.map((member) => member.startup));
      await coordinator.close({ timeoutMs: 100 }).catch(() => {});
      if (coordinator.state.kind !== 'closed') await fixture.terminateHolder();
      await fixture.close();
    },
  };
}

test('a failed observer joins its lost attachment then deletes only itself after an independent peer proof', { timeout: 20_000 }, async () => {
  const group = await observerOwners();
  const [target, peer] = group.owned;
  try {
    peer.socket.pause();
    const deletionCount = group.fixture.effects.filter((entry) => entry.method === 'DELETE').length;
    target.socket.destroy();
    await target.failed.promise;
    assert.equal(group.coordinator.state.kind, 'active', 'A known control failure with unchanged peer topology must remain local.');
    assert.equal(peer.failures.length, 0);
    target.release.resolve();
    await target.startup.catch(() => {});
    const stopping = target.owner.stop();
    assert.equal(await Promise.race([stopping.then(() => 'settled'), delay(50, 'pending')]), 'pending');
    assert.equal(group.fixture.effects.filter((entry) => entry.method === 'DELETE').length, deletionCount,
      'The target stop must queue behind the held independent observation.');
    assert.equal(group.fixture.containers.get(target.observerId)?.State.Running, true,
      'Joining a lost attachment must not fabricate a native stop.');
    peer.socket.resume();
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
  } finally { await group.close(); }
});

test('observer attachment loss after stop admission closes still joins the failed handle before exact deletion', { timeout: 20_000 }, async () => {
  const group = await observerOwners();
  const [target, peer] = group.owned;
  try {
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
  } finally { await group.close(); }
});

test('a failed observer whose own producer exits after attachment loss stays member-local', { timeout: 20_000 }, async () => {
  const group = await observerOwners();
  const [target, peer] = group.owned;
  try {
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
  } finally { await group.close(); }
});

test('a released observer removed by another party before its exact deletion fences the group', { timeout: 20_000 }, async () => {
  const group = await observerOwners();
  const [target, peer] = group.owned;
  try {
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
  } finally { await group.close(); }
});

for (const scenario of ['no_peer', 'changed_peer_topology'] as const) test(`observer loss fences the group when ${scenario} cannot prove shared safety`,
  { timeout: 20_000 }, async () => {
    const group = await observerOwners(scenario === 'no_peer' ? 1 : 2);
    try {
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
    } finally { await group.close(); }
  });
