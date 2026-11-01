import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxOperationError } from '@agen-ai/sandbox';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';
import { prepareMember } from './fixtures/desktopCoordinatorMember.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
test.after(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArchitecture) Object.defineProperty(process, 'arch', originalArchitecture);
});

for (const failure of ['before_effect', 'after_effect', 'repeated'] as const) {
  test(`original coordinated cleanup retains and retries a delete that fails ${failure}`, { timeout: 20_000 }, async () => {
    let selectedId: string | undefined;
    let attempts = 0;
    const fixture = await desktopCoordinatorLifecycleFixture('normal', {
      async handleRequest({ method, path, response }): Promise<boolean> {
        if (method !== 'DELETE' || selectedId === undefined || path !== `/v1.52/containers/${selectedId}`) return false;
        attempts += 1;
        if (attempts > (failure === 'repeated' ? 2 : 1)) return false;
        if (failure === 'after_effect') fixture.containers.delete(selectedId);
        response.destroy();
        return true;
      },
    });
    const coordinator = fixture.createOwner();
    const capability = await coordinator.activate();
    const target = await prepareMember(undefined, { fixture, coordinator, capability });
    try {
      const created = await target.create();
      const peer = await prepareMember(undefined, target);
      const peerResource = await peer.create();
      selectedId = created.id;

      await assert.rejects(target.member.delete('route_observer'), { name: 'SandboxOperationError', code: 'driver_failure' });
      assert.equal(coordinator.state.kind, 'fenced');
      assert.equal(target.failures.length, 1);
      assert.equal(peer.failures.length, 1);
      await assert.rejects(peer.member.assertCurrent(), { name: 'SandboxOperationError', code: 'cancelled' });
      assert.equal(fixture.containers.has(peerResource.id), true, 'The peer retains its own exact cleanup owner.');
      await coordinator.settle();
      const retained = await target.canonical();
      assert(retained.generation.kind === 'dirty');
      assert.equal(retained.generation.state.kind, 'fenced');
      assert.equal(retained.generation.entered?.action, 'delete');
      assert.equal(retained.generation.entered.reference, created.id);
      assert.equal(retained.generation.entered.result.kind, 'unobserved');
      await assert.rejects(coordinator.close(), { name: 'DockerDesktopCoordinatorError' });

      if (failure === 'repeated') {
        await assert.rejects(target.member.delete('route_observer'), { name: 'SandboxOperationError', code: 'driver_failure' });
        const retried = await target.canonical();
        assert(retried.generation.kind === 'dirty');
        assert.deepEqual(retried.generation.entered, retained.generation.entered);
        assert.equal(fixture.containers.has(created.id), true);
      }

      await target.finish(false);
      assert.equal(fixture.containers.has(created.id), false);
      assert.equal(fixture.containers.has(peerResource.id), true);
      await peer.finish();
      assert.deepEqual(coordinator.state, { kind: 'closed', result: 'clean', generation: capability.generation });
      assert.equal(fixture.containers.size, 0);
      assert.equal(attempts, failure === 'after_effect' ? 1 : failure === 'repeated' ? 3 : 2);
      assert.equal(fixture.effects.filter((entry) => entry.path === '/v1.52/containers/create').length, 2);
    } finally { await target.close(); }
  });
}

test('an entered control-close rejection retains the same shutdown callback and original cleanup owners', { timeout: 20_000 }, async () => {
  const target = await prepareMember();
  try {
    const created = await target.create();
    const peer = await prepareMember(undefined, target);
    await peer.create();
    const failure = new SandboxOperationError('driver_failure', 'The original helper shutdown did not settle.');
    let attempts = 0;
    const close = async () => { if (++attempts === 1) throw failure; };

    await assert.rejects(target.member.controlClose('route_observer', close), (error: unknown) => error === failure);
    assert.equal(target.coordinator.state.kind, 'fenced');
    assert.equal(peer.failures.length, 1);
    await target.coordinator.settle();
    const retained = await target.canonical();
    assert(retained.generation.kind === 'dirty');
    assert.equal(retained.generation.entered?.action, 'control_close');
    assert.equal(retained.generation.entered.reference, created.id);

    await target.member.controlClose('route_observer', close);
    assert.equal(attempts, 2);
    const settled = await target.canonical();
    assert(settled.generation.kind === 'dirty');
    assert.equal(settled.generation.entered, null);
    assert.equal(target.fixture.effects.filter((entry) => entry.method === 'DELETE').length, 0);
    await target.finish(false);
    await peer.finish();
    assert.deepEqual(target.coordinator.state, { kind: 'closed', result: 'clean', generation: target.capability.generation });
  } finally { await target.close(); }
});
