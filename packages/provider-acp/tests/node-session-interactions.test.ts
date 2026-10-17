import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProviderContractError, validateAgentProviderAdapter, type AgentProviderDirectSessionInteraction,
  type AgentSessionInteractionContext } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver } from '../src/index.js';
import { createNodeAcpProviderDriver, type CreateNodeAcpProviderDriverOptions } from '../src/node/index.js';
import { assertProcessGone, bindingFixture, context, fixtureDeferred, posix, providerKey, server, sessionInteractionFixture, waitFor } from './fixtures/session-interactions.js';

test('selected mapping rejects malformed selectors and non-direct arguments before launching', posix, (t) => {
  const fixture = sessionInteractionFixture(t, 'none');
  const selectors: readonly unknown[] = [undefined, null, {}, { mapping: 'other' }, { mapping: 'grok-folder-trust-v1', extra: true }];
  for (const selection of selectors) assert.throws(() => createNodeAcpProviderDriver({ ...fixture.options,
    sessionInteractions: selection as CreateNodeAcpProviderDriverOptions['sessionInteractions'],
  }), TypeError);
  for (const args of [undefined, [], ['agent', 'stdio'], ['agent', '--leader', 'stdio'], ['--no-leader', 'agent', 'stdio'], ['agent', '--no-leader', 'stdio', '--extra']]) {
    assert.throws(() => createNodeAcpProviderDriver({ ...fixture.options, launch: { ...fixture.options.launch, args } }), TypeError);
  }
  assert.deepEqual(fixture.entries(), []);
});

test('root injected connections cannot opt into the exclusive native mapping', () => {
  let connections = 0;
  for (const sessionInteractions of [undefined, { mapping: 'grok-folder-trust-v1' }]) {
    const options = { providerKey, sessionInteractions, createConnection() {
      connections += 1;
      throw new Error('An injected factory must never be entered for this selection.');
    } };
    assert.throws(() => createAcpProviderDriver(options), TypeError);
  }
  assert.equal(connections, 0);
});

test('missing, invalid and unsupported handlers preserve the eager child and MCP lease for a valid create-only opening', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, 'none');
  let acquired = 0;
  let released = 0;
  const host = bindingFixture('controlled-eager-binding');
  const instance = await fixture.materialize({ sessionMcpBinding: { transport: 'http', create() {
    acquired += 1;
    return { mcpServers: [server('controlled-eager')], release() { released += 1; } };
  } } });
  const adapter = validateAgentProviderAdapter(instance.capabilities, instance.adapter);
  assert.deepEqual(adapter.sessionInteractions, { kind: 'supported', mappings: [{ openingOperation: 'create', requestKind: 'decision' }],
    producerOwnership: 'exclusive', humanWait: ['bounded', 'until_withdrawn_or_closed'] });
  assert.equal(instance.capabilities.sessions.resume, false);
  assert.deepEqual(instance.capabilities.sessions.branch, { kind: 'unsupported' });
  assert.deepEqual(instance.adapter.resumption, { kind: 'unsupported' });
  assert.deepEqual(instance.adapter.branching, { kind: 'unsupported' });
  for (const [index, interactions] of [undefined, { onRequest: null },
    { humanWait: { kind: 'until_withdrawn_or_closed' }, limits: { requestTimeoutMs: 300_000 }, onRequest() {} }].entries()) {
    const rejectedHost = bindingFixture(`controlled-rejected-binding:${index}`);
    await assert.rejects(async () => adapter.createSession({ ...context(fixture.cwd), hostBinding: rejectedHost.binding,
      interactions: interactions as unknown as AgentSessionInteractionContext,
    }), (error: unknown) => {
      assert.ok(error instanceof AgentProviderContractError);
      assert.equal(error.code, 'invalid_session_interaction');
      return true;
    });
    assert.deepEqual([fixture.entries().filter((entry) => entry.kind === 'started').length,
      fixture.frames().filter((frame) => frame.method === 'session/new').length, acquired, released, host.releases], [1, 0, 0, 0, 0]);
  }
  let callbacks = 0;
  const session = await adapter.createSession({ ...context(fixture.cwd), hostBinding: host.binding, interactions: { onRequest() { callbacks += 1; } } });
  assert.deepEqual([fixture.entries().filter((entry) => entry.kind === 'started').length,
    fixture.frames().filter((frame) => frame.method === 'session/new').length, acquired, callbacks], [1, 1, 1, 0]);
  assert.deepEqual(fixture.entries()[0]?.argv, ['agent', '--no-leader', 'stdio']);
  await session.close({ reason: 'idle' });
  assertProcessGone(fixture.pid());
  assert.deepEqual([released, host.releases, fixture.frames().filter((frame) => frame.method === 'session/prompt').length], [1, 1, 0]);
});

test('raw driver creation returns a direct candidate interaction before registry validation', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, 'late');
  const instance = await fixture.materialize();
  const publication = fixtureDeferred<AgentProviderDirectSessionInteraction>();
  const session = await instance.adapter.createSession({ ...context(fixture.cwd), interactions: { onRequest(handle) {
    assert.equal(handle.kind, 'direct');
    if (handle.kind !== 'direct') throw new Error('Expected a direct candidate interaction.');
    publication.resolve(handle);
  } } });
  const handle = await publication.promise;
  assert.equal(Object.hasOwn(handle, 'deadline'), false);
  assert.equal(handle.request.kind, 'decision');
  if (handle.request.kind !== 'decision') throw new Error('Expected a workspace decision.');
  const choiceId = handle.request.choices[0].choiceId;
  assert.deepEqual(await handle.respond({ kind: 'decision', choiceId }), { status: 'delivered' });
  assert.deepEqual(await handle.terminal, { kind: 'answered', response: { kind: 'decision', choiceId } });
  const nativeReply = await waitFor(() => fixture.frames().find((frame) => frame.id === 'controlled-folder-trust:1'), 'direct candidate native answer');
  assert.deepEqual(nativeReply.result, { outcome: 'trust' });
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/prompt').length, 0);
  await session.close({ reason: 'idle' });
  assertProcessGone(fixture.pid());
});

test('an eager selected producer fatal remains observable through its first instance disposal only', posix, async (t) => {
  const fixture = sessionInteractionFixture(t, 'late-fatal');
  const instance = await fixture.materialize();
  fixture.signal();
  await waitFor(() => { try { assertProcessGone(fixture.pid()); return true; } catch { return undefined; } }, 'eager fatal producer shutdown');
  await assert.rejects(async () => instance.dispose(), (error: unknown) => error instanceof AggregateError
    && error.errors.some((entry: unknown) => entry instanceof Error && 'reasonCode' in entry && entry.reasonCode === 'acp_json_invalid'));
  await instance.dispose();
  assert.equal(fixture.frames().filter((frame) => frame.method === 'initialize').length, 1);
  assert.equal(fixture.frames().filter((frame) => frame.method === 'session/new' || frame.method === 'session/prompt').length, 0);
  assertProcessGone(fixture.pid());
});
