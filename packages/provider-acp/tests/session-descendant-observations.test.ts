import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentEnvironmentId, parseAgentSessionBinding } from '@agen-ai/agent-protocol';
import type { AgentSessionInteraction } from '@agen-ai/agent-runtime';
import { context, fixtureDeferred, posix, sessionInteractionFixture, waitFor } from './fixtures/session-interactions.js';
import { collect, events, open, selection, turnInput } from './fixtures/session-runtime.js';
import { createSessionPeer, takeUntilRequest, collectRemaining } from './fixtures/session-peer.js';

const selected = { mapping: 'grok-build-1.0.60-session-requests-v1' } as const;
const fixtureSource = new URL('./node-fixtures/descendant-observation-peer.mjs', import.meta.url);

test('selected Grok isolates announced child queues, updates and terminals while the parent reader and permission survive', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, { mode: 'isolation', source: fixtureSource });
  let hostCalls = 0;
  const unexpectedHostCall = (): never => { hostCalls += 1; throw new Error('Child observations cannot authorize host callbacks.'); };
  const { adapter } = await fixture.registered({ sessionInteractions: selected, host: {
    readTextFile: unexpectedHostCall, writeTextFile: unexpectedHostCall, createTerminal: unexpectedHostCall, form: unexpectedHostCall,
  } });
  const session = await adapter.createSession(context(fixture.cwd));
  assert.equal(session.collaboration.kind, 'unsupported');
  const execution = session.startTurn(turnInput());
  const iterator = execution.outputs[Symbol.asyncIterator]();
  const first = events(await takeUntilRequest(iterator));
  const permission = first.find((event) => event.type === 'request.opened');
  assert.ok(permission?.type === 'request.opened');
  for (const id of ['child-permission', 'child-read', 'child-write', 'child-terminal', 'child-form']) {
    const denied = await waitFor(() => fixture.frames().find((frame) => frame.id === id), `${id} rejection`);
    assert.equal(denied.error?.code, -32602);
  }
  assert.equal(hostCalls, 0);
  assert.deepEqual(await execution.resolveRequest({ resolution: selection(permission.payload.request) }), { status: 'delivered' });
  const output = [...first, ...events(await collectRemaining(iterator))];
  assert.equal(output.flatMap((event) => event.type === 'content.delta' ? [event.payload.delta] : []).join(''), 'Parent survived.');
  assert.deepEqual(output.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed' }]);
  assert.equal(output.filter((event) => event.type === 'request.opened').length, 1);
  assert.equal(JSON.stringify(output).includes('child-tool'), false);
  assert.equal(session.environment.kind, 'read_and_watch');
  if (session.environment.kind !== 'read_and_watch') throw new Error('Expected session environment observations.');
  const environment = await session.environment.readEnvironment({ environmentId: parseAgentEnvironmentId('fixture:environment'), signal: new AbortController().signal });
  assert.equal(environment.commands.kind, 'not_initialized');
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 1);
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/cancel').length, 0);
  await session.close({ reason: 'idle' });
});

test('exact repeated announcements reserve one child observation and leave parent completion capacity', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, { mode: 'duplicate', source: fixtureSource });
  const { adapter } = await fixture.registered({ sessionInteractions: selected,
    limits: { maxQueuedMessages: 6, maxPendingRequests: 1 } });
  const session = await adapter.createSession(context(fixture.cwd));
  const output = events(await collect(session.startTurn(turnInput()).outputs));
  assert.equal(output.flatMap((event) => event.type === 'content.delta' ? [event.payload.delta] : []).join(''), 'Parent survived.');
  assert.deepEqual(output.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed' }]);
  await session.close({ reason: 'idle' });
});

test('historical and live child prompt identities cannot poison subsequent owned parent continuations', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, { mode: 'continuation', source: fixtureSource });
  const { adapter } = await fixture.registered({ sessionInteractions: selected });
  if (adapter.resumption.kind !== 'supported') throw new Error('Expected selected session resumption.');
  const publications = [fixtureDeferred<AgentSessionInteraction>(), fixtureDeferred<AgentSessionInteraction>()];
  const outputs = [fixtureDeferred<Awaited<ReturnType<typeof collect>>>(), fixtureDeferred<Awaited<ReturnType<typeof collect>>>()];
  let requests = 0;
  let executions = 0;
  const session = await adapter.resumption.resumeSession({ ...context(fixture.cwd),
    binding: parseAgentSessionBinding({ conversationId: 'controlled-native-session' }),
    interactions: { onRequest(handle) { publications[requests++]!.resolve(handle); } },
    nativeContinuations: { onExecution(continuation) {
      const completion = outputs[executions++]!;
      void collect(continuation.execution.outputs).then(completion.resolve, (cause: unknown) => completion.reject(cause instanceof Error ? cause : new Error(String(cause))));
    } },
  });
  for (let index = 0; index < 2; index += 1) {
    const handle = await publications[index]!.promise;
    const request = handle.request;
    if (request.kind !== 'plan_review') throw new Error('Expected parent plan review.');
    assert.deepEqual(await handle.respond({ kind: 'plan_review', choiceId: request.choices[0].choiceId,
      planId: request.plan.planId, revision: request.plan.revision, action: 'approve' }), { status: 'delivered' });
    const output = events(await outputs[index]!.promise);
    assert.equal(output.flatMap((event) => event.type === 'content.delta' ? [event.payload.delta] : []).join(''), `Parent continuation ${index + 1}.`);
    assert.deepEqual(output.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed' }]);
    if (index === 0) fixture.signal();
  }
  assert.equal(executions, 2);
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 0);
  await session.close({ reason: 'idle' });
});

for (const conflict of [false, true]) test(`child observation identities remain reserved across child and parent terminals${conflict ? ' and reject rebinding' : ''}`, posix, async (t) => {
  const fixture = sessionInteractionFixture(t, { mode: conflict ? 'retention-conflict' : 'retention', source: fixtureSource });
  const { adapter } = await fixture.registered({ sessionInteractions: selected });
  const session = await adapter.createSession(context(fixture.cwd));
  await collect(session.startTurn(turnInput()).outputs);
  const next = collect(session.startTurn(turnInput('turn:2')).outputs);
  if (conflict) {
    await assert.rejects(next, (cause: unknown) => cause instanceof Error && 'reasonCode' in cause && cause.reasonCode === 'acp_descendant_identity_conflict');
    await assert.rejects(async () => session.close({ reason: 'shutdown' }));
  } else {
    assert.deepEqual(events(await next).filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed' }]);
    await session.close({ reason: 'idle' });
  }
});

test('load-time historical spawn records cannot authorize live child traffic after opening', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, { mode: 'history-live', source: fixtureSource });
  const { adapter } = await fixture.registered({ sessionInteractions: selected });
  if (adapter.resumption.kind !== 'supported') throw new Error('Expected selected session resumption.');
  const session = await adapter.resumption.resumeSession({ ...context(fixture.cwd),
    binding: parseAgentSessionBinding({ conversationId: 'controlled-native-session' }), interactions: { onRequest() {} } });
  await assert.rejects(collect(session.startTurn(turnInput()).outputs), (cause: unknown) => cause instanceof Error
    && 'reasonCode' in cause && cause.reasonCode === 'acp_session_identity_mismatch');
  await assert.rejects(async () => session.close({ reason: 'shutdown' }));
});

test('discarded historical child observations remain inside the opening replay budget', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, { mode: 'history-pressure', source: fixtureSource });
  const { adapter } = await fixture.registered({ sessionInteractions: selected, limits: { maxQueuedMessages: 4, maxPendingRequests: 1 } });
  const resumption = adapter.resumption;
  if (resumption.kind !== 'supported') throw new Error('Expected selected session resumption.');
  await assert.rejects(async () => resumption.resumeSession({ ...context(fixture.cwd),
    binding: parseAgentSessionBinding({ conversationId: 'controlled-native-session' }), interactions: { onRequest() {} } }),
  (cause: unknown) => cause instanceof Error && 'reasonCode' in cause && cause.reasonCode === 'acp_history_limit_exceeded');
  assert.equal(fixture.frames().find((frame) => frame.id === 'history-barrier')?.error?.code, -32601);
});

for (const [mode, reasonCode] of [
  ['foreign-extension', 'acp_session_identity_mismatch'], ['foreign-standard', 'acp_session_identity_mismatch'],
  ['child-conflict', 'acp_descendant_identity_conflict'], ['subagent-conflict', 'acp_descendant_identity_conflict'],
  ['attempt-conflict', 'acp_descendant_identity_conflict'], ['wrong-parent', 'acp_descendant_identity_invalid'],
  ['root-alias', 'acp_descendant_identity_invalid'], ['missing-identity', 'acp_descendant_identity_invalid'],
  ['identity-byte-pressure', 'acp_descendant_identity_invalid'], ['nested', 'acp_descendant_nested_unsupported'],
  ['unknown-extension', 'acp_session_identity_mismatch'], ['tool-text', 'acp_session_identity_mismatch'],
  ['permission-metadata', 'acp_session_identity_mismatch'], ['child-queue-invalid', 'acp_descendant_identity_invalid'],
  ['replay-live', 'acp_session_identity_mismatch'], ['replay-revive', 'acp_descendant_identity_conflict'],
  ['replay-marker-invalid', 'acp_descendant_replay_invalid'], ['count-pressure', 'acp_session_state_full'],
  ['byte-pressure', 'acp_session_state_full'],
] as const) test(`selected child observation ${mode} fails closed on the parent reader`, posix, async (t) => {
  const fixture = sessionInteractionFixture(t, { mode, source: fixtureSource });
  const { adapter } = await fixture.registered({ sessionInteractions: selected,
    ...(mode === 'count-pressure' ? { limits: { maxQueuedMessages: 4, maxPendingRequests: 1 } }
      : mode === 'byte-pressure' ? { limits: { maxQueuedBytes: 128 * 1_024 } } : {}) });
  const session = await adapter.createSession(context(fixture.cwd));
  await assert.rejects(collect(session.startTurn(turnInput()).outputs), (cause: unknown) => cause instanceof Error
    && 'reasonCode' in cause && cause.reasonCode === reasonCode);
  await assert.rejects(async () => session.close({ reason: 'shutdown' }), (cause: unknown) => cause instanceof Error
    && 'reasonCode' in cause && cause.reasonCode === reasonCode);
});

test('unselected ACP sessions continue rejecting foreign standard updates after discarded underscore announcements', { timeout: 3_000 }, async (t) => {
  const peer = createSessionPeer({ onPrompt(peer) {
    peer.batch([
      { jsonrpc: '2.0', method: '_x.ai/session_notification', params: { sessionId: peer.sessionId,
        update: { sessionUpdate: 'subagent_spawned', parent_session_id: peer.sessionId, child_session_id: 'foreign', subagent_id: 'foreign' } } },
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'foreign',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Foreign output' } } } },
    ]);
  } });
  const { registry, session } = await open(peer);
  t.after(async () => { await registry.dispose(); peer.dispose(); });
  await assert.rejects(collect(session.startTurn(turnInput()).outputs), (cause: unknown) => cause instanceof Error
    && 'reasonCode' in cause && cause.reasonCode === 'acp_session_identity_mismatch');
  await session.close({ reason: 'shutdown' });
});
