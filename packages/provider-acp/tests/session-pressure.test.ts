import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRemaining, createSessionPeer, takeUntilRequest } from './fixtures/session-peer.js';
import { collect, events, open, turnInput } from './fixtures/session-runtime.js';
import { fixtureDeferred } from './node-fixtures/host-peer.js';

test('the reverse callback ceiling refuses only the excess request and cancellation settles both retained callbacks while output is stalled', { timeout: 3_000 }, async (t) => {
  const overflow = fixtureDeferred<void>();
  const canceled = fixtureDeferred<void>();
  let cancellations = 0;
  let releases = 0;
  const peer = createSessionPeer({ owned: true, onRelease() { releases += 1; }, onPrompt(peer) {
    peer.batch([
      peer.permission('retained:1', 'tool:1'),
      peer.permission('retained:2', 'tool:2'),
      peer.permission('excess', 'tool:3'),
    ]);
  }, onResolution(_peer, frame) {
    if (frame.id === 'excess') overflow.resolve();
    else if (++cancellations === 2) canceled.resolve();
  } });
  const { registry, session } = await open(peer, { maxPendingRequests: 2, maxQueuedMessages: 8, maxQueuedBytes: 128 * 1_024 });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
  const first = await takeUntilRequest(iterator);
  await overflow.promise;
  assert.deepEqual(peer.frames.filter((frame) => !frame.method), [
    { jsonrpc: '2.0', id: 'excess', error: { code: -32000, message: 'Inbound request limit reached' } },
  ]);
  assert.equal(events(first).filter((event) => event.type === 'request.opened').length, 1);
  if (session.interruption.kind !== 'supported') throw new Error('Expected interruption.');
  assert.deepEqual(await session.interruption.interruptTurn({ turnId: turnInput().turnId, reason: 'user_requested' }), { status: 'canceled' });
  await canceled.promise;
  const remaining = events(await collectRemaining(iterator));
  assert.equal(remaining.filter((event) => event.type === 'request.opened').length, 0);
  assert.deepEqual(remaining.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'canceled' }]);
  assert.deepEqual(peer.frames.filter((frame) => !frame.method).map((frame) => ({ id: frame.id, result: frame.result, error: frame.error })), [
    { id: 'excess', result: undefined, error: { code: -32000, message: 'Inbound request limit reached' } },
    { id: 'retained:1', result: { outcome: { outcome: 'cancelled' } }, error: undefined },
    { id: 'retained:2', result: { outcome: { outcome: 'cancelled' } }, error: undefined },
  ]);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/cancel').length, 1);
  await session.close({ reason: 'shutdown' });
  await session.close({ reason: 'shutdown' });
  assert.equal(releases, 1);
  assert.equal(peer.stdout.listenerCount('data'), 0);
});

test('request byte pressure retires the session below its callback count ceiling and releases its owned connection', { timeout: 3_000 }, async (t) => {
  const released = fixtureDeferred<void>();
  let releases = 0;
  const peer = createSessionPeer({ owned: true, onRelease() { releases += 1; released.resolve(); }, onPrompt(peer) {
    peer.send(peer.permission('retained', 'tool:1'));
  } });
  const { registry, session } = await open(peer, { maxPendingRequests: 4, maxQueuedMessages: 8, maxQueuedBytes: 128 * 1_024 });
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = await takeUntilRequest(iterator);
  const large = peer.permission('over-budget', 'tool:2', 'x'.repeat(40_000));
  assert.ok(Buffer.byteLength(JSON.stringify(large), 'utf8') < 128 * 1_024, 'The request fits the independent transport frame limit.');
  peer.send(large);
  await assert.rejects(collectRemaining(iterator), (error: unknown) => error instanceof Error
    && 'reasonCode' in error && error.reasonCode === 'acp_session_queue_full');
  assert.equal(events(first).filter((event) => event.type === 'request.opened').length, 1);
  assert.equal(events(first).filter((event) => event.type === 'turn.completed').length, 0);
  await assert.rejects(async () => collect(session.startTurn(turnInput('turn:2')).outputs));
  await released.promise;
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  assert.equal(peer.frames.filter((frame) => !frame.method).length, 0);
  assert.equal(releases, 1);
  assert.equal(peer.stdout.listenerCount('data'), 0);
  await session.close({ reason: 'shutdown' });
  assert.equal(releases, 1);
});
