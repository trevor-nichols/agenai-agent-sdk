import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { SandboxOperationError } from '@agen-ai/sandbox';
import { DockerDesktopCoordinatorError } from '../src/network/desktop/coordinator/contracts.js';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';
import { prepareMember } from './fixtures/desktopCoordinatorMember.js';
import { gate } from './fixtures/engine.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
test.after(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArchitecture) Object.defineProperty(process, 'arch', originalArchitecture);
});

for (const admission of ['member_queue', 'entered', 'handoff'] as const) {
  test(`settlement joins ${admission} cleanup through fencing and excludes later cleanup`, { timeout: 15_000 }, async () => {
    const firstDelete = { entered: gate(), release: gate() };
    const laterDelete = { entered: gate(), release: gate() };
    const checkpoint = { entered: gate(), release: gate() };
    const deletions = new Map<string, typeof firstDelete>();
    const fixture = await desktopCoordinatorLifecycleFixture('normal', { async handleRequest({ method, path }) {
      const held = method === 'DELETE' ? deletions.get(path) : undefined;
      if (held) { held.entered.resolve(); await held.release.promise; }
      return false;
    } });
    const coordinator = fixture.createOwner();
    const first = await prepareMember(undefined, { fixture, coordinator, capability: await coordinator.activate() });
    const peer = await prepareMember(async (record) => {
      if (admission === 'handoff' && record.resources.some((resource) => resource.identity.kind === 'identified')) {
        checkpoint.entered.resolve(); await checkpoint.release.promise;
      }
    }, first);
    let creating: Promise<unknown> | undefined;
    let removing: Promise<void> | undefined;
    let later: Promise<void> | undefined;
    try {
      const created = await first.create();
      deletions.set(`/v1.52/containers/${created.id}`, firstDelete);
      creating = peer.create(); void creating.catch(() => {});
      if (admission === 'handoff') await checkpoint.entered.promise;
      else await creating;
      const peerResource = peer.record().resources.find((resource) => resource.role === 'route_observer');
      assert(peerResource?.identity.kind === 'identified');
      deletions.set(`/v1.52/containers/${peerResource.identity.id}`, laterDelete);
      const fence = () => first.member.infrastructureFailed(new SandboxOperationError('driver_failure', 'Shared authority was lost.'));
      if (admission !== 'handoff') { fence(); await coordinator.settle(); }
      removing = first.member.delete('route_observer'); void removing.catch(() => {});
      if (admission === 'entered') await firstDelete.entered.promise;
      if (admission === 'handoff') {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const snapshot = await first.canonical(); assert(snapshot.generation.kind === 'dirty');
          if (snapshot.generation.queue.some((effect) => effect.action === 'delete')) break;
          assert(Date.now() < deadline, 'Cleanup must publish before the handoff.');
          await turn();
        }
      }
      let settled = false;
      const settling = coordinator.settle().then(() => { settled = true; });
      if (admission === 'handoff') { fence(); checkpoint.release.resolve(); await creating.catch(() => {}); }
      await firstDelete.entered.promise;
      await assert.rejects(coordinator.settle({ timeoutMs: 25 }), (error: unknown) => {
        assert(error instanceof DockerDesktopCoordinatorError);
        assert.deepEqual(error.failure, { kind: 'interrupted', by: 'deadline', effect: 'owned' });
        return true;
      });
      assert.equal(settled, false, 'The original cut must retain cleanup admitted before the call.');
      assert.equal(fixture.containers.has(created.id), true);
      later = peer.member.delete('route_observer'); void later.catch(() => {});
      firstDelete.release.resolve();
      await Promise.all([removing, settling, laterDelete.entered.promise]);
      assert.equal(settled, true);
      assert.equal(fixture.containers.has(created.id), false);
      assert.equal(fixture.containers.has(peerResource.identity.id), true, 'A later held cleanup must not extend the original cut.');
      laterDelete.release.resolve(); await later;
      await first.finish(false); await peer.finish();
      assert.deepEqual(coordinator.state, { kind: 'closed', result: 'clean', generation: first.capability.generation });
      assert.equal(fixture.containers.size, 0);
      assert.equal(fixture.effects.filter((effect) => effect.method === 'DELETE').length, 2);
    } finally {
      checkpoint.release.resolve(); firstDelete.release.resolve(); laterDelete.release.resolve();
      await Promise.allSettled([creating, removing, later]);
      await first.close();
    }
  });
}
