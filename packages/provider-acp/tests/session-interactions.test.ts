import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentSessionDecisionChoiceId, type AgentSessionRequest } from '@agen-ai/agent-protocol';
import { isAgentProviderSessionCleanupErrorFor, validateAgentProviderAdapter,
  type AgentProviderSessionCleanupError, type AgentRequestResolutionResult, type AgentSessionInteraction } from '@agen-ai/agent-runtime';
import {
  assertProcessGone, bindingFixture, context, fixtureDeferred, posix, server, sessionInteractionFixture, waitFor,
} from './fixtures/session-interactions.js';
import { turnInput } from './fixtures/session-runtime.js';

const grant = parseAgentSessionDecisionChoiceId('grant');
const decline = parseAgentSessionDecisionChoiceId('decline');
const controlId = 'controlled-folder-trust:1';
const failure = (error: unknown): boolean => error instanceof Error;
function retains(error: unknown, cause: unknown): boolean {
  return error === cause || (error instanceof AggregateError && error.errors.some((entry: unknown) => retains(entry, cause)))
    || (error instanceof Error && error.cause !== undefined && retains(error.cause, cause));
}
function hasReason(error: unknown, reason: string): boolean {
  return (error instanceof Error && 'reasonCode' in error && error.reasonCode === reason)
    || (error instanceof AggregateError && error.errors.some((entry: unknown) => hasReason(entry, reason)))
    || (error instanceof Error && error.cause !== undefined && hasReason(error.cause, reason));
}

function assertDecision(request: AgentSessionRequest, cwd: string): void {
  assert.equal(request.kind, 'decision');
  if (request.kind !== 'decision') throw new Error('Expected a workspace decision.');
  assert.equal(Object.hasOwn(request, 'expiresAt'), false);
  assert.equal(request.sessionId, 'logical-session');
  assert.equal(request.title, 'Allow workspace configuration?');
  assert.deepEqual(request.target, { kind: 'workspace', path: `${cwd}/configuration-scope` });
  assert.deepEqual(request.choices.map((choice) => [choice.choiceId, choice.label, choice.consequence]), [
    ['grant', 'Allow workspace configuration', { kind: 'grant', scope: 'workspace', persistence: { kind: 'provider_managed', duration: 'persistent', mayAffectOtherSessions: true } }],
    ['decline', 'Keep configuration gated', { kind: 'decline', configuration: 'remains_gated' }],
  ]);
  assert.match(request.description ?? '', /Project tool servers/iu);
  assert.notEqual(request.requestId, controlId);
  assert.equal(Object.hasOwn(request, 'configKinds'), false);
}

test('early and late questions correlate exact native replies without dispatching a prompt', posix, async (t) => {
  for (const mode of ['early', 'late'] as const) for (const choice of [grant, decline]) await t.test(`${mode}/${choice}`, async (t) => {
    const fixture = sessionInteractionFixture(t, mode);
    const { adapter } = await fixture.registered();
    const publication = fixtureDeferred<AgentSessionInteraction>();
    const receipts: Promise<AgentRequestResolutionResult>[] = [];
    let callbacks = 0;
    let openingReturned = false;
    let offeredBeforeReturn = false;
    const session = await adapter.createSession({ ...context(fixture.cwd), interactions: { onRequest(handle) {
      callbacks += 1;
      offeredBeforeReturn = !openingReturned;
      publication.resolve(handle);
      receipts.push(handle.respond({ kind: 'decision', choiceId: choice }));
    } } });
    openingReturned = true;
    const handle = await publication.promise;
    assertDecision(handle.request, fixture.cwd);
    assert.deepEqual(await receipts[0], { status: 'delivered' });
    assert.deepEqual(await handle.terminal, { kind: 'answered', response: { kind: 'decision', choiceId: choice } });
    assert.equal(handle.deadline.kind, 'deadline');
    if (handle.deadline.kind !== 'deadline') throw new Error('Expected a finite host deadline.');
    assert.equal(handle.deadline.source, 'host_policy');
    const response = await waitFor(() => fixture.frames().find((frame) => frame.id === controlId), 'correlated native answer');
    assert.deepEqual(response, { jsonrpc: '2.0', id: controlId, result: { outcome: choice === grant ? 'trust' : 'reject' } });
    const initialize = fixture.frames().find((frame) => frame.method === 'initialize');
    assert.deepEqual((initialize?.params?.clientCapabilities as Record<string, unknown>)?._meta, { 'x.ai/folderTrust': { interactive: true } });
    assert.equal(callbacks, 1);
    if (mode === 'early') assert.equal(offeredBeforeReturn, true);
    assert.equal(fixture.frames().filter((frame) => frame.id === controlId).length, 1);
    assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 0);
    await session.close({ reason: 'idle' });
    assertProcessGone(fixture.pid());
  });
});

test('invalid early association or synchronous setup never publishes the buffered question', posix, async (t) => {
  for (const mode of ['wrong-native-id', 'wrong-cwd', 'invalid-config', 'double-early', 'invalid-setup', 'observer-failure']) await t.test(mode, async (t) => {
    const fixture = sessionInteractionFixture(t, mode);
    const { adapter } = await fixture.registered(mode === 'invalid-setup' ? { configuration: 'selectable' } : {});
    let callbacks = 0;
    const observerFailure = new Error('The binding observer rejected synchronous setup.');
    await assert.rejects(async () => adapter.createSession({ ...context(fixture.cwd),
      ...(mode === 'invalid-setup' ? { configuration: { ...context(fixture.cwd).configuration, kind: 'selected', catalogRevision: 1, selections: [] } as const } : {}),
      onBindingCreated() { if (mode === 'observer-failure') throw observerFailure; },
      interactions: { onRequest() { callbacks += 1; } },
    }), failure);
    assert.equal(callbacks, 0);
    assert.equal(fixture.frames().filter((frame) => frame.method === 'session/new').length, 1);
    assert.equal(fixture.frames().some((frame) => frame.id === controlId && frame.result !== undefined), false);
    assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 0);
    assertProcessGone(fixture.pid());
  });
});

test('an initialization-time question has no session owner and closes the eager producer', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, 'initialization-question');
  await assert.rejects(() => fixture.materialize(), failure);
  assert.equal(fixture.frames().some((frame) => frame.method === 'session/new'), false);
  assert.equal(fixture.frames().some((frame) => frame.id === controlId && frame.result !== undefined), false);
  assertProcessGone(fixture.pid());
});

test('bound native identity and working directory remain exact after opening returns', posix, async (t) => {
  for (const mode of ['late-wrong-native-id', 'late-wrong-cwd']) await t.test(mode, async (t) => {
    const fixture = sessionInteractionFixture(t, mode);
    const { adapter } = await fixture.registered();
    let callbacks = 0;
    const session = await adapter.createSession({ ...context(fixture.cwd), interactions: { onRequest() { callbacks += 1; } } });
    fixture.signal();
    await waitFor(() => { try { assertProcessGone(fixture.pid()); return true; } catch { return undefined; } }, 'invalid bound request shutdown');
    assert.equal(callbacks, 0);
    assert.equal(fixture.frames().some((frame) => frame.id === controlId && frame.result !== undefined), false);
    await assert.rejects(async () => session.close({ reason: 'idle' }), failure);
    await session.close({ reason: 'idle' });
  });
});

test('all admitted native configuration categories receive neutral effect explanations', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, 'all-config');
  const { adapter } = await fixture.registered();
  const publication = fixtureDeferred<AgentSessionInteraction>();
  const session = await adapter.createSession({ ...context(fixture.cwd), interactions: { onRequest(value) { publication.resolve(value); } } });
  const handle = await publication.promise;
  assert.equal(handle.request.kind, 'decision');
  if (handle.request.kind !== 'decision') throw new Error('Expected a workspace decision.');
  for (const explanation of ['Project tool servers', 'Project plugins', 'Project tool-permission rules', 'Project language servers',
    'Project shell environment scripts', 'Imported compatibility settings', 'Project hooks', 'Project agent definitions',
    'Project role definitions', 'Project persona definitions', 'Project workflows', 'Project instructions', 'Project skills']) {
    assert.ok(handle.request.description?.includes(explanation), `Missing neutral explanation: ${explanation}`);
  }
  assert.match(handle.request.choices[0].description, /future/iu);
  assert.match(handle.request.choices[0].description, /later|sibling/iu);
  assert.match(handle.request.choices[1].description, /suppressed/iu);
  assert.deepEqual(await handle.respond({ kind: 'decision', choiceId: decline }), { status: 'delivered' });
  await session.close({ reason: 'idle' });
  assertProcessGone(fixture.pid());
});

test('registry revalidation keeps one owner and joins the actual callback before releasing its MCP bridge', posix, async (t) => {
  const releaseCallback = fixtureDeferred<void>();
  const fixture = sessionInteractionFixture(t, 'early', () => releaseCallback.resolve());
  let acquired = 0;
  let bridgeReleased = 0;
  const host = bindingFixture('controlled-drain-binding');
  const { adapter: validated, instance } = await fixture.registered({ sessionMcpBinding: { transport: 'http', create() {
    acquired += 1;
    return { mcpServers: [server('controlled-drain')], release() { bridgeReleased += 1; } };
  } } });
  const adapter = validateAgentProviderAdapter(instance.capabilities, validated);
  const published = fixtureDeferred<AgentSessionInteraction>();
  let callbacks = 0;
  const session = await adapter.createSession({ ...context(fixture.cwd), hostBinding: host.binding, interactions: { async onRequest(handle) {
    callbacks += 1;
    published.resolve(handle);
    await releaseCallback.promise;
  } } });
  const handle = await published.promise;
  assert.deepEqual(await handle.respond({ kind: 'decision', choiceId: grant }), { status: 'delivered' });
  await waitFor(() => fixture.frames().find((frame) => frame.id === controlId && frame.result !== undefined), 'answer while callback is held');
  assert.deepEqual([callbacks, acquired, bridgeReleased, host.releases], [1, 1, 0, 0]);
  let closed = false;
  const closing = Promise.resolve(session.close({ reason: 'shutdown' })).then(() => { closed = true; });
  await waitFor(() => { try { assertProcessGone(fixture.pid()); return true; } catch { return undefined; } }, 'producer shutdown before callback drain');
  assert.deepEqual([closed, bridgeReleased, host.releases], [false, 0, 0]);
  releaseCallback.resolve();
  await closing;
  assert.deepEqual([closed, callbacks, acquired, bridgeReleased, host.releases], [true, 1, 1, 1, 1]);
});

test('peer withdrawal remains distinct from a disconnected producer', posix, async (t) => {
  for (const mode of ['withdrawal', 'disconnect'] as const) await t.test(mode, async (t) => {
    const fixture = sessionInteractionFixture(t, mode);
    const { adapter } = await fixture.registered();
    const publication = fixtureDeferred<AgentSessionInteraction>();
    const session = await adapter.createSession({ ...context(fixture.cwd), interactions: { onRequest(value) { publication.resolve(value); } } });
    const handle = await publication.promise;
    fixture.signal();
    const terminal = await handle.terminal;
    assert.equal(terminal.kind, mode === 'withdrawal' ? 'withdrawn' : 'failed');
    const late = await handle.respond({ kind: 'decision', choiceId: grant });
    assert.equal(late.status, 'rejected');
    if (late.status !== 'rejected') throw new Error('Expected retired native response authority.');
    assert.deepEqual([late.requestState, late.error.code], ['unavailable', 'session_interaction_unavailable']);
    if (mode === 'withdrawal') {
      const outputs = await Array.fromAsync(session.startTurn(turnInput('after-withdrawal')).outputs);
      const completed = outputs.at(-1);
      assert.equal(completed?.kind === 'event' ? completed.event.type : null, 'turn.completed');
      assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 1);
      await session.close({ reason: 'idle' });
    } else {
      await assert.rejects(async () => Array.fromAsync(session.startTurn(turnInput('after-disconnect')).outputs), failure);
      await assert.rejects(async () => session.close({ reason: 'idle' }), failure);
      await session.close({ reason: 'idle' });
      assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 0);
    }
    assert.equal(fixture.frames().some((frame) => frame.id === controlId && frame.result !== undefined), false);
    assertProcessGone(fixture.pid());
  });
});

test('an answered request keeps accepted truth when a later malformed native frame fails the session', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, 'late-fatal');
  const { adapter } = await fixture.registered();
  const publication = fixtureDeferred<AgentSessionInteraction>();
  const session = await adapter.createSession({ ...context(fixture.cwd), interactions: { onRequest(value) { publication.resolve(value); } } });
  const handle = await publication.promise;
  assert.deepEqual(await handle.respond({ kind: 'decision', choiceId: grant }), { status: 'delivered' });
  await waitFor(() => fixture.frames().find((frame) => frame.id === controlId && frame.result !== undefined), 'accepted native reply');
  fixture.signal();
  await waitFor(() => { try { assertProcessGone(fixture.pid()); return true; } catch { return undefined; } }, 'late-fatal producer shutdown');
  assert.deepEqual(await handle.terminal, { kind: 'answered', response: { kind: 'decision', choiceId: grant } });
  await assert.rejects(async () => Array.fromAsync(session.startTurn(turnInput('after-late-fatal')).outputs), failure);
  await assert.rejects(async () => session.close({ reason: 'idle' }), (error: unknown) => hasReason(error, 'acp_json_invalid'));
  await session.close({ reason: 'idle' });
  assert.deepEqual(fixture.frames().filter((frame) => frame.id === controlId).map((frame) => frame.result), [{ outcome: 'trust' }]);
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 0);
});

test('a terminal question with an unfinished callback still occupies the mapping single-request ceiling', posix, async (t) => {
  const releaseCallback = fixtureDeferred<void>();
  const fixture = sessionInteractionFixture(t, 'second-retained', () => releaseCallback.resolve());
  const { adapter } = await fixture.registered();
  const publication = fixtureDeferred<AgentSessionInteraction>();
  let callbacks = 0;
  const session = await adapter.createSession({ ...context(fixture.cwd), interactions: { limits: { maxRetainedRequests: 32 }, async onRequest(value) {
    callbacks += 1;
    publication.resolve(value);
    await releaseCallback.promise;
  } } });
  const handle = await publication.promise;
  assert.deepEqual(await handle.respond({ kind: 'decision', choiceId: decline }), { status: 'delivered' });
  await waitFor(() => fixture.frames().find((frame) => frame.id === controlId && frame.result !== undefined), 'first native answer');
  fixture.signal();
  await waitFor(() => { try { assertProcessGone(fixture.pid()); return true; } catch { return undefined; } }, 'second retained request shutdown');
  assert.equal(callbacks, 1);
  assert.deepEqual(await handle.terminal, { kind: 'answered', response: { kind: 'decision', choiceId: decline } });
  releaseCallback.resolve();
  await assert.rejects(async () => session.close({ reason: 'idle' }), (error: unknown) => hasReason(error, 'acp_session_interaction_capacity'));
  await session.close({ reason: 'idle' });
  assert.equal(fixture.frames().filter((frame) => frame.result !== undefined && String(frame.id).startsWith('controlled-folder-trust:')).length, 1);
});

test('a pending session question coexists with the caller real turn and does not block its output reader', posix, async (t) => {
  const releaseCallback = fixtureDeferred<void>();
  const fixture = sessionInteractionFixture(t, 'during-turn', () => releaseCallback.resolve());
  const { adapter } = await fixture.registered();
  const publication = fixtureDeferred<AgentSessionInteraction>();
  const session = await adapter.createSession({ ...context(fixture.cwd), interactions: { async onRequest(value) {
    publication.resolve(value);
    await releaseCallback.promise;
  } } });
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 0);
  const output = Array.fromAsync(session.startTurn(turnInput('caller-real-turn', 'Report the controlled workspace status.')).outputs);
  const handle = await publication.promise;
  const outputs = await output;
  assert.deepEqual(outputs.flatMap((entry) => entry.kind === 'event' && entry.event.type === 'content.delta' ? [entry.event.payload.delta] : []),
    ['Controlled output before the decision.', 'Controlled output after the decision.']);
  const completed = outputs.at(-1);
  assert.equal(completed?.kind === 'event' ? completed.event.type : null, 'turn.completed');
  assert.deepEqual(await handle.respond({ kind: 'decision', choiceId: grant }), { status: 'delivered' });
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 1);
  releaseCallback.resolve();
  await session.close({ reason: 'idle' });
  assertProcessGone(fixture.pid());
});

test('pending close, expiry and host failure stop the producer without an implicit native decline', posix, async (t) => {
  for (const stop of ['close', 'expiry', 'handler-failure'] as const) await t.test(stop, async (t) => {
    const finishHandler = fixtureDeferred<void>();
    const fixture = sessionInteractionFixture(t, 'pending', () => finishHandler.resolve());
    const { adapter } = await fixture.registered();
    const publication = fixtureDeferred<AgentSessionInteraction>();
    const hostFailure = new Error('The host presentation failed.');
    const session = await adapter.createSession({ ...context(fixture.cwd), interactions: {
      limits: { requestTimeoutMs: 1_000 }, onRequest(handle) {
        publication.resolve(handle);
        if (stop === 'handler-failure') return finishHandler.promise;
      },
    } });
    const handle = await publication.promise;
    if (stop === 'handler-failure') finishHandler.reject(hostFailure);
    if (stop === 'close') await session.close({ reason: 'idle' });
    const terminal = await handle.terminal;
    assert.equal(terminal.kind, stop === 'close' ? 'session_closed' : stop === 'expiry' ? 'expired' : 'failed');
    if (stop === 'expiry') assert.deepEqual(terminal, { kind: 'expired', source: 'host_policy' });
    if (stop !== 'close') {
      await assert.rejects(async () => session.close({ reason: 'idle' }), (error: unknown) => stop === 'handler-failure' ? retains(error, hostFailure) : failure(error));
      await session.close({ reason: 'idle' });
    }
    assertProcessGone(fixture.pid());
    assert.equal(fixture.frames().some((frame) => frame.id === controlId && frame.result !== undefined), false);
    const late = await handle.respond({ kind: 'decision', choiceId: decline });
    assert.equal(late.status, 'rejected');
    if (late.status !== 'rejected') throw new Error('Expected stopped native response authority.');
    assert.equal(late.requestState, 'unavailable');
  });
});

test('failed opening retains buffered-question cleanup and its exact MCP release owner', posix, async (t) => {
  let releaseFails = true;
  let acquired = 0;
  let releaseAttempts = 0;
  const openingFailure = new Error('The binding observer rejected opening.');
  const releaseFailure = new Error('The session bridge cannot release yet.');
  const fixture = sessionInteractionFixture(t, 'observer-failure', () => { releaseFails = false; });
  const { adapter } = await fixture.registered({ sessionMcpBinding: { transport: 'http', create() {
    acquired += 1;
    return { mcpServers: [server('failed-buffer')], release() { releaseAttempts += 1; if (releaseFails) throw releaseFailure; } };
  } } });
  const host = bindingFixture('failed-buffer-binding');
  let callbacks = 0;
  const input = { ...context(fixture.cwd), hostBinding: host.binding,
    onBindingCreated() { throw openingFailure; }, interactions: { onRequest() { callbacks += 1; } } };
  let cleanup: AgentProviderSessionCleanupError | undefined;
  await assert.rejects(async () => adapter.createSession(input), (error: unknown) => {
    assert.ok(isAgentProviderSessionCleanupErrorFor(error, input));
    assert.equal(isAgentProviderSessionCleanupErrorFor(error, { ...input }), false);
    assert.ok(retains(error, openingFailure));
    assert.ok(retains(error, releaseFailure));
    cleanup = error;
    return true;
  });
  assertProcessGone(fixture.pid());
  assert.deepEqual([callbacks, acquired, releaseAttempts, host.releases], [0, 1, 1, 0]);
  releaseFails = false;
  await Promise.all([cleanup!.retryCleanup(), cleanup!.retryCleanup()]);
  assert.deepEqual([acquired, releaseAttempts, host.releases], [1, 2, 1]);
  assert.equal(fixture.entries().filter((entry) => entry.kind === 'started').length, 1);
  assert.equal(fixture.frames().some((frame) => frame.id === controlId && frame.result !== undefined), false);
});

test('instance disposal retains its pending callback and retries the same producer cleanup owner', posix, async (t) => {
  const releaseCallback = fixtureDeferred<void>();
  const fixture = sessionInteractionFixture(t, 'pending', () => releaseCallback.resolve());
  let bridges = 0;
  let bridgeReleases = 0;
  const host = bindingFixture('instance-disposal-binding');
  const instance = await fixture.materialize({ limits: { initializationTimeoutMs: 3_000, hostOperationTimeoutMs: 1_000 }, sessionMcpBinding: { transport: 'http', create() {
    bridges += 1;
    return { mcpServers: [server('instance-disposal')], release() { bridgeReleases += 1; } };
  } } });
  const publication = fixtureDeferred<AgentSessionInteraction>();
  const adapter = validateAgentProviderAdapter(instance.capabilities, instance.adapter);
  const session = await adapter.createSession({ ...context(fixture.cwd), hostBinding: host.binding, interactions: {
    limits: { cleanupTimeoutMs: 1_000 }, async onRequest(handle) { publication.resolve(handle); await releaseCallback.promise; },
  } });
  const handle = await publication.promise;
  const disposing = Promise.resolve(instance.dispose());
  const incomplete = assert.rejects(disposing, failure);
  await waitFor(() => { try { assertProcessGone(fixture.pid()); return true; } catch { return undefined; } }, 'instance producer shutdown before callback drain');
  assert.deepEqual(await handle.terminal, { kind: 'session_closed' });
  assert.deepEqual([bridges, bridgeReleases, host.releases], [1, 0, 0]);
  await incomplete;
  await assert.rejects(async () => instance.dispose(), failure);
  releaseCallback.resolve();
  await waitFor(() => bridgeReleases === 1 ? true : undefined, 'actual retained instance callback drain');
  await instance.dispose();
  assert.deepEqual([bridges, bridgeReleases, host.releases], [1, 1, 0]);
  await session.close({ reason: 'idle' });
  assert.equal(host.releases, 1);
  assert.equal(fixture.entries().filter((entry) => entry.kind === 'started').length, 1);
  assert.equal(fixture.frames().some((frame) => frame.id === controlId && frame.result !== undefined), false);
});
