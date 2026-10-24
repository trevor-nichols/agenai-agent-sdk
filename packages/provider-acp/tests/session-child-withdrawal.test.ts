import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { AgentProviderOutput } from '@agen-ai/agent-runtime';
import type { AcpProviderLimits } from '../src/index.js';
import { assertProcessGone, context, posix, sessionInteractionFixture, waitFor } from './fixtures/session-interactions.js';
import { collectRemaining, takeUntilRequest } from './fixtures/session-peer.js';
import { collect, events, selection, turnInput } from './fixtures/session-runtime.js';

const selected = { mapping: 'grok-build-1.0.60-session-requests-v1' } as const;
const source = new URL('./node-fixtures/child-withdrawal-peer.mjs', import.meta.url);
async function openChildFixture(t: TestContext, mode: string, limits?: Partial<AcpProviderLimits>) {
  const fixture = sessionInteractionFixture(t, { mode, source });
  const { adapter } = await fixture.registered({ sessionInteractions: selected, limits });
  const session = await adapter.createSession(context(fixture.cwd));
  return { fixture, session };
}
const barrier = async (fixture: ReturnType<typeof sessionInteractionFixture>, id = 'facts-barrier') => {
  const response = await waitFor(() => fixture.frames().find((frame) => frame.id === id), `${id} acknowledgement`);
  assert.equal(response.error?.code, -32601);
};

test('the exact live child resolution and canceled root finish withdraw its root-routed permission without protocol cancellation', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, { mode: 'active', source });
  const { adapter } = await fixture.registered({ sessionInteractions: selected });
  const session = await adapter.createSession(context(fixture.cwd));
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = events(await takeUntilRequest(iterator));
  const active = first.find((event) => event.type === 'request.opened');
  assert.ok(active?.type === 'request.opened');
  fixture.signal();
  const withdrawn = await waitFor(() => fixture.frames().find((frame) => frame.id === 'child-permission'), 'withdrawn child callback');
  assert.equal(withdrawn.error?.code, -32800);
  assert.equal(withdrawn.result, undefined);
  const after = events(await takeUntilRequest(iterator));
  const survivor = after.find((event) => event.type === 'request.opened');
  assert.ok(survivor?.type === 'request.opened');
  assert.deepEqual(after.filter((event) => event.type === 'request.unavailable').map((event) => event.payload), [
    { requestId: active.payload.request.requestId, reason: 'withdrawn' },
  ]);
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(survivor.payload.request) }), { status: 'delivered' });
  const tail = events(await collectRemaining(iterator));
  assert.deepEqual(tail.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed', structuredOutput: { kind: 'not_requested' } }]);
  assert.equal(tail.flatMap((event) => event.type === 'content.delta' ? [event.payload.delta] : []).join(''), 'Surviving parent output.');
  assert.equal(fixture.frames('outbound').some((frame) => frame.method === '$/cancel_request'), false);
  assert.equal(fixture.frames().some((frame) => frame.method === 'session/cancel'), false);
  await session.close({ reason: 'idle' });
});

test('the composite child cancellation removes an unseen queued permission while preserving its active parent request', posix, async (t) => {
  const { fixture, session } = await openChildFixture(t, 'queued');
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = events(await takeUntilRequest(iterator));
  const active = first.find((event) => event.type === 'request.opened');
  assert.ok(active?.type === 'request.opened');
  fixture.signal();
  const withdrawn = await waitFor(() => fixture.frames().find((frame) => frame.id === 'child-permission'), 'queued child callback rejection');
  assert.equal(withdrawn.error?.code, -32800);
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(active.payload.request) }), { status: 'delivered' });
  const output = events(await collectRemaining(iterator));
  assert.equal(output.filter((event) => event.type === 'request.opened' || event.type === 'request.unavailable').length, 0);
  assert.deepEqual(output.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed', structuredOutput: { kind: 'not_requested' } }]);
  await session.close({ reason: 'idle' });
});

test('answer entry during the resolved-to-finished gap waits and returns one truthful refusal without writing a native answer', posix, async (t) => {
  const { fixture, session } = await openChildFixture(t, 'gap');
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = events(await takeUntilRequest(iterator));
  const active = first.find((event) => event.type === 'request.opened');
  assert.ok(active?.type === 'request.opened');
  fixture.signal();
  await barrier(fixture, 'resolved-barrier');
  let settled = false;
  const receipt = execution.resolveRequest({ resolution: selection(active.payload.request) });
  void receipt.then(() => { settled = true; }, () => { settled = true; });
  fixture.signal();
  await barrier(fixture, 'gap-barrier');
  assert.equal(settled, false);
  assert.equal(fixture.frames().some((frame) => frame.id === 'child-permission'), false);
  fixture.signal();
  const result = await receipt;
  assert.equal(result.status, 'rejected');
  if (result.status !== 'rejected') throw new Error('Expected unavailable native answer refusal.');
  assert.equal(result.requestState, 'unavailable');
  const after = events(await takeUntilRequest(iterator));
  const survivor = after.find((event) => event.type === 'request.opened');
  assert.ok(survivor?.type === 'request.opened');
  assert.equal(after.filter((event) => event.type === 'request.unavailable').length, 1);
  await waitFor(() => fixture.frames().find((frame) => frame.id === 'child-permission'), 'corroborated child callback rejection');
  assert.deepEqual(fixture.frames().filter((frame) => frame.id === 'child-permission').map((frame) => ({ result: frame.result, code: frame.error?.code })), [
    { result: undefined, code: -32800 },
  ]);
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(survivor.payload.request) }), { status: 'delivered' });
  await collectRemaining(iterator);
  await session.close({ reason: 'idle' });
});

test('a permission answer entered before the native facts keeps its delivered receipt and surviving execution', posix, async (t) => {
  const { session } = await openChildFixture(t, 'entered');
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = events(await takeUntilRequest(iterator));
  const active = first.find((event) => event.type === 'request.opened');
  assert.ok(active?.type === 'request.opened');
  const receipt = await execution.resolveRequest({ resolution: selection(active.payload.request) });
  assert.deepEqual(receipt, { status: 'delivered' });
  const next = events(await takeUntilRequest(iterator));
  const survivor = next.find((event) => event.type === 'request.opened');
  assert.ok(survivor?.type === 'request.opened');
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(survivor.payload.request) }), { status: 'delivered' });
  const tail = events(await collectRemaining(iterator));
  assert.deepEqual(tail.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed', structuredOutput: { kind: 'not_requested' } }]);
  assert.deepEqual(receipt, { status: 'delivered' });
  await session.close({ reason: 'idle' });
});

for (const mode of ['no-precursor', 'wrong-requester', 'wrong-tool', 'wrong-kind', 'missing-attempt', 'replay-pending', 'turn-terminal-only']) {
  test(`${mode} cannot withdraw a root callback from unproven child facts`, posix, async (t) => {
    const { fixture, session } = await openChildFixture(t, mode);
    const execution = session.startTurn(turnInput());
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const first = events(await takeUntilRequest(iterator));
    const active = first.find((event) => event.type === 'request.opened');
    assert.ok(active?.type === 'request.opened');
    fixture.signal();
    await barrier(fixture);
    assert.equal(fixture.frames().some((frame) => frame.id === 'child-permission'), false);
    assert.deepEqual(await execution.resolveRequest({ resolution: selection(active.payload.request) }), { status: 'delivered' });
    const tail = events(await collectRemaining(iterator));
    assert.equal(tail.filter((event) => event.type === 'request.unavailable').length, 0);
    assert.deepEqual(tail.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed', structuredOutput: { kind: 'not_requested' } }]);
    await session.close({ reason: 'idle' });
  });
}

for (const [mode, reasonCode] of [
  ['generic-resolved', 'acp_native_permission_uncertain'], ['completed', 'acp_native_permission_uncertain'],
  ['root-resolution', 'acp_native_permission_uncertain'], ['foreign-resolution', 'acp_native_permission_uncertain'],
  ['finish-before-resolved', 'acp_native_permission_uncertain'], ['replay-resolved', 'acp_native_permission_uncertain'],
  ['replay-finish', 'acp_native_permission_uncertain'], ['attempt-mismatch', 'acp_native_permission_identity_conflict'],
  ['subagent-mismatch', 'acp_native_permission_identity_conflict'],
] as const) test(`${mode} fences the original execution without manufacturing native withdrawal`, posix, async (t) => {
  const { fixture, session } = await openChildFixture(t, mode, { cancellationTimeoutMs: 100 });
  const iterator = session.startTurn(turnInput()).outputs[Symbol.asyncIterator]();
  await takeUntilRequest(iterator);
  const output: AgentProviderOutput[] = [];
  fixture.signal();
  await assert.rejects(async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      output.push(next.value);
    }
  }, (cause: unknown) => cause instanceof Error && 'reasonCode' in cause && cause.reasonCode === reasonCode);
  assert.equal(events(output).filter((event) => event.type === 'request.unavailable').length, 0);
  assert.equal(fixture.frames().some((frame) => frame.id === 'child-permission' && frame.error?.code === -32800), false);
  await assert.rejects(async () => session.close({ reason: 'shutdown' }));
});

for (const [mode, reasonCode, limits] of [
  ['pre-resolved', 'acp_native_permission_stale', {}], ['pre-finished', 'acp_native_permission_stale', {}],
  ['census-count', 'acp_session_state_full', { maxQueuedMessages: 4, maxPendingRequests: 1 }],
  ['census-byte', 'acp_session_state_full', { maxQueuedMessages: 1_024, maxQueuedBytes: 128 * 1_024 }],
] as const) test(`${mode} cannot create future callback authority outside the shared census budget`, posix, async (t) => {
  const { session } = await openChildFixture(t, mode, limits);
  await assert.rejects(collect(session.startTurn(turnInput()).outputs), (cause: unknown) => cause instanceof Error
    && 'reasonCode' in cause && cause.reasonCode === reasonCode);
  await assert.rejects(async () => session.close({ reason: 'shutdown' }));
});

test('settled child tool identities cannot attach to a new callback in a later parent turn', posix, async (t) => {
  const { session } = await openChildFixture(t, 'reuse-next-turn');
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = events(await takeUntilRequest(iterator));
  const active = first.find((event) => event.type === 'request.opened');
  assert.ok(active?.type === 'request.opened');
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(active.payload.request) }), { status: 'delivered' });
  await collectRemaining(iterator);
  await assert.rejects(collect(session.startTurn(turnInput('turn:2')).outputs), (cause: unknown) => cause instanceof Error
    && 'reasonCode' in cause && cause.reasonCode === 'acp_native_permission_stale');
  await assert.rejects(async () => session.close({ reason: 'shutdown' }));
});

test('closing a selected live session with displayed and queued callbacks stops its owned producer without reporting client disposal as a runtime failure', posix, async (t) => {
  for (const peerState of ['running', 'stopped'] as const) await t.test(peerState, async (t) => {
    const { fixture, session } = await openChildFixture(t, 'close-pending');
    const execution = session.startTurn(turnInput());
    const iterator = execution.outputs[Symbol.asyncIterator]();
    const first = events(await takeUntilRequest(iterator));
    const request = first.find((event) => event.type === 'request.opened');
    assert.ok(request?.type === 'request.opened');
    await barrier(fixture, 'callbacks-live');
    assert.equal(fixture.frames('outbound').filter((frame) => frame.method === 'session/request_permission').length, 2);
    const pid = fixture.pid();
    if (peerState === 'stopped') process.kill(pid, 'SIGSTOP');
    await session.close({ reason: 'shutdown' });
    await session.close({ reason: 'shutdown' });
    assertProcessGone(pid);
    await assert.rejects(iterator.next(), { name: 'AbortError' });
    await assert.rejects(execution.resolveRequest({ resolution: selection(request.payload.request) }), { code: 'session_closed' });
  });
});
