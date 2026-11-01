import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DockerDesktopCoordinatorError } from '../src/network/desktop/coordinator/contracts.js';
import { captureDesktopCoordinatorAuthority } from '../src/network/desktop/coordinator/binding.js';
import type { DockerDesktopCoordinator } from '../src/network/desktop/coordinator/contracts.js';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
test.after(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArchitecture) Object.defineProperty(process, 'arch', originalArchitecture);
});

async function withOwner(scenario: Parameters<typeof desktopCoordinatorLifecycleFixture>[0],
  use: (owner: DockerDesktopCoordinator, fixture: Awaited<ReturnType<typeof desktopCoordinatorLifecycleFixture>>) => Promise<void>) {
  const fixture = await desktopCoordinatorLifecycleFixture(scenario);
  const owner = fixture.createOwner();
  try { await use(owner, fixture); }
  finally {
    await fixture.releaseCommit(); await fixture.failDiscard(false);
    await owner.close().catch(() => {});
    await fixture.close();
  }
}

function failure(owner: DockerDesktopCoordinator, expected: unknown) {
  return (error: unknown) => {
    assert(error instanceof DockerDesktopCoordinatorError);
    assert.equal(error.owner, owner); assert.deepEqual(error.failure, expected);
    return true;
  };
}

async function waitForFence(owner: DockerDesktopCoordinator): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (owner.state.kind !== 'fenced' && Date.now() < deadline) await delay(5);
  assert.equal(owner.state.kind, 'fenced', 'Expired authority must fence without a new admission attempt.');
}

test('Desktop source constructor stays inert and explicit initialization, activation and clean close settle one generation',
  { timeout: 15_000 }, async () => {
    await withOwner('normal', async (owner, fixture) => {
      assert.deepEqual(owner.state, { kind: 'inert' });
      await owner.settle();
      const inert = fixture.createOwner(); await inert.close();
      assert.deepEqual(inert.state, { kind: 'closed', result: 'never_activated' });
      const cancelled = new AbortController(); cancelled.abort();
      await assert.rejects(owner.activate({ signal: cancelled.signal }),
        failure(owner, { kind: 'interrupted', by: 'signal', effect: 'not_entered' }));
      assert.deepEqual(owner.state, { kind: 'inert' });
      assert.deepEqual(await fixture.events(), []); assert.deepEqual(fixture.requests, []);
      const initial = await fixture.current();
      await owner.initialize();
      assert.deepEqual(owner.state, { kind: 'inert' }); assert.deepEqual(await fixture.current(), initial);
      const authority = await owner.activate();
      assert.equal(authority.kind, 'desktop_coordinator');
      assert.deepEqual(owner.state, { kind: 'active', observation: 'awaiting_member_observer', generation: authority.generation,
        members: [], queuedTransitions: 0, enteredTransitions: 0 });
      assert.equal(await owner.activate(), authority);
      await owner.close(); await owner.close();
      assert.deepEqual(owner.state, { kind: 'closed', result: 'clean', generation: authority.generation });
      const settled = await fixture.current();
      assert(settled && typeof settled === 'object' && 'generation' in settled);
      assert(settled.generation && typeof settled.generation === 'object');
      assert.equal(Reflect.get(settled.generation, 'kind'), 'clean');
      assert.equal(Reflect.get(settled.generation, 'lastGenerationId'), authority.generation);
      assert.deepEqual(fixture.effects, []); assert.equal(await fixture.hasTemp(), false);
    });
  });

test('a first initialization that fails after bootstrap retains a clean authority, and an empty state reports a corrupt journal',
  { timeout: 15_000 }, async () => {
    const opened: { events?: () => Promise<readonly { command: string }[]> } = {};
    let failDaemon = true;
    const fixture = await desktopCoordinatorLifecycleFixture('bootstrap', { async handleRequest({ path, response }) {
      if (path !== '/info' || !failDaemon || !(await opened.events?.())?.some((entry) => entry.command === 'OPEN')) return false;
      failDaemon = false;
      response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}');
      return true;
    } });
    opened.events = fixture.events;
    try {
      const interrupted = fixture.createOwner();
      await assert.rejects(interrupted.initialize());
      assert.equal(failDaemon, false);
      const committed = await fixture.current();
      assert(committed && typeof committed === 'object' && 'generation' in committed);
      assert.equal(Reflect.get(Object(committed.generation), 'kind'), 'clean');
      const owner = fixture.createOwner();
      await owner.initialize();
      assert.deepEqual(owner.state, { kind: 'inert' });
      assert.deepEqual(await fixture.current(), committed);
      await owner.close();
      await fixture.replaceCanonical('');
      const empty = fixture.createOwner();
      await assert.rejects(empty.initialize(), failure(empty, { kind: 'journal_invalid', reason: 'corrupt' }));
    } finally { await fixture.close(); }
  });

test('Desktop activation rejects a baseline that ages beyond authority freshness while generation publication is paused',
  { timeout: 15_000 }, async (context) => {
    let now = 1_000;
    context.mock.method(performance, 'now', () => now);
    await withOwner('paused_generation', async (owner, fixture) => {
      const activation = owner.activate(); void activation.catch(() => {});
      await fixture.waitFor('COMMIT_WAITING');
      now = 46_001;
      await fixture.releaseCommit();
      await assert.rejects(activation, failure(owner, { kind: 'authority_lost', source: 'freshness' }));
      assert.equal(owner.state.kind, 'fenced');
      assert.deepEqual(fixture.effects, []);
    });
  });

test('Desktop close discards the original unpublished generation temp before releasing a prior clean authority',
  { timeout: 15_000 }, async () => {
    await withOwner('failed_generation', async (owner, fixture) => {
      const initial = await fixture.current();
      await assert.rejects(owner.activate(), failure(owner, { kind: 'persistence_failed', boundary: 'generation' }));
      assert.equal(await fixture.hasTemp(), true);
      await owner.close();
      assert.equal(await fixture.hasTemp(), false, 'Successful close must settle its original unpublished temp.');
      const commands = (await fixture.events()).map((entry) => entry.command);
      const cleanup = commands.indexOf('CLEANUP');
      const discard = commands.indexOf('DISCARD_TEMP');
      assert(cleanup >= 0 && discard > cleanup);
      assert(commands.slice(cleanup + 1, discard).includes('READ'));
      assert(discard < commands.indexOf('CLOSE'));
      assert.deepEqual(await fixture.current(), initial);
      assert.deepEqual(owner.state, { kind: 'closed', result: 'never_activated' });
      assert.deepEqual(fixture.effects, []);
    });
  });

test('Desktop close retains its retry owner when unpublished temp cleanup fails', { timeout: 15_000 }, async () => {
  await withOwner('failed_generation', async (owner, fixture) => {
    await fixture.failDiscard(true);
    await assert.rejects(owner.activate(), failure(owner, { kind: 'persistence_failed', boundary: 'generation' }));
    await assert.rejects(owner.close(), failure(owner, { kind: 'retained_ownership', members: [], pendingTransition: true }));
    assert.equal(owner.state.kind, 'fenced'); assert.equal(await fixture.hasTemp(), true);
    assert.equal((await fixture.events()).some((entry) => entry.command === 'CLOSE'), false);
    await fixture.failDiscard(false); await owner.close();
    assert.equal(await fixture.hasTemp(), false);
    assert.deepEqual(owner.state, { kind: 'closed', result: 'never_activated' });
  });
});

test('Desktop settle includes an immediately preceding close whose publication has entered', { timeout: 15_000 }, async () => {
  await withOwner('paused_close', async (owner, fixture) => {
    await owner.activate();
    const closing = owner.close(); void closing.catch(() => {});
    let settled = false;
    const settling = owner.settle().then(() => { settled = true; });
    await fixture.waitFor('COMMIT_WAITING'); await turn();
    assert.equal(settled, false, 'Settle must join the close accepted before its observation cut.');
    await fixture.releaseCommit(); await Promise.all([closing, settling]);
    assert.equal(owner.state.kind, 'closed'); assert.deepEqual(fixture.effects, []);
  });
});

test('Desktop activation interruption retains its entered publication and cannot restore late active authority',
  { timeout: 15_000 }, async () => {
    await withOwner('paused_generation', async (owner, fixture) => {
      const controller = new AbortController();
      const activation = owner.activate({ signal: controller.signal }); void activation.catch(() => {});
      await fixture.waitFor('COMMIT_WAITING'); controller.abort();
      await assert.rejects(activation, failure(owner, { kind: 'interrupted', by: 'signal', effect: 'owned' }));
      assert.equal(owner.state.kind, 'fenced');
      let settled = false;
      const settling = owner.settle().then(() => { settled = true; });
      await turn(); assert.equal(settled, false);
      await fixture.releaseCommit(); await settling;
      assert.equal(owner.state.kind, 'fenced');
      await owner.close();
      assert.equal(owner.state.kind, 'closed'); assert.deepEqual(fixture.effects, []);
      const commands = (await fixture.events()).map((entry) => entry.command);
      assert(commands.indexOf('CLEANUP') > commands.indexOf('COMMIT'));
      assert(commands.indexOf('CLOSE') > commands.indexOf('CLEANUP'));
    });
  });

test('Desktop close retry requires an acknowledged clean publication after successful readback of failed directory sync',
  { timeout: 15_000 }, async () => {
    await withOwner('failed_clean', async (owner, fixture) => {
      const authority = await owner.activate();
      await assert.rejects(owner.close(), failure(owner, { kind: 'persistence_failed', boundary: 'clean' }));
      assert.equal(owner.state.kind, 'fenced'); assert.equal(await fixture.hasTemp(), false);
      const published = await fixture.current();
      assert(published && typeof published === 'object' && 'generation' in published);
      assert(published.generation && typeof published.generation === 'object');
      assert.equal(Reflect.get(published.generation, 'kind'), 'clean');
      assert.equal((await fixture.events()).some((entry) => entry.command === 'CLOSE'), false);
      let closed = false;
      const closing = owner.close().then(() => { closed = true; }); void closing.catch(() => {});
      await fixture.waitFor('COMMIT_WAITING'); await turn();
      assert.equal(closed, false);
      const beforeRelease = await fixture.events();
      assert.equal(beforeRelease.some((entry) => entry.command === 'CLOSE'), false);
      const commits = beforeRelease.filter((entry) => entry.command === 'COMMIT');
      assert.equal(commits.at(-1)?.text, commits.at(-2)?.text,
        'Retry must acknowledge the exact original clean state whose sync failed.');
      await fixture.releaseCommit(); await closing;
      assert.deepEqual(owner.state, { kind: 'closed', result: 'clean', generation: authority.generation });
      assert.deepEqual(await fixture.current(), published); assert.deepEqual(fixture.effects, []);
    });
  });

test('Desktop health poll fences an already expired authority before it can refresh observation time',
  { timeout: 15_000 }, async (context) => {
    let now = 1_000;
    context.mock.method(performance, 'now', () => now);
    await withOwner('normal', async (owner, fixture) => {
      const authority = await owner.activate();
      now = 46_001;
      await waitForFence(owner);
      assert.equal((await fixture.events()).some((entry) => entry.command === 'CHECK'), false,
        'Expiry must be checked before entering another health observation.');
      assert.throws(() => captureDesktopCoordinatorAuthority(authority),
        failure(owner, { kind: 'authority_lost', source: 'freshness' }));
      assert.deepEqual(fixture.effects, []);
    });
  });

test('Desktop authority expires while its original health I/O is pending and cannot revive after settlement',
  { timeout: 15_000 }, async (context) => {
    let now = 1_000;
    context.mock.method(performance, 'now', () => now);
    await withOwner('paused_health', async (owner, fixture) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const authority = await owner.activate();
      now += 1_000;
      context.mock.timers.tick(1_000);
      await fixture.waitFor('CHECK_WAITING');
      now += 43_999;
      context.mock.timers.tick(43_999);
      const beforeExpiry = owner.state;
      assert.equal(beforeExpiry.kind, 'active');
      now += 1;
      context.mock.timers.tick(1);
      const expired = owner.state;
      assert.equal(expired.kind, 'fenced', 'A pending holder command must not suspend the authority deadline.');
      assert.throws(() => captureDesktopCoordinatorAuthority(authority),
        failure(owner, { kind: 'authority_lost', source: 'freshness' }));
      let settled = false;
      const settling = owner.settle().then(() => { settled = true; });
      await turn();
      assert.equal(settled, false, 'Expiry retains ownership of the original pending command.');
      await fixture.releaseCommit();
      await settling;
      assert.equal(owner.state.kind, 'fenced');
      assert.deepEqual(fixture.effects, []);
    });
  });

test('Desktop health observations renew freshness while healthy members are draining', { timeout: 15_000 }, async (context) => {
  let now = 1_000;
  context.mock.method(performance, 'now', () => now);
  await withOwner('normal', async (owner, fixture) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const authority = await owner.activate();
    owner.closeAdmission();
    for (let observation = 1; observation <= 2; observation += 1) {
      now += 30_000;
      context.mock.timers.tick(30_000);
      await fixture.waitFor('CHECK', observation);
      await owner.settle();
    }
    assert.equal(owner.state.kind, 'draining');
    assert.throws(() => captureDesktopCoordinatorAuthority(authority), failure(owner, { kind: 'admission_closed' }));
    assert.deepEqual(fixture.effects, []);
  });
});
