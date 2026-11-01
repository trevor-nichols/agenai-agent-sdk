import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DesktopCoordinatorHolder, DesktopCoordinatorHolderError } from '../src/node/desktopCoordinatorHolder.js';
import { openPreparedExecutable } from '../src/node/preparedExecutable.js';
import { coordinatorHolderPeer } from './fixtures/desktopCoordinatorHolder.js';
import type { HolderPeerScenario } from './fixtures/desktopCoordinatorHolder.js';

async function withHolder(scenario: HolderPeerScenario,
  use: (context: Readonly<{ holder: DesktopCoordinatorHolder; peer: Awaited<ReturnType<typeof coordinatorHolderPeer>>;
    losses: DesktopCoordinatorHolderError[]; lost: Promise<DesktopCoordinatorHolderError>; verifyExecutable: () => Promise<void> }>) => Promise<void>,
  gateExit = false) {
  const peer = await coordinatorHolderPeer(scenario, gateExit);
  const prepared = await openPreparedExecutable(peer.executable);
  const losses: DesktopCoordinatorHolderError[] = [];
  const lost = Promise.withResolvers<DesktopCoordinatorHolderError>();
  const holder = new DesktopCoordinatorHolder(peer.executable.path, 'open', 'a'.repeat(64), prepared,
    (error) => { losses.push(error); lost.resolve(error); });
  try { await use({ holder, peer, losses, lost: lost.promise, verifyExecutable: () => prepared.verify() }); }
  finally {
    await peer.releaseExit();
    await holder.close().catch(() => {});
    await peer.remove();
  }
}

test('Desktop holder serializes exact UTF8 frames, validates fragmented replies and joins process exit before closing its prepared descriptor',
  { timeout: 10_000 }, async () => {
    await withHolder('normal', async ({ holder, peer, losses, verifyExecutable }) => {
      const opened = await holder.opened;
      assert.equal(opened.initial, 'existing'); assert.equal(holder.claimed, true);
      for (const invalid of ['', '\ud800', 'a'.repeat(1_048_429)]) await assert.rejects(holder.commit(invalid), TypeError);
      const text = JSON.stringify({ member: '雪🌱', lines: 'one\ntwo' });
      await Promise.all([holder.commit(text), holder.check()]);
      const snapshot = await holder.read();
      assert.equal(snapshot.text, text);
      assert.equal(snapshot.digest, createHash('sha256').update(text).digest('hex'));
      const commands = await peer.events();
      assert.deepEqual(commands.filter((entry) => entry.event !== 'started').map((entry) => entry.event), ['COMMIT', 'CHECK', 'READ']);
      const commit = commands.find((entry) => entry.event === 'COMMIT');
      assert.equal(commit?.text, text); assert.equal(commit.bytes, Buffer.byteLength(text));
      assert.equal(commit.declaredBytes, Buffer.byteLength(text));
      assert.equal(commands[0]?.mode, 'open'); assert.equal(commands[0]?.engineKey, 'a'.repeat(64));
      let closed = false;
      const closing = holder.close().then(() => { closed = true; });
      const sameClose = holder.close();
      await peer.waitFor('closed_reply'); await turn();
      assert.equal(closed, false, 'A native close receipt must not release the process join or executable descriptor.');
      await verifyExecutable();
      await peer.releaseExit(); await Promise.all([closing, sameClose]);
      assert.equal(holder.claimed, false); assert.deepEqual(losses, []);
      await assert.rejects(verifyExecutable(), { code: 'EBADF' });
      assert((await peer.events()).some((entry) => entry.event === 'exiting'));
    }, true);
  });

test('Desktop holder retains claim after held storage failure and reads the exact publication before cleanup and joined close',
  { timeout: 10_000 }, async () => {
    await withHolder('held_commit', async ({ holder, peer, losses, verifyExecutable }) => {
      await holder.opened;
      const text = JSON.stringify({ sequence: 4, member: 'original' });
      await assert.rejects(holder.commit(text), { name: 'DesktopCoordinatorHolderError', reason: 'publication_sync', claim: 'held' });
      assert.equal(holder.claimed, true);
      assert.equal((await holder.read()).text, text);
      await assert.rejects(holder.check(), { name: 'DesktopCoordinatorHolderError', reason: 'storage_fenced', claim: 'held' });
      assert.equal(holder.claimed, true);
      await holder.enterCleanup();
      const cleanupText = JSON.stringify({ sequence: 5, state: 'cleanup_only' });
      await holder.commit(cleanupText);
      assert.equal((await holder.read()).text, cleanupText);
      await holder.close(); await assert.rejects(verifyExecutable(), { code: 'EBADF' });
      assert.deepEqual(losses, []);
      assert.deepEqual((await peer.events()).filter((entry) => entry.event !== 'started' && entry.event !== 'exiting' && entry.event !== 'closed_reply')
        .map((entry) => entry.event), ['COMMIT', 'READ', 'CHECK', 'CLEANUP', 'COMMIT', 'READ', 'CLOSE']);
    });
  });

const faults: readonly Readonly<{ scenario: HolderPeerScenario; operation: 'open' | 'check' | 'read' | 'commit' | 'close'; reason: string }>[] = [
  { scenario: 'unsolicited_open', operation: 'open', reason: 'unsolicited_response' },
  { scenario: 'wrong_check', operation: 'check', reason: 'check_response' },
  { scenario: 'malformed_check', operation: 'check', reason: 'invalid_response' },
  { scenario: 'utf8_check', operation: 'check', reason: 'invalid_response' },
  { scenario: 'oversized_check', operation: 'check', reason: 'response_capacity' },
  { scenario: 'bad_read_digest', operation: 'read', reason: 'snapshot_response' },
  { scenario: 'bad_commit_digest', operation: 'commit', reason: 'commit_response' },
  { scenario: 'unsolicited_check', operation: 'check', reason: 'unsolicited_response' },
  { scenario: 'diagnostic_check', operation: 'check', reason: 'unexpected_diagnostic' },
  { scenario: 'lost_check', operation: 'check', reason: 'root_substituted' },
  { scenario: 'truncated_check', operation: 'check', reason: 'process_closed' },
  { scenario: 'missing_close', operation: 'close', reason: 'process_closed' },
];

test('joined unexpected holder exit releases its prepared descriptor while retaining the original claim loss',
  { timeout: 10_000 }, async () => {
    await withHolder('normal', async ({ holder, peer, lost, losses, verifyExecutable }) => {
      await holder.opened;
      await verifyExecutable();
      const original = await peer.waitFor('started');
      assert(original.pid !== undefined);
      process.kill(original.pid, 'SIGKILL');
      const failure = await lost;
      assert.equal(failure.reason, 'process_closed');
      assert.equal(holder.claimed, false);
      const deadline = Date.now() + 1_000;
      for (;;) {
        try { await verifyExecutable(); }
        catch (cause) {
          assert(cause instanceof Error && 'code' in cause && cause.code === 'EBADF');
          break;
        }
        if (Date.now() >= deadline) assert.fail('The joined native process retained its prepared executable descriptor.');
        await delay(5);
      }
      await assert.rejects(holder.read(), (cause) => cause === failure);
      await assert.rejects(holder.check(), (cause) => cause === failure);
      await assert.rejects(holder.close(), (cause) => cause === failure);
      assert.deepEqual(losses, [failure]);
    });
  });

for (const fault of faults) {
  test(`Desktop holder fences ${fault.scenario} and preserves its original loss through joined close`, { timeout: 10_000 }, async () => {
    await withHolder(fault.scenario, async ({ holder, peer, losses, lost, verifyExecutable }) => {
      if (fault.operation !== 'open') await holder.opened;
      const operation = fault.operation === 'open' ? holder.opened
        : fault.operation === 'commit' ? holder.commit('{"sequence":1}') : holder[fault.operation]();
      const result = await Promise.allSettled([operation]);
      const failure = await lost;
      assert.equal(failure.reason, fault.reason); assert.equal(failure.claim, 'lost');
      assert.equal(holder.claimed, false); assert.deepEqual(losses, [failure]);
      assert.equal(result[0]?.status, 'rejected', 'An entered command cannot succeed after protocol loss in its reply batch.');
      const commands = (await peer.events()).filter((entry) => /^[A-Z_]+$/u.test(entry.event));
      await assert.rejects(holder.read(), (error) => error === failure);
      await assert.rejects(holder.commit('{"sequence":2}'), (error) => error === failure);
      assert.deepEqual((await peer.events()).filter((entry) => /^[A-Z_]+$/u.test(entry.event)), commands,
        'A fenced owner cannot send further storage commands.');
      await assert.rejects(holder.close(), (error) => error === failure);
      await assert.rejects(verifyExecutable(), { code: 'EBADF' });
      assert.equal(losses.length, 1);
    });
  });
}
