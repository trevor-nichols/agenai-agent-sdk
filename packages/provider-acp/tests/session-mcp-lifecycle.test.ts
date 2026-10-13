// ------------------------------------------------------------------------------------------------
//                session-mcp-lifecycle.test.ts - Native, factory and callback cleanup ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProviderContractError, AgentProviderHostBindingCleanupError, type AgentProviderOutput, type AgentSessionHostBinding } from '@agen-ai/agent-runtime';
import type { AcpSessionMcpBindingFactory } from '../src/index.js';
import { bindingFixture, context, createBindingHarness, fixtureDeferred, invoke, server } from './fixtures/session-mcp.js';
import { turnInput } from './fixtures/session-runtime.js';

const closed = (error: unknown) => error instanceof AgentProviderContractError && error.code === 'host_binding_closed';

test('normal close stops stalled output and quiesces native ownership and the factory before releasing a drained host binding', { timeout: 3_000 }, async (t) => {
  const prompted = fixtureDeferred<void>();
  const nativeEntered = fixtureDeferred<void>();
  const nativeFinished = fixtureDeferred<void>();
  const factoryEntered = fixtureDeferred<void>();
  const factoryFinished = fixtureDeferred<void>();
  const callbackEntered = fixtureDeferred<AbortSignal>();
  const callbackFinished = fixtureDeferred<void>();
  const order: string[] = [];
  let facade: AgentSessionHostBinding | undefined;
  const harness = await createBindingHarness({ onFrame(peer, frame) {
    if (frame.method !== 'session/prompt') return;
    peer.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-session',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Queued before close.' } },
    } });
    prompted.resolve();
    return true;
  }, async releaseConnection() {
    order.push('native:start'); nativeEntered.resolve(); await nativeFinished.promise; order.push('native:done');
  }, sessionMcpBinding: { transport: 'http', create(input) {
    facade = input.hostBinding;
    return { mcpServers: [server('owned')], async release() {
      order.push('factory:start'); factoryEntered.resolve(); await factoryFinished.promise; order.push('factory:done');
    } };
  } } });
  t.after(async () => { nativeFinished.resolve(); factoryFinished.resolve(); callbackFinished.resolve(); await harness.close(); });
  const host = bindingFixture('close:parent', { async invoke(input) {
    assert.ok(input.signal); callbackEntered.resolve(input.signal); await callbackFinished.promise;
    return { kind: 'success', value: { done: true } };
  }, release() { order.push('host:release'); } });
  const session = await harness.adapter.createSession({ ...context('session:close-order'), hostBinding: host.binding });
  const iterator = session.startTurn(turnInput('turn:close-order')).outputs[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.kind === 'event' ? first.value.event.type : undefined, 'turn.started');
  await prompted.promise;
  assert.ok(facade);
  const pending = invoke(facade, 'callback:held');
  const signal = await callbackEntered.promise;
  let finished = false;
  const closing = Promise.resolve(session.close({ reason: 'shutdown' })).then(() => { finished = true; });
  await nativeEntered.promise;
  await assert.rejects(iterator.next(), { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  assert.equal(host.releases, 0);
  assert.deepEqual(order, ['native:start']);
  nativeFinished.resolve();
  await factoryEntered.promise;
  assert.equal(host.releases, 0);
  assert.equal(finished, false);
  factoryFinished.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.releases, 0, 'An ignored abort must retain the host binding until its callback actually settles.');
  await assert.rejects(invoke(facade, 'callback:after-close'), closed);
  callbackFinished.resolve();
  await pending;
  await closing;
  await session.close({ reason: 'shutdown' });
  assert.deepEqual(order, ['native:start', 'native:done', 'factory:start', 'factory:done', 'host:release']);
  assert.equal(host.releases, 1);
  assert.equal(host.calls.length, 1);
  assert.equal(harness.peers[0]!.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  await assert.rejects(iterator.next(), { name: 'AbortError' });
});

test('a failed opening closes its acquired connection and factory lease before releasing the original binding', async (t) => {
  const order: string[] = [];
  const original = new Error('Host binding publication failed.');
  const harness = await createBindingHarness({ releaseConnection() { order.push('native'); },
    sessionMcpBinding: { transport: 'http', create() {
      return { mcpServers: [server('opening')], release() { order.push('factory'); } };
    } },
  });
  t.after(() => harness.close());
  const host = bindingFixture('opening:parent', { release() { order.push('host'); } });
  await assert.rejects(async () => harness.adapter.createSession({ ...context('session:opening-failure'), hostBinding: host.binding,
    onBindingCreated() { throw original; },
  }), (error) => error === original);
  assert.equal(harness.peers[0]!.frames.filter((frame) => frame.method === 'session/new').length, 1);
  assert.equal(harness.peers[0]!.frames.some((frame) => frame.method === 'session/prompt'), false);
  assert.deepEqual(order, ['native', 'factory', 'host']);
  assert.equal(host.releases, 1);
});

test('a fulfilled lease with a throwing release accessor retains its host binding until cleanup can discover and release it', async (t) => {
  const lookupError = new Error('The MCP cleanup callable is temporarily unavailable.');
  let failLookup = true;
  let nativeReleases = 0;
  let factoryReleases = 0;
  let facade: AgentSessionHostBinding | undefined;
  const lease = { mcpServers: [server('release-lookup')], get release() {
    if (failLookup) throw lookupError;
    return function (this: typeof lease) { assert.equal(this, lease); factoryReleases += 1; };
  } };
  const harness = await createBindingHarness({ releaseConnection() { nativeReleases += 1; },
    sessionMcpBinding: { transport: 'http', create(input) { facade = input.hostBinding; return lease; } },
  });
  let retained: AgentProviderHostBindingCleanupError | undefined;
  t.after(async () => { failLookup = false; await retained?.retryCleanup(); await harness.close(); });
  const host = bindingFixture('release-lookup:parent');
  await assert.rejects(async () => harness.adapter.createSession({ ...context('session:release-lookup'), hostBinding: host.binding }),
    (error) => { assert.ok(error instanceof AgentProviderHostBindingCleanupError); retained = error; return true; });
  assert.ok(retained && facade);
  assert.equal(harness.peers[0]!.frames.some((frame) => frame.method === 'session/new'), false);
  assert.equal(nativeReleases, 1);
  assert.equal(factoryReleases, 0);
  assert.equal(host.releases, 0);
  await assert.rejects(invoke(facade, 'callback:release-lookup'), closed);
  await assert.rejects(retained.retryCleanup());
  assert.equal(host.releases, 0);
  failLookup = false;
  await retained.retryCleanup();
  assert.equal(nativeReleases, 1);
  assert.equal(factoryReleases, 1);
  assert.equal(host.releases, 1);
  await retained.retryCleanup();
  assert.equal(factoryReleases, 1);
  assert.equal(host.releases, 1);
});

test('a lease cleanup callable with a throwing bind accessor opens and releases with its original receiver', async (t) => {
  let factoryReleases = 0;
  const release = Object.defineProperty(function (this: typeof lease) {
    assert.equal(this, lease); factoryReleases += 1;
  }, 'bind', { get() { throw new Error('MCP cleanup callable binding must not inspect its own properties.'); } });
  const lease = { mcpServers: [server('release-bind')], release };
  const harness = await createBindingHarness({ sessionMcpBinding: { transport: 'http', create() { return lease; } } });
  t.after(() => harness.close());
  const host = bindingFixture('release-bind:parent');
  const session = await harness.adapter.createSession({ ...context('session:release-bind'), hostBinding: host.binding });
  assert.equal(factoryReleases, 0);
  assert.equal(host.releases, 0);
  await session.close({ reason: 'shutdown' });
  assert.equal(factoryReleases, 1);
  assert.equal(host.releases, 1);
});

test('failed native cleanup on opening retains the factory and original binding for the exact cleanup retry', async (t) => {
  let failNative = true;
  let nativeAttempts = 0;
  let factoryReleases = 0;
  const original = new Error('Opening observer rejected.');
  let facade: AgentSessionHostBinding | undefined;
  const harness = await createBindingHarness({ releaseConnection() {
    nativeAttempts += 1;
    if (failNative) throw new Error('Native owner is not yet quiescent.');
  }, authentication: { browser: { methodId: 'fixture-browser' } }, authMethods: [{ id: 'fixture-browser', name: 'Fixture account' }],
  onFrame(peer, frame) {
    if (frame.method === 'authenticate') {
      peer.send({ jsonrpc: '2.0', id: frame.id, result: {} });
      return true;
    }
  }, sessionMcpBinding: { transport: 'http', create(input) {
    facade = input.hostBinding;
    return { mcpServers: [server('retained')], release() { factoryReleases += 1; } };
  } } });
  t.after(async () => { failNative = false; await harness.close(); });
  const host = bindingFixture('retained:parent');
  let retained: AgentProviderHostBindingCleanupError | undefined;
  await assert.rejects(async () => harness.adapter.createSession({ ...context('session:retained-opening'), hostBinding: host.binding,
    onBindingCreated() { throw original; },
  }), (error) => { assert.ok(error instanceof AgentProviderHostBindingCleanupError); retained = error; return true; });
  assert.ok(retained && facade);
  assert.equal(nativeAttempts, 1, 'Returning retained responsibility must not silently retry native cleanup.');
  assert.equal(factoryReleases, 0);
  assert.equal(host.releases, 0);
  await assert.rejects(invoke(facade, 'callback:rejected-opening'), closed);
  const authentication = harness.adapter.authentication;
  assert.equal(authentication.kind, 'supported');
  if (authentication.kind !== 'supported') throw new Error('Expected explicitly configured authentication.');
  const authenticate = async (attemptId: string) => {
    let terminal: AgentProviderOutput | undefined;
    for await (const output of authentication.start({ attemptId, flow: 'browser' })) terminal = output;
    assert.ok(terminal?.kind === 'authentication');
    return terminal.progress;
  };
  const denied = await authenticate('auth:retained-cleanup');
  assert.equal(harness.peers.flatMap((peer) => peer.frames).filter((frame) => frame.method === 'authenticate').length, 0,
    'A retained native owner must prevent account mutation before another authenticate RPC.');
  assert.equal(denied.status, 'failed');
  assert.equal(denied.error?.code, 'authentication_failed');
  failNative = false;
  await retained.retryCleanup();
  assert.equal(nativeAttempts, 2);
  assert.equal(factoryReleases, 1);
  assert.equal(host.releases, 1);
  await retained.retryCleanup();
  assert.equal(nativeAttempts, 2);
  assert.equal(factoryReleases, 1);
  assert.equal(host.releases, 1);
  assert.equal((await authenticate('auth:after-cleanup')).status, 'completed');
  assert.equal(harness.peers.flatMap((peer) => peer.frames).filter((frame) => frame.method === 'authenticate').length, 1);
});

for (const cancellation of ['caller abort', 'factory deadline'] as const) {
  test(`${cancellation} retains a late factory lease and its failed cleanup without native opening`, { timeout: 3_000 }, async (t) => {
    const entered = fixtureDeferred<Parameters<AcpSessionMcpBindingFactory>[0]>();
    const delivered = fixtureDeferred<Awaited<ReturnType<AcpSessionMcpBindingFactory>>>();
    const releaseEntered = fixtureDeferred<void>();
    const abort = new AbortController();
    let failFactory = true;
    let nativeReleases = 0;
    let factoryReleases = 0;
    const lease = { mcpServers: [server('late')], release() {
      factoryReleases += 1; releaseEntered.resolve();
      if (failFactory) throw new Error('Late MCP lease cleanup failed.');
    } };
    const harness = await createBindingHarness({ limits: { initializationTimeoutMs: 40, hostOperationTimeoutMs: 20 },
      releaseConnection() { nativeReleases += 1; }, sessionMcpBinding: { transport: 'http', create(input) {
        entered.resolve(input); return delivered.promise;
      } },
    });
    let retained: AgentProviderHostBindingCleanupError | undefined;
    t.after(async () => { failFactory = false; delivered.resolve(lease); await retained?.retryCleanup(); await harness.close(); });
    const host = bindingFixture(`late:${cancellation}`);
    const opening = assert.rejects(async () => harness.adapter.createSession({ ...context(`session:${cancellation}`), hostBinding: host.binding, signal: abort.signal }),
      (error) => { assert.ok(error instanceof AgentProviderHostBindingCleanupError); retained = error; return true; });
    const input = await entered.promise;
    if (cancellation === 'caller abort') abort.abort();
    await opening;
    assert.ok(retained);
    assert.equal(input.signal.aborted, true);
    assert.equal(harness.peers[0]!.frames.some((frame) => frame.method === 'session/new'), false);
    assert.equal(nativeReleases, 1);
    assert.equal(host.releases, 0);
    await assert.rejects(invoke(input.hostBinding, 'callback:late-closed'), closed);
    await assert.rejects(harness.registry.dispose());
    delivered.resolve(lease);
    await releaseEntered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(host.releases, 0);
    assert.equal(factoryReleases, 1);
    failFactory = false;
    await retained.retryCleanup();
    assert.equal(factoryReleases, 2);
    assert.equal(host.releases, 1);
    assert.equal(nativeReleases, 1);
  });
}
