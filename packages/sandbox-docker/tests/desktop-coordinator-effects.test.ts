import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { parseSandboxRecoveryRecord, SandboxOperationError } from '@agen-ai/sandbox';
import { DockerDesktopCoordinatorError } from '../src/network/desktop/coordinator/contracts.js';
import { parseCoordinatorSnapshot } from '../src/network/desktop/coordinator/journal/schema.js';
import { createDesktopVmObserverClient } from '../src/network/desktop/client.js';
import { desktopObserverConfiguration, verifyDesktopObserverContainer } from '../src/policy/desktopObserver.js';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';
import { gate } from './fixtures/engine.js';
import { prepareMember } from './fixtures/desktopCoordinatorMember.js';

// The prepared peer and Unix daemon exercise source ownership; they grant no native admission.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
test.after(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArchitecture) Object.defineProperty(process, 'arch', originalArchitecture);
});

test('original coordinated create and start each dispatch once and repeated calls preserve the exact acquired record',
  { timeout: 20_000 }, async () => {
    const owned = await prepareMember();
    let control: ReturnType<typeof createDesktopVmObserverClient> | undefined;
    try {
      const created = await owned.create();
      const original = owned.record();
      const checkpoints = owned.callbacks.length;
      await assert.rejects(owned.create(), { name: 'SandboxStateError', message: 'Original resource creation is once-only.' });
      assert.equal(owned.record(), original);
      assert.equal(owned.callbacks.length, checkpoints);
      const attachment = await owned.api.upgrade(`/v1.52/containers/${created.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`, undefined);
      control = createDesktopVmObserverClient({ attachment, configuration: desktopObserverConfiguration(owned.config.egress.routeAuthority),
        onFailure: (error) => owned.member.infrastructureFailed(error) });
      owned.member.observer(created.id, control);
      const validate = (inspection: Awaited<ReturnType<typeof owned.create>>) => {
        assert(inspection.container); verifyDesktopObserverContainer(inspection.container, owned.config, true);
      };
      const started = await owned.member.start('route_observer', undefined, { ready: control.ready, beginReadiness: () => control?.beginReadiness(), validate });
      assert.equal(started.id, created.id);
      await assert.rejects(owned.member.start('route_observer', undefined, { ready: control.ready, beginReadiness: () => control?.beginReadiness(), validate }));
      assert.equal(owned.fixture.effects.filter((entry) => entry.path === '/v1.52/containers/create').length, 1);
      assert.equal(owned.fixture.effects.filter((entry) => entry.path === `/v1.52/containers/${created.id}/start`).length, 1);
      assert.equal(owned.record(), original);
      await owned.member.controlClose('route_observer', () => control?.close() ?? Promise.resolve());
      await owned.finish();
      assert.deepEqual(owned.coordinator.state, { kind: 'closed', result: 'clean', generation: owned.config.coordination.generation.generationId });
    } finally { await control?.close(); await owned.close(); }
  });

test('an acknowledged create that disappears before its first inspection can retire through original fenced cleanup',
  { timeout: 15_000 }, async () => {
    const owned = await prepareMember();
    try {
      await assert.rejects(owned.create(undefined, (id) => { owned.fixture.containers.delete(id); }),
        { name: 'SandboxStateError', message: 'Docker did not confirm the exact original created resource.' });
      assert.equal(owned.coordinator.state.kind, 'fenced');
      assert.equal(owned.record().resources.find((entry) => entry.role === 'route_observer')?.identity.kind, 'creating');
      const original = await owned.canonical();
      if (original.generation.kind !== 'dirty') assert.fail('The acknowledged create retains canonical ownership.');
      assert.equal(original.generation.entered?.result.kind, 'returned');
      await owned.finish();
      assert.deepEqual(owned.coordinator.state, { kind: 'closed', result: 'clean', generation: owned.config.coordination.generation.generationId });
      assert.equal(owned.fixture.effects.filter((entry) => entry.path === '/v1.52/containers/create').length, 1);
      assert.equal(owned.fixture.effects.filter((entry) => entry.method === 'DELETE').length, 0);
    } finally { await owned.close(); }
  });

test('cancellation during the original creating checkpoint never dispatches and retains neutral creating through canonical retirement',
  { timeout: 15_000 }, async () => {
    const entered = gate(); const release = gate();
    const owned = await prepareMember(async (record) => {
      if (record.phase === 'starting' && record.resources.some((resource) => resource.role === 'route_observer' && resource.identity.kind === 'creating')) {
        entered.resolve(); await release.promise;
      }
    });
    const cancellation = new AbortController();
    const creating = owned.create(cancellation.signal); void creating.catch(() => {});
    try {
      await Promise.race([entered.promise, creating.then(() => assert.fail('The original creating checkpoint did not block.'))]);
      cancellation.abort(); release.resolve();
      await assert.rejects(creating, { name: 'SandboxOperationError', code: 'cancelled' });
      assert.equal(owned.record().resources.find((resource) => resource.role === 'route_observer')?.identity.kind, 'creating');
      const canonical = await owned.canonical(); assert.equal(canonical.generation.kind, 'dirty');
      if (canonical.generation.kind !== 'dirty') assert.fail('The original member must remain canonical before retirement.');
      assert.equal(canonical.generation.entered, null);
      assert.deepEqual(canonical.generation.members[0].roles.find((role) => role.role === 'route_observer')?.create, { kind: 'not_entered' });
      assert.deepEqual(owned.fixture.effects, []);
      await owned.finish();
      assert.equal(owned.record().resources.find((resource) => resource.role === 'route_observer')?.identity.kind, 'creating');
      assert.equal(owned.coordinator.state.kind, 'closed');
    } finally { release.resolve(); await creating.catch(() => {}); await owned.close(); }
  });

test('a rejected acquired-identity callback preserves the returned ID and canonical cleanup can retire that exact resource',
  { timeout: 15_000 }, async () => {
    let acquired: string | undefined;
    const owned = await prepareMember(async (record) => {
      const resource = record.resources.find((entry) => entry.role === 'route_observer');
      if (resource?.identity.kind === 'identified') { acquired = resource.identity.id; throw new Error('Original caller sink failed.'); }
    });
    try {
      await assert.rejects(owned.create(), { name: 'SandboxOperationError', code: 'persistence_failure' });
      assert.equal(owned.returned.get('route_observer'), acquired);
      assert.equal(owned.fixture.containers.has(acquired ?? ''), true);
      const canonical = await owned.canonical();
      if (canonical.generation.kind !== 'dirty') assert.fail('Expected retained canonical ownership.');
      assert.equal(canonical.generation.entered, null);
      assert.equal(canonical.generation.members[0].checkpoint.callerSink.kind, 'failed');
      assert.equal(canonical.generation.members[0].checkpoint.record.resources.find((resource) => resource.role === 'route_observer')?.identity.kind, 'identified');
      await owned.finish();
      assert.equal(owned.fixture.containers.size, 0);
      assert.equal(owned.fixture.effects.filter((entry) => entry.path === '/v1.52/containers/create').length, 1);
      assert.equal(owned.fixture.effects.filter((entry) => entry.method === 'DELETE' && entry.path === `/v1.52/containers/${acquired}`).length, 1);
      assert.equal(owned.coordinator.state.kind, 'closed');
    } finally { await owned.close(); }
  });

test('a blocked acquired callback retains its entered canonical effect while fenced known-ID cleanup removes the actual container',
  { timeout: 20_000 }, async () => {
    const entered = gate(); const release = gate();
    const owned = await prepareMember(async (record) => {
      if (record.resources.some((resource) => resource.role === 'route_observer' && resource.identity.kind === 'identified')) {
        entered.resolve(); await release.promise;
      }
    });
    let settled = false;
    const creating = owned.create().finally(() => { settled = true; }); void creating.catch(() => {});
    try {
      await Promise.race([entered.promise, creating.then(() => assert.fail('The original acquired checkpoint did not block.'))]);
      const resource = owned.record().resources.find((entry) => entry.role === 'route_observer');
      assert(resource?.identity.kind === 'identified');
      const id = resource.identity.id;
      owned.fixture.setDaemonId('different-daemon');
      let authorityFailure: unknown;
      await assert.rejects(owned.member.assertCurrent(), (cause: unknown) => { authorityFailure = cause; return true; });
      const propagated = owned.failures[0]?.cause;
      assert(propagated instanceof DockerDesktopCoordinatorError);
      assert.equal(propagated.cause, authorityFailure, 'The original topology/inspection failure must reach the member caller.');
      owned.fixture.setDaemonId('daemon-unit-1');
      assert.equal(owned.coordinator.state.kind, 'fenced');
      await owned.member.delete('route_observer');
      assert.equal(owned.fixture.containers.has(id), false);
      await turn(); assert.equal(settled, false);
      await assert.rejects(owned.member.retire(parseSandboxRecoveryRecord({ ...owned.record(), phase: 'destroyed' })),
        { name: 'SandboxStateError', message: 'Canonical retirement cannot abandon an original caller checkpoint.' });
      const canonical = await owned.canonical();
      if (canonical.generation.kind !== 'dirty') assert.fail('A pending caller callback cannot clean the generation.');
      assert.equal(canonical.generation.entered?.result.kind, 'returned');
      if (canonical.generation.entered?.result.kind === 'returned') assert.equal(canonical.generation.entered.result.id, id);
      assert.equal(canonical.generation.members.length, 1);
      release.resolve();
      await assert.rejects(creating, { name: 'SandboxOperationError', code: 'cancelled' });
      assert.equal(owned.fixture.containers.size, 0);
      assert.equal(owned.fixture.effects.filter((entry) => entry.path === '/v1.52/containers/create').length, 1);
      assert.equal((await owned.canonical()).generation.kind, 'dirty');
      await owned.finish();
      assert.deepEqual(owned.coordinator.state, { kind: 'closed', result: 'clean', generation: owned.config.coordination.generation.generationId });
      assert.equal(owned.fixture.containers.size, 0);
    } finally { release.resolve(); await creating.catch(() => {}); await owned.close(); }
  });

test('a fence cancels a published cleanup queued behind a peer callback and exact retries retire both original members',
  { timeout: 20_000 }, async () => {
    const first = await prepareMember();
    const entered = gate(); const release = gate();
    let peerCreating: Promise<unknown> | undefined;
    try {
      const firstResource = await first.create();
      const peer = await prepareMember(async (record) => {
        if (record.phase === 'starting' && record.resources.some((resource) => resource.role === 'route_observer' && resource.identity.kind === 'identified')) {
          entered.resolve(); await release.promise;
        }
      }, first);
      peerCreating = peer.create(); void peerCreating.catch(() => {});
      await Promise.race([entered.promise, peerCreating.then(() => assert.fail('The peer checkpoint did not block.'))]);
      const removing = first.member.delete('route_observer'); void removing.catch(() => {});
      const deadline = Date.now() + 5000;
      let originalQueueSequence: number | undefined;
      while (originalQueueSequence === undefined) {
        const snapshot = await first.canonical();
        if (snapshot.generation.kind !== 'dirty') assert.fail('Expected the original dirty generation.');
        originalQueueSequence = snapshot.generation.queue.find((entry) => entry.memberId === first.record().operationId && entry.action === 'delete')?.effectSequence;
        if (Date.now() >= deadline) assert.fail('Cleanup did not publish its original queued intent.');
        await turn();
      }
      first.member.infrastructureFailed(new SandboxOperationError('driver_failure', 'The original common authority was lost.'));
      await removing.catch(() => {});
      assert.equal(first.fixture.containers.has(firstResource.id), false);
      const cancelled = await first.canonical();
      if (cancelled.generation.kind !== 'dirty') assert.fail('The peer callback must retain the original dirty generation.');
      assert.equal(cancelled.generation.queue.some((entry) => entry.effectSequence === originalQueueSequence), false);
      assert.equal(cancelled.generation.members.length, 2);
      release.resolve();
      await assert.rejects(peerCreating, { name: 'SandboxOperationError', code: 'cancelled' });
      await first.member.delete('route_observer');
      await first.finish(false);
      await peer.finish();
      assert.deepEqual(first.coordinator.state, { kind: 'closed', result: 'clean', generation: first.config.coordination.generation.generationId });
      assert.equal(first.fixture.containers.size, 0);
      assert.equal(first.fixture.effects.filter((entry) => entry.path === '/v1.52/containers/create').length, 2);
      assert.equal(first.fixture.effects.filter((entry) => entry.method === 'DELETE').length, 2);
    } finally { release.resolve(); await peerCreating?.catch(() => {}); await first.close(); }
  });

test('a peer cleanup published while a member start owns the physical slot waits for that start to settle',
  { timeout: 20_000 }, async () => {
    let held: { id: string; entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
    const fixture = await desktopCoordinatorLifecycleFixture('normal', { async handleRequest({ method, path }) {
      const hold = held;
      if (!hold || method !== 'GET' || path !== `/v1.52/containers/${hold.id}/json`) return false;
      held = undefined; hold.entered.resolve(); await hold.release.promise;
      return false;
    } });
    const coordinator = fixture.createOwner();
    const group = { fixture, coordinator, capability: await coordinator.activate() };
    const first = await prepareMember(undefined, group);
    const peer = await prepareMember(undefined, group);
    let control: ReturnType<typeof createDesktopVmObserverClient> | undefined;
    let starting: Promise<{ id: string }> | undefined;
    const hold = { id: '', entered: gate(), release: gate() };
    try {
      const removed = await first.create();
      const created = await peer.create();
      const attachment = await peer.api.upgrade(`/v1.52/containers/${created.id}/attach?stream=true&stdin=true&stdout=true&stderr=true`, undefined);
      control = createDesktopVmObserverClient({ attachment, configuration: desktopObserverConfiguration(peer.config.egress.routeAuthority),
        onFailure: (error) => peer.member.infrastructureFailed(error) });
      peer.member.observer(created.id, control);
      held = { ...hold, id: created.id };
      starting = peer.member.start('route_observer', undefined, { ready: control.ready, beginReadiness: () => control?.beginReadiness(),
        validate(inspection) { assert(inspection.container); verifyDesktopObserverContainer(inspection.container, peer.config, true); } });
      void starting.catch(() => {});
      await Promise.race([hold.entered.promise, starting.then(() => assert.fail('The peer start did not reach its before-state inspection.'))]);
      const removing = first.member.delete('route_observer'); void removing.catch(() => {});
      const deadline = Date.now() + 5000;
      for (;;) {
        const snapshot = await first.canonical();
        if (snapshot.generation.kind !== 'dirty') assert.fail('Expected the original dirty generation.');
        if (snapshot.generation.queue.some((entry) => entry.memberId === first.record().operationId && entry.action === 'delete')) break;
        if (Date.now() >= deadline) assert.fail('Cleanup did not publish its original queued intent.');
        await turn();
      }
      hold.release.resolve();
      assert.equal((await starting).id, created.id);
      await removing;
      assert.equal(fixture.containers.has(removed.id), false);
      assert.deepEqual([...first.failures, ...peer.failures], []);
      await peer.member.controlClose('route_observer', () => control?.close() ?? Promise.resolve());
      await first.finish(false);
      await peer.finish();
      assert.deepEqual(coordinator.state, { kind: 'closed', result: 'clean', generation: peer.config.coordination.generation.generationId });
      assert.equal(fixture.effects.filter((entry) => entry.path === `/v1.52/containers/${created.id}/start`).length, 1);
    } finally { hold.release.resolve(); await starting?.catch(() => {}); await control?.close(); await first.close(); }
  });

test('failed durable fence publication preserves physical known-ID deletion and the original retry can later retire',
  { timeout: 15_000 }, async () => {
    const owned = await prepareMember();
    try {
      const created = await owned.create();
      await owned.fixture.failDiscard(true);
      await owned.fixture.failNextCommit();
      owned.member.infrastructureFailed(new SandboxOperationError('driver_failure', 'The original control was lost before cleanup.'));
      await assert.rejects(owned.member.delete('route_observer'));
      assert.equal(owned.fixture.containers.has(created.id), false);
      assert.equal(owned.coordinator.state.kind, 'fenced');
      assert.equal(await owned.fixture.hasTemp(), true);
      await owned.fixture.failDiscard(false);
      await assert.rejects(owned.coordinator.close());
      assert.equal(await owned.fixture.hasTemp(), false);
      const retained = await owned.canonical();
      if (retained.generation.kind !== 'dirty') assert.fail('Physical absence does not settle the failed canonical publication.');
      assert.equal(retained.generation.members.length, 1);
      await owned.finish();
      assert.deepEqual(owned.coordinator.state, { kind: 'closed', result: 'clean', generation: owned.config.coordination.generation.generationId });
      assert.equal(owned.fixture.effects.filter((entry) => entry.method === 'DELETE').length, 1);
    } finally { await owned.close(); }
  });

test('recovered canonical publication commits the group fence before a subsequent original delete intent',
  { timeout: 15_000 }, async () => {
    const owned = await prepareMember();
    try {
      const created = await owned.create();
      await owned.fixture.failNextCommit();
      owned.member.infrastructureFailed(new SandboxOperationError('driver_failure', 'The original control was lost before cleanup.'));
      await owned.member.delete('route_observer');
      const queuedDeletion = (await owned.fixture.events()).flatMap((entry) => {
        if (entry.command !== 'COMMIT' || entry.text === undefined) return [];
        const snapshot = parseCoordinatorSnapshot(entry.text);
        return snapshot.generation.kind === 'dirty' && snapshot.generation.queue.some((effect) => effect.action === 'delete') ? [snapshot.generation] : [];
      })[0];
      assert(queuedDeletion);
      assert.equal(queuedDeletion.state.kind, 'fenced');
      assert.equal(owned.fixture.containers.has(created.id), false);
      await owned.finish();
      assert.deepEqual(owned.coordinator.state, { kind: 'closed', result: 'clean', generation: owned.config.coordination.generation.generationId });
      assert.equal(owned.fixture.effects.filter((entry) => entry.method === 'DELETE').length, 1);
    } finally { await owned.close(); }
  });

test('original members retry interleaved shutdown and a lost create response after entered work joins without replay',
  { timeout: 20_000 }, async (context) => {
    const replyEntered = gate<string>(); const releaseReply = gate();
    let selectedName: string | undefined;
    const fixture = await desktopCoordinatorLifecycleFixture('normal', { async beforeContainerReply({ id, name }) {
      if (name !== selectedName) return 'reply';
      replyEntered.resolve(id); await releaseReply.promise; return 'drop';
    } });
    const coordinator = fixture.createOwner();
    const capability = await coordinator.activate();
    const first = await prepareMember(undefined, { fixture, coordinator, capability });
    let creating: Promise<unknown> | undefined;
    try {
      const firstResource = await first.create();
      const peer = await prepareMember(undefined, first);
      selectedName = peer.record().resources.find((resource) => resource.role === 'route_observer')?.name;
      assert.equal(typeof selectedName, 'string');
      creating = peer.create(); void creating.catch(() => {});
      const peerId = await Promise.race([replyEntered.promise, creating.then(() => assert.fail('The peer reply must remain held.'))]);
      assert.equal(fixture.containers.has(peerId), true);
      const removing = first.member.delete('route_observer'); void removing.catch(() => {});
      const deadline = Date.now() + 5000;
      for (;;) {
        const snapshot = await first.canonical(); assert(snapshot.generation.kind === 'dirty');
        if (snapshot.generation.queue.some((entry) => entry.memberId === first.record().operationId && entry.action === 'delete')) break;
        if (Date.now() >= deadline) assert.fail('Original shutdown must publish its intent behind the held create.');
        await turn();
      }
      releaseReply.resolve();
      await assert.rejects(creating, { name: 'SandboxOperationError', code: 'driver_failure' });
      await removing.catch(() => {});
      await peer.member.delete('route_observer').catch(() => {});
      await coordinator.settle();
      assert.equal(fixture.containers.size, 0);
      const retained = await first.canonical(); assert(retained.generation.kind === 'dirty');
      assert.equal(retained.generation.members.length, 2);
      const retries = await Promise.allSettled([first.finish(false), peer.finish(false)]);
      const retryFailure = retries.find((result) => result.status === 'rejected');
      if (retryFailure?.status === 'rejected') {
        const snapshot = await first.canonical(); assert(snapshot.generation.kind === 'dirty');
        context.diagnostic(JSON.stringify({ before: { queue: retained.generation.queue, entered: retained.generation.entered },
          after: { queue: snapshot.generation.queue, entered: snapshot.generation.entered,
            members: snapshot.generation.members.map((member) => ({ memberId: member.memberId,
              roles: member.roles.filter((role) => role.role === 'route_observer') })) } }));
        throw retryFailure.reason;
      }
      await coordinator.close();
      assert.deepEqual(coordinator.state, { kind: 'closed', result: 'clean', generation: capability.generation });
      assert.deepEqual(fixture.effects.map(({ method, path }) => [method, path]), [
        ['POST', '/v1.52/containers/create'], ['POST', '/v1.52/containers/create'],
        ['DELETE', `/v1.52/containers/${firstResource.id}`], ['DELETE', `/v1.52/containers/${peerId}`],
      ]);
    } finally { releaseReply.resolve(); await creating?.catch(() => {}); await first.close(); }
  });
