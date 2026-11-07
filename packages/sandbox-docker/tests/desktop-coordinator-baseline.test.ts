import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopVmObserverClient } from '../src/network/desktop/client.js';
import type { DockerDesktopCoordinator } from '../src/network/desktop/coordinator/contracts.js';
import { desktopObserverConfiguration, verifyDesktopObserverContainer } from '../src/policy/desktopObserver.js';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';
import { prepareMember } from './fixtures/desktopCoordinatorMember.js';
import { defaultBridge } from './fixtures/desktopCoordinatorTopologyLifecycle.js';

// The prepared peer and Unix daemon exercise source ownership; they grant no native admission.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
test.after(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArchitecture) Object.defineProperty(process, 'arch', originalArchitecture);
});

async function waitForFence(owner: DockerDesktopCoordinator): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (owner.state.kind !== 'fenced' && Date.now() < deadline) await delay(5);
  assert.equal(owner.state.kind, 'fenced');
}

test('an idle coordinator stays active while Engine networks change during its health observations', { timeout: 15_000 }, async (context) => {
  let churning = false, created = 0;
  const fixture = await desktopCoordinatorLifecycleFixture('normal', { async handleRequest({ path }) {
    // Each listing finds another network, so no network census could stay consistent.
    if (churning && path === '/v1.52/networks') {
      const network = { ...defaultBridge(++created), Name: `foreign-${created}`, Options: {} };
      fixture.networks.set(network.Id, network);
    }
    return false;
  } });
  const owner = fixture.createOwner();
  try {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    await owner.activate();
    churning = true;
    for (const observation of [1, 2]) {
      context.mock.timers.tick(1_000);
      await fixture.waitFor('CHECK', observation);
      await owner.settle();
    }
    assert.equal(owner.state.kind, 'active');
  } finally { await owner.close().catch(() => {}); await fixture.close(); }
});

test('a replaced default bridge seen by a registered member observer fences as Engine authority loss', { timeout: 20_000 }, async () => {
  const fixture = await desktopCoordinatorLifecycleFixture();
  const original = defaultBridge(0);
  fixture.networks.set(original.Id, original);
  const coordinator = fixture.createOwner();
  const owned = await prepareMember(undefined, { fixture, coordinator, capability: await coordinator.activate() });
  let control: ReturnType<typeof createDesktopVmObserverClient> | undefined;
  try {
    const created = await owned.create();
    const attachment = await owned.api.upgrade(`/v1.52/containers/${created.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`, undefined);
    control = createDesktopVmObserverClient({ attachment, configuration: desktopObserverConfiguration(owned.config.egress.routeAuthority),
      onFailure: (error) => owned.member.infrastructureFailed(error) });
    owned.member.observer(created.id, control);
    await owned.member.start('route_observer', undefined, { ready: control.ready, beginReadiness: () => control?.beginReadiness(),
      validate(inspection) { assert(inspection.container); verifyDesktopObserverContainer(inspection.container, owned.config, true); } });
    assert.equal(coordinator.state.kind === 'active' && coordinator.state.observation, 'current');
    fixture.networks.delete(original.Id);
    const restarted = defaultBridge(1);
    fixture.networks.set(restarted.Id, restarted);
    await waitForFence(coordinator);
    assert.deepEqual(coordinator.state.kind === 'fenced' && coordinator.state.failure, { kind: 'authority_lost', source: 'engine' });
  } finally { await control?.close(); await owned.close(); }
});
