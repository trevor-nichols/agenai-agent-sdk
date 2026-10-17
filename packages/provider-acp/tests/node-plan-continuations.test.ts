import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentSessionBinding, type AgentSessionPlanReviewRequest } from '@agen-ai/agent-protocol';
import type { AgentNativeContinuation, AgentProviderSession, AgentSessionInteraction } from '@agen-ai/agent-runtime';
import { assertProcessGone, context, fixtureDeferred, posix, sessionInteractionFixture, waitFor } from './fixtures/session-interactions.js';
import { collect, events, turnInput } from './fixtures/session-runtime.js';

const selection = { mapping: 'grok-build-1.0.60-session-requests-v1' } as const;
const binding = parseAgentSessionBinding({ conversationId: 'controlled-native-session' });
function review(handle: AgentSessionInteraction): AgentSessionPlanReviewRequest {
  assert.equal(handle.request.kind, 'plan_review');
  if (handle.request.kind !== 'plan_review') throw new Error('Expected the exact restored plan review.');
  return handle.request;
}

for (const { action, mode, outcome } of [
  { action: 'approve', mode: 'plan', outcome: 'completed' }, { action: 'revise', mode: 'plan', outcome: 'completed' },
  { action: 'abandon', mode: 'plan', outcome: 'completed' }, { action: 'approve', mode: 'plan-current-replay', outcome: 'completed' },
  { action: 'approve', mode: 'plan-native-cancelled', outcome: 'canceled' },
  { action: 'approve', mode: 'plan-native-cancelled-before-output', outcome: 'canceled' },
] as const) test(`selected resumed ${mode} ${action} uses its native response and owned continuation without caller prompts`, posix, async (t) => {
  const fixture = sessionInteractionFixture(t, mode);
  const { adapter } = await fixture.registered({ sessionInteractions: selection });
  const publication = fixtureDeferred<AgentSessionInteraction>();
  const completed = fixtureDeferred<Awaited<ReturnType<typeof collect>>>();
  let continuations = 0;
  let openingReturned = false;
  const session = adapter.resumption.kind === 'supported' ? await adapter.resumption.resumeSession({
    ...context(fixture.cwd), binding,
    interactions: { humanWait: { kind: 'until_withdrawn_or_closed' }, onRequest(handle) {
      assert.equal(openingReturned, true);
      publication.resolve(handle);
    } },
    nativeContinuations: { onExecution(continuation) {
      continuations += 1;
      void collect(continuation.execution.outputs).then(completed.resolve, (cause) => completed.reject(cause instanceof Error ? cause : new Error(String(cause))));
    } },
  }) : undefined;
  assert.ok(session);
  openingReturned = true;
  const handle = await publication.promise;
  const request = review(handle);
  assert.deepEqual(handle.deadline, { kind: 'no_deadline' });
  assert.equal(request.plan.content.text, '# Controlled plan\n\nPerform the owned task.\n');
  assert.deepEqual(request.choices.map((choice) => choice.action), ['approve', 'revise', 'abandon']);
  const base = { kind: 'plan_review' as const, choiceId: request.choices.find((choice) => choice.action === action)!.choiceId,
    planId: request.plan.planId, revision: request.plan.revision };
  const response = action === 'revise' ? { ...base, action, feedback: 'Revise the wording only.' } : { ...base, action };
  assert.deepEqual(await handle.respond(response), { status: 'delivered' });
  const native = await waitFor(() => fixture.frames().find((frame) => frame.id === 'controlled-plan:1'), 'exact native plan response');
  assert.deepEqual(native.result, action === 'revise' ? { outcome: 'cancelled', feedback: 'Revise the wording only.' }
    : { outcome: action === 'approve' ? 'approved' : 'abandoned' });
  if (action === 'abandon') assert.equal(continuations, 0);
  else {
    const outputs = events(await completed.promise);
    assert.equal(continuations, 1);
    assert.equal(outputs.filter((event) => event.type === 'turn.started').length, 1);
    assert.deepEqual(outputs.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome }]);
    assert.equal(outputs.flatMap((event) => event.type === 'content.delta' ? [event.payload.delta] : []).join(''),
      mode === 'plan-native-cancelled-before-output' ? '' : 'Native continued output.');
  }
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/load').length, 1);
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/resume' || frame.method === 'session/prompt').length, 0);
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/cancel').length, 0);
  await session.close({ reason: 'idle' });
  assertProcessGone(fixture.pid());
});

test('a resumed review can coexist with a caller turn but cannot dispatch continuation work until that slot is free', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, 'plan');
  const { adapter } = await fixture.registered({ sessionInteractions: selection });
  if (adapter.resumption.kind !== 'supported') throw new Error('Expected selected resumption.');
  const publication = fixtureDeferred<AgentSessionInteraction>();
  let continuations = 0;
  const session = await adapter.resumption.resumeSession({ ...context(fixture.cwd), binding,
    interactions: { onRequest: publication.resolve }, nativeContinuations: { onExecution() { continuations += 1; } } });
  const handle = await publication.promise;
  const request = review(handle);
  const caller = session.startTurn(turnInput('caller:reserved'));
  await assert.rejects(handle.respond({ kind: 'plan_review', action: 'approve', choiceId: request.choices[0].choiceId,
    planId: request.plan.planId, revision: request.plan.revision }),
  (cause: unknown) => cause instanceof Error && 'code' in cause && cause.code === 'concurrent_turn');
  assert.equal(continuations, 0);
  assert.equal(fixture.frames().filter((frame) => frame.id === 'controlled-plan:1').length, 0);
  await collect(caller.outputs);
  await session.close({ reason: 'idle' });
});

test('the selected session mapping rejects a different exact native version before any session opening', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, 'plan-version');
  await assert.rejects(fixture.materialize({ sessionInteractions: selection }), (cause: unknown) => cause instanceof Error
    && 'reasonCode' in cause && cause.reasonCode === 'acp_session_profile_mismatch');
  assert.equal(fixture.frames().filter((frame) => frame.method?.startsWith('session/')).length, 0);
  assertProcessGone(fixture.pid());
});

for (const mode of ['plan-null', 'plan-wrong-session'] as const) test(`${mode} rejects native review material before publishing human authority`, posix, async (t) => {
  const fixture = sessionInteractionFixture(t, mode);
  const { adapter } = await fixture.registered({ sessionInteractions: selection });
  if (adapter.resumption.kind !== 'supported') throw new Error('Expected selected resumption.');
  let publications = 0;
  let executions = 0;
  let session: AgentProviderSession | undefined;
  try {
    session = await adapter.resumption.resumeSession({ ...context(fixture.cwd), binding,
      interactions: { onRequest() { publications += 1; } },
      nativeContinuations: { onExecution() { executions += 1; } } });
  } catch (cause) {
    assert.ok(cause instanceof Error && 'reasonCode' in cause);
    assert.equal(cause.reasonCode, mode === 'plan-null' ? 'acp_extension_params_invalid' : 'acp_session_interaction_binding');
  }
  await waitFor(() => { try { assertProcessGone(fixture.pid()); return true; } catch { return undefined; } }, 'invalid review producer shutdown');
  assert.deepEqual([publications, executions], [0, 0]);
  assert.equal(fixture.frames().some((frame) => frame.id === 'controlled-plan:1' && frame.result !== undefined), false);
  if (session) {
    const opened = session;
    await assert.rejects(async () => opened.close({ reason: 'shutdown' }));
  }
});

for (const mode of ['plan-stale-prompt', 'plan-wrong-output', 'plan-wrong-terminal', 'plan-active-interrupted', 'plan-terminal-error', 'plan-replay-queue-reuse',
  'plan-replay-output-reuse', 'plan-replay-terminal-reuse', 'plan-historical-output-reuse', 'plan-historical-terminal-reuse'] as const) test(`${mode} fails the original owned continuation without manufacturing successful completion`, posix, async (t) => {
  const fixture = sessionInteractionFixture(t, mode);
  const { adapter } = await fixture.registered({ sessionInteractions: selection });
  if (adapter.resumption.kind !== 'supported') throw new Error('Expected selected resumption.');
  const publication = fixtureDeferred<AgentSessionInteraction>();
  const owned = fixtureDeferred<AgentNativeContinuation>();
  const outputs = fixtureDeferred<Awaited<ReturnType<typeof collect>>>();
  const session = await adapter.resumption.resumeSession({ ...context(fixture.cwd), binding,
    interactions: { onRequest: publication.resolve }, nativeContinuations: { onExecution(continuation) {
      owned.resolve(continuation);
      void collect(continuation.execution.outputs).then(outputs.resolve, (cause) => outputs.reject(cause instanceof Error ? cause : new Error(String(cause))));
    } } });
  const handle = await publication.promise;
  const request = review(handle);
  const response = handle.respond({ kind: 'plan_review', action: 'approve', choiceId: request.choices[0].choiceId,
    planId: request.plan.planId, revision: request.plan.revision });
  await owned.promise;
  const rejected = assert.rejects(outputs.promise);
  void rejected.catch(() => {});
  await response.catch(() => {});
  await rejected;
  await assert.rejects(async () => session.close({ reason: 'shutdown' }));
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 0);
});

for (const { phase, reason, outcome } of [
  { phase: 'before-output', reason: 'user_requested', outcome: 'canceled' },
  { phase: 'after-output', reason: 'user_requested', outcome: 'canceled' },
  { phase: 'before-output', reason: 'timeout', outcome: 'expired' },
] as const) test(`adopted continuation confirms admitted ${reason} cancellation ${phase} on its original reader`, posix, async (t) => {
  const fixture = sessionInteractionFixture(t, `plan-cancel-${phase}`);
  const { adapter } = await fixture.registered({ sessionInteractions: selection });
  if (adapter.resumption.kind !== 'supported') throw new Error('Expected selected resumption.');
  const publication = fixtureDeferred<AgentSessionInteraction>();
  const owned = fixtureDeferred<AgentNativeContinuation>();
  const ready = fixtureDeferred<void>();
  const completed = fixtureDeferred<Awaited<ReturnType<typeof collect>>>();
  void completed.promise.catch(() => {});
  const session = await adapter.resumption.resumeSession({ ...context(fixture.cwd), binding,
    interactions: { onRequest: publication.resolve }, nativeContinuations: { onExecution(continuation) {
      owned.resolve(continuation);
      void (async () => {
        const outputs: Awaited<ReturnType<typeof collect>> = [];
        for await (const output of continuation.execution.outputs) {
          outputs.push(output);
          if (output.kind === 'event' && output.event.type === (phase === 'before-output' ? 'turn.started' : 'content.delta')) ready.resolve();
        }
        return outputs;
      })().then(completed.resolve, (cause) => completed.reject(cause instanceof Error ? cause : new Error(String(cause))));
    } } });
  const handle = await publication.promise;
  const request = review(handle);
  assert.deepEqual(await handle.respond({ kind: 'plan_review', action: 'approve', choiceId: request.choices[0].choiceId,
    planId: request.plan.planId, revision: request.plan.revision }), { status: 'delivered' });
  const continuation = await owned.promise;
  assert.deepEqual(await continuation.outcome, { kind: 'started' });
  await ready.promise;
  if (session.interruption.kind !== 'supported') throw new Error('Expected selected native interruption.');
  assert.deepEqual(await session.interruption.interruptTurn({ turnId: continuation.execution.turnId, reason }), { status: 'canceled' });
  const outputs = events(await completed.promise);
  assert.equal(outputs.filter((event) => event.type === 'turn.started').length, 1);
  assert.deepEqual(outputs.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome }]);
  assert.equal(outputs.filter((event) => event.type === 'content.delta').length, phase === 'before-output' ? 0 : 1);
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/cancel').length, 1);
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 0);
  await session.close({ reason: 'idle' });
  assertProcessGone(fixture.pid());
});

test('the adopted native continuation reserves the caller slot through its actual terminal and then permits a new caller turn', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, 'plan-held-terminal');
  const { adapter } = await fixture.registered({ sessionInteractions: selection });
  if (adapter.resumption.kind !== 'supported') throw new Error('Expected selected resumption.');
  const publication = fixtureDeferred<AgentSessionInteraction>();
  const firstOutput = fixtureDeferred<void>();
  const completed = fixtureDeferred<void>();
  const session = await adapter.resumption.resumeSession({ ...context(fixture.cwd), binding,
    interactions: { onRequest: publication.resolve }, nativeContinuations: { async onExecution(continuation) {
      for await (const output of continuation.execution.outputs) {
        if (output.kind === 'event' && output.event.type === 'content.delta') firstOutput.resolve();
      }
      completed.resolve();
    } } });
  const handle = await publication.promise;
  const request = review(handle);
  assert.deepEqual(await handle.respond({ kind: 'plan_review', action: 'approve', choiceId: request.choices[0].choiceId,
    planId: request.plan.planId, revision: request.plan.revision }), { status: 'delivered' });
  await firstOutput.promise;
  assert.throws(() => session.startTurn(turnInput('caller:overlap')), (cause: unknown) => cause instanceof Error
    && 'code' in cause && cause.code === 'concurrent_turn');
  fixture.signal();
  await completed.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = events(await collect(session.startTurn(turnInput('caller:after-native')).outputs));
  assert.deepEqual(next.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [{ outcome: 'completed' }]);
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 1);
  await session.close({ reason: 'idle' });
});

for (const mode of ['plan-count-pressure', 'plan-byte-pressure'] as const) test(`${mode} enforces selected lifecycle retention below larger generic output and callback settings`, posix, async (t) => {
  const fixture = sessionInteractionFixture(t, mode);
  const { adapter } = await fixture.materialize({ sessionInteractions: selection, limits: { maxPendingRequests: 32,
    maxQueuedBytes: 8 * 1_024 * 1_024 } });
  if (adapter.resumption.kind !== 'supported') throw new Error('Expected selected resumption.');
  const session = await adapter.resumption.resumeSession({ ...context(fixture.cwd), binding,
    interactions: { onRequest() {} } });
  const execution = session.startTurn(turnInput('caller:pressure'));
  await assert.rejects(collect(execution.outputs), (cause: unknown) => cause instanceof Error && 'reasonCode' in cause
    && cause.reasonCode === (mode === 'plan-count-pressure' ? 'acp_request_queue_full' : 'acp_session_queue_full'));
  await assert.rejects(async () => session.close({ reason: 'shutdown' }));
  assert.equal(fixture.frames().some((frame) => frame.id?.toString().startsWith('pressure:') && frame.result !== undefined), false);
  assertProcessGone(fixture.pid());
});
