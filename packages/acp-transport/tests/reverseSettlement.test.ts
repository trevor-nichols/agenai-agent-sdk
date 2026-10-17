// ------------------------------------------------------------------------------------------------
//                reverseSettlement.test.ts - Actual reverse callback and response-write ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import { AcpRequestError, type AcpReverseRequestContext } from '../src/index.js';
import { heldPeer } from './fixtures/heldPeer.js';
import { withTestDeadline } from './harness.js';

const profiles = [
  { schemaProfile: 'v0.11.4', schemaChannel: 'unstable' },
  { schemaProfile: 'schema-v1.23.0', schemaChannel: 'stable' },
] as const;
const read = (id: string | number) => ({ jsonrpc: '2.0', id, method: 'fs/read_text_file',
  params: { sessionId: 'native-session', path: '/workspace/file' } });
const canceled = (requestId: string | number) => ({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId } });
const capacityError = (id: string) => ({ jsonrpc: '2.0', id,
  error: { code: -32000, message: 'Inbound request limit reached' } });

test('reverse settlement spans the original handler and actual response write before capacity and ID reuse', { timeout: 5_000 }, async (t) => {
  for (const profile of profiles) await t.test(profile.schemaProfile, async (t) => {
    const entered = Promise.withResolvers<AcpReverseRequestContext>();
    const answer = Promise.withResolvers<void>();
    const contexts: AcpReverseRequestContext[] = [];
    const peer = heldPeer(t, { ...profile, limits: { maxInboundRequestConcurrency: 1 },
      reverseRequestHandlers: { 'fs/read_text_file': async (context) => {
        contexts.push(context); entered.resolve(context);
        await answer.promise;
        return { content: 'The exact native file.' };
      } },
    });
    t.after(() => { answer.resolve(); });
    peer.send(read('original'));
    const context = await withTestDeadline(entered.promise, 1_000);
    let settled = false;
    void context.settled.then(() => { settled = true; });
    peer.send(read('handler-overflow'));
    const handlerOverflow = await withTestDeadline(peer.nextWrite(), 1_000);
    assert.deepEqual(handlerOverflow.message, capacityError('handler-overflow'));
    assert.deepEqual([settled, contexts.length], [false, 1]);
    handlerOverflow.finish();
    answer.resolve();
    const response = await withTestDeadline(peer.nextWrite(), 1_000);
    assert.deepEqual(response.message, { jsonrpc: '2.0', id: 'original', result: { content: 'The exact native file.' } });
    await nextTurn();
    assert.equal(settled, false);
    peer.send(read('write-overflow'));
    assert.equal(contexts.length, 1);
    response.finish();
    await withTestDeadline(context.settled, 1_000);
    const writeOverflow = await withTestDeadline(peer.nextWrite(), 1_000);
    assert.deepEqual(writeOverflow.message, capacityError('write-overflow'));
    writeOverflow.finish();
    peer.send(read('original'));
    const reused = await withTestDeadline(peer.nextWrite(), 1_000);
    assert.deepEqual(reused.message, response.message);
    assert.equal(contexts.length, 2);
    reused.finish();
    await withTestDeadline(contexts[1]!.settled, 1_000);
    assert.equal(settled, true);
  });
});

test('exact typed cancellation retains the actual handler and cancellation response without a replacement result', { timeout: 5_000 }, async (t) => {
  for (const profile of profiles) await t.test(profile.schemaProfile, async (t) => {
    const entered = Promise.withResolvers<AcpReverseRequestContext>();
    const callback = Promise.withResolvers<void>();
    const contexts: AcpReverseRequestContext[] = [];
    const peer = heldPeer(t, { ...profile, limits: { maxInboundRequestConcurrency: 1 },
      reverseRequestHandlers: { 'fs/read_text_file': async (context) => {
        contexts.push(context); entered.resolve(context);
        if (context.id === 7) {
          await callback.promise;
          throw context.signal.reason;
        }
        return { content: 'The surviving exact callback.' };
      } },
    });
    t.after(() => { callback.resolve(); });
    peer.send(read(7));
    const context = await withTestDeadline(entered.promise, 1_000);
    let settled = false;
    void context.settled.then(() => { settled = true; });
    peer.send(canceled('7'));
    assert.equal(context.signal.aborted, false);
    peer.send(canceled(7));
    assert.equal(context.signal.aborted, true);
    assert.ok(context.signal.reason instanceof AcpRequestError);
    assert.equal(context.signal.reason.reasonCode, 'acp_reverse_request_canceled');
    assert.equal(context.signal.reason.requestId, 7);
    await nextTurn();
    assert.deepEqual([settled, peer.stdin.writableLength], [false, 0]);
    peer.send(read('cancel-overflow'));
    const overflow = await withTestDeadline(peer.nextWrite(), 1_000);
    assert.deepEqual(overflow.message, capacityError('cancel-overflow'));
    assert.equal(contexts.length, 1);
    overflow.finish();
    callback.resolve();
    const response = await withTestDeadline(peer.nextWrite(), 1_000);
    assert.deepEqual(response.message, { jsonrpc: '2.0', id: 7, error: { code: -32800, message: 'Request cancelled' } });
    await nextTurn();
    assert.equal(settled, false);
    response.finish();
    await withTestDeadline(context.settled, 1_000);
    peer.send(read('7'));
    const survivor = await withTestDeadline(peer.nextWrite(), 1_000);
    assert.deepEqual(survivor.message, { jsonrpc: '2.0', id: '7', result: { content: 'The surviving exact callback.' } });
    survivor.finish();
    await withTestDeadline(contexts[1]!.settled, 1_000);
    assert.equal(contexts.length, 2);
  });
});

test('reverse settlement remains pending across zero-drain disposal until the actual handler or write settles', { timeout: 5_000 }, async (t) => {
  for (const obligation of ['handler', 'write success', 'write failure', 'stream close'] as const) await t.test(obligation, async (t) => {
    const entered = Promise.withResolvers<AcpReverseRequestContext>();
    const callback = Promise.withResolvers<void>();
    let fatalCalls = 0;
    const peer = heldPeer(t, { schemaProfile: 'schema-v1.23.0', schemaChannel: 'stable', limits: { shutdownDrainMs: 0 },
      onFatalError() { fatalCalls += 1; },
      reverseRequestHandlers: { 'fs/read_text_file': async (context) => {
        entered.resolve(context);
        if (obligation === 'handler') await callback.promise;
        return { content: 'A response whose actual owner must settle.' };
      } },
    });
    t.after(() => { callback.resolve(); });
    peer.send(read('held'));
    const context = await withTestDeadline(entered.promise, 1_000);
    let settled = false;
    void context.settled.then(() => { settled = true; });
    const write = obligation === 'handler' ? undefined : await withTestDeadline(peer.nextWrite(), 1_000);
    await withTestDeadline(peer.client.dispose(), 1_000);
    assert.equal((await peer.client.closed).kind, 'disposed');
    assert.equal(context.signal.aborted, true);
    await nextTurn();
    assert.equal(settled, false, 'A bounded disposal observation does not join the actual native obligation.');
    if (obligation === 'handler') callback.resolve();
    else if (obligation === 'stream close') peer.stdin.destroy();
    else write!.finish(obligation === 'write failure' ? new Error('The entered write failed after disposal.') : undefined);
    await withTestDeadline(context.settled, 1_000);
    await nextTurn();
    assert.equal(settled, true);
    assert.equal(fatalCalls, 0);
    assert.equal(peer.stdin.listenerCount('error'), 0);
    assert.equal(peer.stdin.listenerCount('close'), 0);
    if (obligation === 'handler') assert.equal(peer.stdin.writableLength, 0);
  });
});
