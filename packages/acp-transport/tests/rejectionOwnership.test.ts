// ------------------------------------------------------------------------------------------------
//                rejectionOwnership.test.ts - ACP rejection response ownership under backpressure
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { AcpClientError, createAcpClient, createAcpExtensionRegistry } from '../src/index.js';
import { createAcpTestHarness, INITIALIZE_PARAMS, INITIALIZE_RESULT, withTestDeadline } from './harness.js';
import { heldPeer } from './fixtures/heldPeer.js';

function hasReason(expected: string) {
  return (error: unknown) => error instanceof AcpClientError && error.reasonCode === expected;
}

test('writer overflow stops synchronous reverse-request admission before the emission returns', async (t) => {
  const stdout = new PassThrough();
  const stdin = new Writable({ write() {} });
  let validations = 0;
  let fatalReason: string | undefined;
  let fatalCalls = 0;
  let reentrantRequest: Promise<unknown> | undefined;
  let reentrantDisposal: Promise<void> | undefined;
  const client = createAcpClient({ stdout, stdin,
    schemaProfile: 'schema-v1.23.0', schemaChannel: 'stable',
    limits: { maxOutboundFrameBytes: 1_024, maxOutboundBufferedBytes: 1_025, shutdownDrainMs: 0 },
    extensions: createAcpExtensionRegistry([{ method: '_ownership/probe', direction: 'inbound_request',
      validateParams() { validations += 1; return true; }, validateResult: () => true }]),
    onFatalError(error) {
      fatalCalls += 1;
      fatalReason = error instanceof AcpClientError ? error.reasonCode : undefined;
      reentrantRequest = client.request('initialize', INITIALIZE_PARAMS);
      void reentrantRequest.catch(() => undefined);
      reentrantDisposal = client.dispose();
    },
  });
  t.after(async () => { await client.dispose(); stdout.destroy(); stdin.destroy(); });
  const frames = Array.from({ length: 1_000 }, (_, id) => JSON.stringify({
    jsonrpc: '2.0', id, method: '_ownership/probe', params: {},
  }) + '\n').join('');
  stdout.write(frames);
  assert.equal(fatalReason, 'acp_outbound_buffer_limit_exceeded');
  assert.ok(validations < 1_000, 'Later frames must not acquire response ownership after writer overflow.');
  const atClosure = validations;
  stdout.emit('data', Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: 'after-close', method: '_ownership/probe', params: {},
  }) + '\n'));
  assert.equal(validations, atClosure);
  assert.equal((await client.closed).kind, 'fatal');
  assert.ok(reentrantRequest);
  await assert.rejects(reentrantRequest, hasReason('acp_client_closed'));
  assert.equal(client.dispose(), reentrantDisposal);
  assert.equal(fatalCalls, 1);
});

test('an oversized rejection closes admission synchronously without submitting an output frame', async (t) => {
  let fatalReason: string | undefined;
  const peer = heldPeer(t, { limits: { maxRequestIdBytes: 1_024, maxOutboundFrameBytes: 1_024, maxOutboundBufferedBytes: 1_025 },
    onFatalError: (error) => { fatalReason = error instanceof AcpClientError ? error.reasonCode : undefined; },
  });
  peer.send({ jsonrpc: '2.0', id: 'x'.repeat(1_000), method: '_unhandled/large-id' });
  assert.equal(fatalReason, 'acp_outbound_frame_too_large');
  assert.equal(peer.stdin.writableLength, 0);
  assert.equal((await peer.client.closed).kind, 'fatal');
});

test('unknown rejection IDs remain reserved until callback and drain settle', async (t) => {
  for (const collision of ['duplicate request', 'opposite response'] as const) {
    await t.test(collision, async (t) => {
      const peer = heldPeer(t);
      peer.send({ jsonrpc: '2.0', id: 'held', method: '_unknown/read', params: {} });
      const write = await withTestDeadline(peer.nextWrite(), 500);
      assert.deepEqual(write.message, { jsonrpc: '2.0', id: 'held',
        error: { code: -32601, message: 'Method not found' } });
      assert.equal(peer.stdin.listenerCount('drain'), 1);
      peer.send(collision === 'duplicate request'
        ? { jsonrpc: '2.0', id: 'held', method: '_unknown/read' }
        : { jsonrpc: '2.0', id: 'held', result: {} });
      const closed = await withTestDeadline(peer.client.closed, 500);
      assert.equal(closed.kind, 'fatal');
      assert.ok(hasReason(collision === 'duplicate request'
        ? 'acp_duplicate_reverse_request_id' : 'acp_request_id_direction_collision')(closed.error));
    });
  }
});

test('unknown requests cannot collide with pending outbound IDs', async (t) => {
  const harness = createAcpTestHarness({ unknownExtensionPolicy: 'standard' });
  t.after(() => harness.client.dispose());
  const pending = harness.client.request('initialize', INITIALIZE_PARAMS);
  const wire = await harness.nextOutbound();
  const rejected = assert.rejects(pending, hasReason('acp_request_id_direction_collision'));
  harness.send({ jsonrpc: '2.0', id: wire.id, method: '_unknown/collision' });
  await rejected;
  assert.ok(hasReason('acp_request_id_direction_collision')((await harness.client.closed).error));
});

test('typed rejection IDs coexist and can be reused after actual write settlement', async (t) => {
  const peer = heldPeer(t);
  peer.send({ jsonrpc: '2.0', id: 1, method: '_unknown/read' });
  const numeric = await withTestDeadline(peer.nextWrite(), 500);
  peer.send({ jsonrpc: '2.0', id: '1', method: '_unknown/read' });
  peer.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 1 } });
  numeric.finish();
  const string = await withTestDeadline(peer.nextWrite(), 500);
  assert.equal(numeric.message.id, 1);
  assert.equal(string.message.id, '1');
  string.finish();
  await nextTurn();
  peer.send({ jsonrpc: '2.0', id: 1, method: '_unknown/read' });
  const reused = await withTestDeadline(peer.nextWrite(), 500);
  assert.deepEqual(reused.message, numeric.message);
  reused.finish();
});

test('disposal settles a backpressured rejection without late handler admission or fatal callbacks', async (t) => {
  let calls = 0;
  let fatals = 0;
  const peer = heldPeer(t, { onFatalError: () => { fatals += 1; },
    extensions: createAcpExtensionRegistry([{ method: '_registered/late', direction: 'inbound_notification', validateParams: () => true }]),
    notificationHandlers: { '_registered/late': () => { calls += 1; } },
  });
  peer.send({ jsonrpc: '2.0', id: 'blocked', method: '_unknown/read' });
  const write = await withTestDeadline(peer.nextWrite(), 500);
  await withTestDeadline(peer.client.dispose(), 500);
  assert.equal((await peer.client.closed).kind, 'disposed');
  assert.equal(peer.stdin.listenerCount('drain'), 0);
  peer.send({ jsonrpc: '2.0', method: '_registered/late', params: {} });
  write.finish();
  await nextTurn();
  assert.equal(calls, 0);
  assert.equal(fatals, 0);
});

for (const profile of [
  { schemaProfile: 'v0.11.4', schemaChannel: 'unstable' },
  { schemaProfile: 'schema-v1.23.0', schemaChannel: 'stable' },
] as const) {
  test(`unknown traffic preserves exact cancellation and full handler capacity (${profile.schemaProfile})`, async (t) => {
    const started = Promise.withResolvers<void>();
    let activeSignal: AbortSignal | undefined;
    const harness = createAcpTestHarness({ ...profile, unknownExtensionPolicy: 'standard',
      limits: { maxInboundRequestConcurrency: 1 },
      reverseRequestHandlers: { 'fs/read_text_file': async ({ signal }) => {
        activeSignal = signal;
        started.resolve();
        await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        return { content: 'unreachable' };
      } },
    });
    t.after(() => harness.client.dispose());
    harness.send({ jsonrpc: '2.0', id: 'active', method: 'fs/read_text_file', params: { sessionId: 's', path: '/tmp/a' } });
    await withTestDeadline(started.promise, 500);
    harness.send({ jsonrpc: '2.0', method: '_unknown/update' });
    harness.send({ jsonrpc: '2.0', id: 'unknown', method: '_unknown/read' });
    assert.deepEqual(await withTestDeadline(harness.nextOutbound(), 500), { jsonrpc: '2.0', id: 'unknown',
      error: { code: -32601, message: 'Method not found' } });
    harness.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'unknown' } });
    assert.equal(activeSignal?.aborted, false);
    harness.send({ jsonrpc: '2.0', id: 'excess', method: 'fs/read_text_file', params: { sessionId: 's', path: '/tmp/b' } });
    assert.deepEqual(await withTestDeadline(harness.nextOutbound(), 500), { jsonrpc: '2.0', id: 'excess',
      error: { code: -32000, message: 'Inbound request limit reached' } });
    harness.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'active' } });
    assert.deepEqual(await withTestDeadline(harness.nextOutbound(), 500), { jsonrpc: '2.0', id: 'active',
      error: { code: -32800, message: 'Request cancelled' } });
    const pending = harness.client.request('initialize', INITIALIZE_PARAMS);
    const wire = await harness.nextOutbound();
    harness.send({ jsonrpc: '2.0', id: wire.id, result: INITIALIZE_RESULT });
    assert.deepEqual(await pending, INITIALIZE_RESULT);
  });
}

for (const kind of ['request', 'notification'] as const) {
  test(`oversized outbound ${kind} retains the public promise error surface`, async (t) => {
    let fatalReason: string | undefined;
    const peer = heldPeer(t, { limits: { maxOutboundFrameBytes: 1_024, maxOutboundBufferedBytes: 1_025 },
      extensions: createAcpExtensionRegistry([{ method: '_outbound/large', direction: `outbound_${kind}`,
        validateParams: () => true, validateResult: () => true }]),
      onFatalError: (error) => { fatalReason = error instanceof AcpClientError ? error.reasonCode : undefined; },
    });
    let pending: Promise<unknown> | undefined;
    assert.doesNotThrow(() => {
      pending = kind === 'request' ? peer.client.request('_outbound/large', { text: 'x'.repeat(2_000) })
        : peer.client.notify('_outbound/large', { text: 'x'.repeat(2_000) });
    });
    assert.equal(fatalReason, 'acp_outbound_frame_too_large');
    assert.ok(pending);
    await assert.rejects(pending, hasReason('acp_outbound_frame_too_large'));
    assert.equal(peer.stdin.writableLength, 0);
  });
}
