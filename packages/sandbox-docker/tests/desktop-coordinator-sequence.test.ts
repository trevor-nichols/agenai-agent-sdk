// ------------------------------------------------------------------------------------------------
//                desktop-coordinator-sequence.test.ts - Bounded admission, entry order and retained work
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopCoordinatorSequence, DesktopCoordinatorSequenceError } from '../src/network/desktop/coordinator/sequence.js';
import type { DesktopCoordinatorSequenceFailure } from '../src/network/desktop/coordinator/sequence.js';

function failure(expected: DesktopCoordinatorSequenceFailure) {
  return (cause: unknown) => {
    assert(cause instanceof DesktopCoordinatorSequenceError);
    assert.deepEqual(cause.failure, expected);
    return true;
  };
}

test('one physical owner prioritizes coalesced health, then cleanup, then ordinary work', async () => {
  const sequence = new DesktopCoordinatorSequence();
  const first = Promise.withResolvers<void>();
  const health = Promise.withResolvers<void>();
  const healthEntered = Promise.withResolvers<void>();
  const entries: string[] = [];
  let concurrent = 0;
  const perform = (name: string, wait: Promise<void> = Promise.resolve()) => async () => {
    concurrent += 1;
    assert.equal(concurrent, 1);
    entries.push(name);
    await wait;
    concurrent -= 1;
    return name;
  };
  const entered = sequence.run('ordinary', perform('entered', first.promise));
  const ordinary = [sequence.run('ordinary', perform('ordinary-1')), sequence.run('ordinary', perform('ordinary-2'))];
  const cleanup = [sequence.run('cleanup', perform('cleanup-1')), sequence.run('cleanup', perform('cleanup-2'))];
  const observation = sequence.run('observation', async () => {
    concurrent += 1; assert.equal(concurrent, 1);
    entries.push('health'); healthEntered.resolve();
    await health.promise; concurrent -= 1;
  });
  const coalescedQueued = sequence.run('observation', async () => { assert.fail('Queued health must coalesce.'); });
  assert.deepEqual(entries, ['entered']);
  first.resolve();
  await healthEntered.promise;
  const coalescedEntered = sequence.run('observation', async () => { assert.fail('Entered health must coalesce.'); });
  health.resolve();
  assert.deepEqual(await Promise.all([entered, ...ordinary, ...cleanup]), ['entered', 'ordinary-1', 'ordinary-2', 'cleanup-1', 'cleanup-2']);
  await Promise.all([observation, coalescedQueued, coalescedEntered]);
  await sequence.settle();
  assert.deepEqual(entries, ['entered', 'health', 'cleanup-1', 'cleanup-2', 'ordinary-1', 'ordinary-2']);
});

test('synchronous admission preserves twelve ordinary and four cleanup slots and rejects without effects', async () => {
  const sequence = new DesktopCoordinatorSequence();
  const release = Promise.withResolvers<void>();
  const entries: string[] = [];
  const entered = sequence.run('ordinary', async () => { entries.push('entered'); await release.promise; });
  const cancelled = new AbortController();
  const ordinary = Array.from({ length: 12 }, (_, index) => sequence.run('ordinary', async () => {
    entries.push(`ordinary-${index}`);
  }, index === 0 ? { signal: cancelled.signal } : undefined));
  const cancellation = assert.rejects(ordinary[0], failure({ kind: 'cancelled' }));
  const refusedOrdinary = assert.rejects(sequence.run('ordinary', async () => { entries.push('refused-ordinary'); }),
    failure({ kind: 'capacity_exhausted', resource: 'ordinary' }));
  const cleanup = Array.from({ length: 4 }, (_, index) => sequence.run('cleanup', async () => { entries.push(`cleanup-${index}`); }));
  const refusedCleanup = assert.rejects(sequence.run('cleanup', async () => { entries.push('refused-cleanup'); }),
    failure({ kind: 'capacity_exhausted', resource: 'queue' }));
  const observation = sequence.run('observation', async () => { entries.push('health'); });
  cancelled.abort();
  const replacement = sequence.run('ordinary', async () => { entries.push('replacement'); });
  await Promise.all([cancellation, refusedOrdinary, refusedCleanup]);
  assert.deepEqual(entries, ['entered']);
  release.resolve();
  await Promise.all([entered, ...ordinary.slice(1), ...cleanup, observation, replacement]);
  await sequence.settle();
  assert.deepEqual(entries, ['entered', 'health', ...Array.from({ length: 4 }, (_, index) => `cleanup-${index}`),
    ...Array.from({ length: 11 }, (_, index) => `ordinary-${index + 1}`), 'replacement']);
  assert.equal(await sequence.run('ordinary', async () => 42), 42);
});

test('cleanup can use all spare caller slots while health remains outside their capacity', async () => {
  const sequence = new DesktopCoordinatorSequence();
  const release = Promise.withResolvers<void>();
  const entered = sequence.run('cleanup', async () => { await release.promise; });
  let dispatched = 0;
  const cleanup = Array.from({ length: 16 }, () => sequence.run('cleanup', async () => { dispatched += 1; }));
  await assert.rejects(sequence.run('cleanup', async () => { assert.fail('Over-capacity cleanup cannot dispatch.'); }),
    failure({ kind: 'capacity_exhausted', resource: 'queue' }));
  const observation = sequence.run('observation', async () => { dispatched += 1; });
  assert.equal(dispatched, 0);
  release.resolve();
  await Promise.all([entered, ...cleanup, observation]);
  assert.equal(dispatched, 17);
});

test('queued cancellation removes work, while entered abort retains its actual result and physical slot', async () => {
  const sequence = new DesktopCoordinatorSequence();
  const preAborted = AbortSignal.abort();
  await assert.rejects(sequence.run('ordinary', async () => { assert.fail('Pre-aborted work cannot dispatch.'); }, { signal: preAborted }),
    failure({ kind: 'cancelled' }));
  const release = Promise.withResolvers<void>();
  const enteredAbort = new AbortController();
  const queuedAbort = new AbortController();
  const actualFailure = new Error('original physical failure');
  const entries: string[] = [];
  const entered = sequence.run('ordinary', async () => { entries.push('entered'); await release.promise; throw actualFailure; },
    { signal: enteredAbort.signal });
  let rejectionObserved = false;
  const observed = entered.catch((cause: unknown) => { rejectionObserved = true; throw cause; });
  const rejected = assert.rejects(observed, (cause: unknown) => cause === actualFailure);
  const queued = sequence.run('ordinary', async () => { assert.fail('Cancelled queued work cannot dispatch.'); }, { signal: queuedAbort.signal });
  const cancellation = assert.rejects(queued, failure({ kind: 'cancelled' }));
  const cleanup = sequence.run('cleanup', async () => {
    assert.equal(rejectionObserved, true, 'The original result observer must run before the next effect enters.');
    entries.push('cleanup'); return 'cleaned';
  });
  const cut = sequence.settle();
  let settled = false;
  void cut.then(() => { settled = true; });
  enteredAbort.abort(); queuedAbort.abort();
  await cancellation;
  assert.equal(settled, false);
  assert.deepEqual(entries, ['entered']);
  release.resolve();
  await rejected;
  assert.equal(await cleanup, 'cleaned');
  await cut;
  assert.deepEqual(entries, ['entered', 'cleanup']);
});

test('settlement frontiers resist later cleanup while fresh health runs once before each captured caller', { timeout: 3000 }, async () => {
  const sequence = new DesktopCoordinatorSequence();
  const release = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  const releaseB = Promise.withResolvers<void>();
  const releaseLate = Promise.withResolvers<void>();
  const releaseLater = Promise.withResolvers<void>();
  const enteredA = Promise.withResolvers<void>();
  const enteredB = Promise.withResolvers<void>();
  const enteredLate = Promise.withResolvers<void>();
  const enteredLater = Promise.withResolvers<void>();
  const entries: string[] = [];
  const initial = sequence.run('ordinary', async () => { entries.push('initial'); await release.promise; });
  const a = sequence.run('ordinary', async () => { entries.push('a'); enteredA.resolve(); await releaseA.promise; });
  const cleanup = sequence.run('cleanup', async () => { entries.push('cleanup'); });
  const b = sequence.run('ordinary', async () => { entries.push('b'); enteredB.resolve(); await releaseB.promise; });
  const cut = sequence.settle();
  const late = sequence.run('ordinary', async () => { entries.push('late'); enteredLate.resolve(); await releaseLate.promise; });
  const secondCut = sequence.settle();
  const later = sequence.run('cleanup', async () => { entries.push('later'); enteredLater.resolve(); await releaseLater.promise; });
  const healthOne = sequence.run('observation', async () => { entries.push('health-1'); });
  release.resolve();
  await enteredA.promise;
  assert.deepEqual(entries, ['initial', 'health-1', 'cleanup', 'a']);
  const healthTwo = sequence.run('observation', async () => { entries.push('health-2'); });
  releaseA.resolve();
  await enteredB.promise;
  assert.deepEqual(entries, ['initial', 'health-1', 'cleanup', 'a', 'health-2', 'b']);
  releaseB.resolve();
  await cut;
  await enteredLate.promise;
  assert.deepEqual(entries, ['initial', 'health-1', 'cleanup', 'a', 'health-2', 'b', 'late']);
  releaseLate.resolve();
  await secondCut;
  await enteredLater.promise;
  assert.deepEqual(entries, ['initial', 'health-1', 'cleanup', 'a', 'health-2', 'b', 'late', 'later']);
  releaseLater.resolve();
  await Promise.all([initial, a, cleanup, b, late, later, healthOne, healthTwo]);
  await sequence.settle();
});
