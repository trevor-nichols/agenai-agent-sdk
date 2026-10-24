import assert from 'node:assert/strict';
import test from 'node:test';
import { collectRemaining, createSessionPeer, takeUntilRequest } from './fixtures/session-peer.js';
import { events, open, selection, turnInput } from './fixtures/session-runtime.js';
import { fixtureDeferred } from './node-fixtures/host-peer.js';

test('exact active and queued ACP cancellation preserves surviving FIFO requests and the original output reader', { timeout: 3_000 }, async (t) => {
  const canceled = fixtureDeferred<void>();
  let cancellations = 0;
  const peer = createSessionPeer({ onPrompt(peer) {
    peer.batch([peer.permission('active:A', 'tool:A'), peer.permission(7, 'tool:B'), peer.permission('survivor:C', 'tool:C')]);
  }, onResolution(peer, frame) {
    if (frame.error?.code === -32800 && ++cancellations === 2) canceled.resolve();
    if (frame.id === 'survivor:C') peer.complete();
  } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = events(await takeUntilRequest(iterator));
  const active = first.find((event) => event.type === 'request.opened');
  assert.ok(active?.type === 'request.opened');
  peer.batch([
    { jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: '7' } },
    { jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 7 } },
    { jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'active:A' } },
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Output survives cancellation.' } }),
  ]);
  const [, nextOutputs] = await Promise.all([canceled.promise, takeUntilRequest(iterator)]);
  const next = events(nextOutputs);
  const survivor = next.find((event) => event.type === 'request.opened');
  assert.ok(survivor?.type === 'request.opened');
  assert.deepEqual(next.filter((event) => event.type === 'request.unavailable').map((event) => event.payload), [
    { requestId: active.payload.request.requestId, reason: 'withdrawn' },
  ]);
  assert.ok(next.findIndex((event) => event.type === 'request.unavailable') < next.findIndex((event) => event.type === 'request.opened'));
  await assert.rejects(execution.resolveRequest({ resolution: selection(active.payload.request) }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'request_resolution_mismatch');
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(survivor.payload.request) }), { status: 'delivered' });
  const finished = events(await collectRemaining(iterator));
  assert.deepEqual(finished.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed', structuredOutput: { kind: 'not_requested' } }]);
  assert.equal([...first, ...next, ...finished].filter((event) => event.type === 'request.opened').length, 2);
  assert.equal([...first, ...next, ...finished].flatMap((event) => event.type === 'content.delta' ? [event.payload.delta] : []).join(''),
    'Output survives cancellation.');
  assert.deepEqual(peer.frames.filter((frame) => !frame.method && frame.result !== undefined).map((frame) => frame.id), ['survivor:C']);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/cancel').length, 0);
});

test('answered reverse callbacks retain capacity until the actual response write settles', { timeout: 3_000 }, async (t) => {
  const overflow = fixtureDeferred<void>();
  const peer = createSessionPeer({ onPrompt(peer) { peer.send(peer.permission('A', 'tool:A')); }, onResolution(peer, frame) {
    if (frame.id === 'overflow') overflow.resolve();
    if (frame.id === 'C' && frame.result !== undefined) peer.complete();
  } });
  const { registry, session } = await open(peer, { maxPendingRequests: 1 });
  t.after(async () => { peer.stdin.uncork(); await registry.dispose(); peer.dispose(); });
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = events(await takeUntilRequest(iterator));
  const a = first.find((event) => event.type === 'request.opened');
  assert.ok(a?.type === 'request.opened');
  peer.stdin.cork();
  const receipt = execution.resolveRequest({ resolution: selection(a.payload.request) });
  peer.batch([{ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'A' } }, peer.permission('overflow', 'tool:B')]);
  assert.deepEqual(await receipt, { status: 'delivered' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  peer.stdin.uncork();
  await overflow.promise;
  assert.deepEqual(peer.frames.find((frame) => frame.id === 'overflow')?.error, { code: -32000, message: 'Inbound request limit reached' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  peer.send(peer.permission('C', 'tool:C'));
  const next = events(await takeUntilRequest(iterator));
  const c = next.find((event) => event.type === 'request.opened');
  assert.ok(c?.type === 'request.opened');
  assert.deepEqual(next.filter((event) => event.type === 'request.unavailable').map((event) => event.payload), [
    { requestId: a.payload.request.requestId, reason: 'withdrawn' },
  ]);
  assert.deepEqual(peer.frames.filter((frame) => frame.id === 'A').map((frame) => frame.result), [
    { outcome: { outcome: 'selected', optionId: 'A:allow' } },
  ]);
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(c.payload.request) }), { status: 'delivered' });
  assert.deepEqual(events(await collectRemaining(iterator)).filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed', structuredOutput: { kind: 'not_requested' } }]);
});
