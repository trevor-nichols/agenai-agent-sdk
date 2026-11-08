import assert from 'node:assert/strict';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DockerDesktopCoordinatorError } from '../src/network/desktop/coordinator/contracts.js';
import type { DockerDesktopCoordinator, DockerDesktopCoordinatorFailure } from '../src/network/desktop/coordinator/contracts.js';
import { desktopCoordinatorLifecycleFixture } from './fixtures/desktopCoordinatorLifecycle.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
test.after(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArchitecture) Object.defineProperty(process, 'arch', originalArchitecture);
});

const { EACCES, EIO, ENOENT, ENOTDIR } = constants.errno;
const missing = { kind: 'journal_invalid', reason: 'missing' } as const;
const corrupt = { kind: 'journal_invalid', reason: 'corrupt' } as const;
const nativeHolderLost = { kind: 'authority_lost', source: 'native_holder' } as const;
const MISSING = 'Docker Desktop coordinator journal invalid (missing): no coordinator store exists for this Engine and macOS account.';
const CORRUPT = 'Docker Desktop coordinator journal invalid (corrupt): the coordinator store is incomplete or unreadable, and the SDK does not repair it.';
const NATIVE_HOLDER_LOST = 'Docker Desktop coordinator authority lost (native_holder).';
type Fixture = Awaited<ReturnType<typeof desktopCoordinatorLifecycleFixture>>;

async function withFixture(scenario: 'normal' | 'bootstrap',
  use: (fixture: Fixture, createOwner: () => DockerDesktopCoordinator) => Promise<void>) {
  const fixture = await desktopCoordinatorLifecycleFixture(scenario);
  const owners: DockerDesktopCoordinator[] = [];
  try {
    await use(fixture, () => {
      const owner = fixture.createOwner();
      owners.push(owner);
      return owner;
    });
  } finally {
    for (const owner of owners) await owner.close().catch(() => {});
    await fixture.close();
  }
}

function rejection(owner: DockerDesktopCoordinator, failure: DockerDesktopCoordinatorFailure, message: string) {
  return (error: unknown) => {
    assert(error instanceof DockerDesktopCoordinatorError);
    assert.equal(error.owner, owner);
    assert.deepEqual(error.failure, failure);
    assert.equal(error.message, message);
    return true;
  };
}

/** Activates, fails the next health check with one native reply, and returns once the generation has fenced. */
async function fenceOnCheck(fixture: Fixture, owner: DockerDesktopCoordinator, reason: string, errno: number) {
  await owner.activate();
  await fixture.failNextCheck(reason, errno);
  const deadline = Date.now() + 5_000;
  while (owner.state.kind !== 'fenced' && Date.now() < deadline) await delay(10);
  assert.equal(owner.state.kind, 'fenced', `the health check must fence after ${reason}`);
  return owner.state.failure;
}

test('an absent store reports missing from activate() and reopenCleanup(), and initialize() then creates it for activation',
  { timeout: 15_000 }, async () => {
    await withFixture('bootstrap', async (fixture, createOwner) => {
      await fixture.failOpening('authority_absent', ENOENT);
      const activating = createOwner();
      await assert.rejects(activating.activate(), rejection(activating, missing, MISSING));
      assert.deepEqual(activating.state, { kind: 'blocked', failure: missing });
      await activating.close();
      assert.deepEqual(activating.state, { kind: 'closed', result: 'never_activated' });

      await fixture.failOpening('authority_absent', ENOENT);
      const cleaning = createOwner();
      await assert.rejects(cleaning.reopenCleanup(), rejection(cleaning, missing, MISSING));
      assert.deepEqual(cleaning.state, { kind: 'blocked', failure: missing });

      await assert.rejects(fixture.current(), { code: 'ENOENT' });
      const recovered = createOwner();
      await recovered.initialize();
      assert.deepEqual(Reflect.get(Object(await fixture.current()), 'generation'),
        { kind: 'clean', generationOrdinal: 0, lastGenerationId: null, settledAtSequence: 0 });
      const authority = await recovered.activate();
      await recovered.close();
      assert.deepEqual(recovered.state, { kind: 'closed', result: 'clean', generation: authority.generation });
    });
  });

test('a partial or unopenable store reports corrupt from initialize(), activate() and reopenCleanup()',
  { timeout: 30_000 }, async () => {
    const methods = {
      initialize: (owner: DockerDesktopCoordinator) => owner.initialize(),
      activate: (owner: DockerDesktopCoordinator) => owner.activate(),
      reopenCleanup: (owner: DockerDesktopCoordinator) => owner.reopenCleanup(),
    };
    const stores = [['authority_partial', ENOENT], ['directory_open', EACCES], ['directory_open', ENOTDIR]] as const;
    await withFixture('normal', async (fixture, createOwner) => {
      for (const [reason, errno] of stores) {
        for (const [name, open] of Object.entries(methods)) {
          await fixture.failOpening(reason, errno);
          const owner = createOwner();
          await assert.rejects(open(owner), rejection(owner, corrupt, CORRUPT), `${name}() after ${reason} (${errno})`);
          assert.deepEqual(owner.state, { kind: 'blocked', failure: corrupt });
        }
      }
    });
  });

test('a running generation fences missing when its store disappears and corrupt when the store becomes unreadable',
  { timeout: 30_000 }, async () => {
    const cases = [['authority_absent', ENOENT, missing, MISSING], ['directory_open', EACCES, corrupt, CORRUPT]] as const;
    for (const [reason, errno, failure, message] of cases) {
      await withFixture('normal', async (fixture, createOwner) => {
        const owner = createOwner();
        assert.deepEqual(await fenceOnCheck(fixture, owner, reason, errno), failure);
        await assert.rejects(owner.close(), rejection(owner, failure, message));
      });
    }
  });

test('every other lost native claim still reports a lost native holder, at opening and while running',
  { timeout: 15_000 }, async () => {
    await withFixture('normal', async (fixture, createOwner) => {
      await fixture.failOpening('lock_stat', EIO);
      const opening = createOwner();
      await assert.rejects(opening.activate(), rejection(opening, nativeHolderLost, NATIVE_HOLDER_LOST));
      assert.deepEqual(opening.state, { kind: 'blocked', failure: nativeHolderLost });

      const running = createOwner();
      assert.deepEqual(await fenceOnCheck(fixture, running, 'authority_stat', EIO), nativeHolderLost);
      await assert.rejects(running.close(), rejection(running, nativeHolderLost, NATIVE_HOLDER_LOST));
    });
  });

test('an Engine replaced since its route authority was prepared reports preparation_invalid without reaching the store',
  { timeout: 15_000 }, async () => {
    const preparationInvalid = { kind: 'preparation_invalid' } as const;
    await withFixture('normal', async (fixture, createOwner) => {
      fixture.setDaemonId('daemon-after-reset');
      const activating = createOwner();
      await assert.rejects(activating.activate(), rejection(activating, preparationInvalid, 'Docker Desktop coordinator preparation invalid.'));
      const cleaning = createOwner();
      await assert.rejects(cleaning.reopenCleanup(), rejection(cleaning, preparationInvalid, 'Docker Desktop coordinator preparation invalid.'));
      assert.deepEqual(await fixture.events(), []);
    });
  });

test('coordinator errors name the failure detail in their message', { timeout: 15_000 }, async () => {
  await withFixture('normal', async (_fixture, createOwner) => {
    const owner = createOwner();
    const cases: readonly (readonly [DockerDesktopCoordinatorFailure, string])[] = [
      [{ kind: 'busy' }, 'Docker Desktop coordinator busy.'],
      [{ kind: 'dirty_generation', generation: 'generation-1' }, 'Docker Desktop coordinator dirty generation (generation-1).'],
      [{ kind: 'identity_conflict', scope: 'endpoint' }, 'Docker Desktop coordinator identity conflict (endpoint).'],
      [{ kind: 'capacity_exhausted', resource: 'members' }, 'Docker Desktop coordinator capacity exhausted (members).'],
      [{ kind: 'interrupted', by: 'deadline', effect: 'not_entered' }, 'Docker Desktop coordinator interrupted (deadline, not_entered).'],
      [{ kind: 'persistence_failed', boundary: 'generation' }, 'Docker Desktop coordinator persistence failed (generation).'],
      [{ kind: 'authority_lost', source: 'native_holder' }, 'Docker Desktop coordinator authority lost (native_holder).'],
      [{ kind: 'journal_invalid', reason: 'substituted' }, 'Docker Desktop coordinator journal invalid (substituted).'],
      [{ kind: 'retained_ownership', members: ['member-1'], pendingTransition: false }, 'Docker Desktop coordinator retained ownership.'],
    ];
    for (const [failure, message] of cases) assert.equal(new DockerDesktopCoordinatorError(failure, owner).message, message);
  });
});
