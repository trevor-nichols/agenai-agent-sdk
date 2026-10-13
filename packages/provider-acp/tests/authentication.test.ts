import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver, type AcpHostAuthenticationTerminalLease, type AcpHostUrlDecision } from '../src/index.js';
import { createHostPeer, fixtureDeferred, hostDefinition, hostProviderKey, hostSessionContext } from './node-fixtures/host-peer.js';

const agentInitialize: AcpJsonObject = { protocolVersion: 1, authMethods: [{ id: 'fixture-browser', name: 'Fixture account' }] };

test('agent authentication correlates host forms and URL consent outside sessions, then preserves the authenticated connection', { timeout: 3_000 }, async (t) => {
  const peer = createHostPeer(agentInitialize);
  const consent = fixtureDeferred<AcpHostUrlDecision>();
  const opened = fixtureDeferred<void>();
  const urlCompleted = fixtureDeferred<void>();
  let forms = 0;
  let released = 0;
  let authenticateId: string | number | undefined;
  peer.handle((frame) => {
    if (frame.method === 'authenticate') { authenticateId = frame.id; return true; }
  });
  const registry = await createAgentProviderRegistry({
    drivers: [createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease,
      authentication: { browser: { methodId: 'fixture-browser' } }, host: {
        form(input) { forms += 1; assert.deepEqual(input.scope, { kind: 'authentication', attemptId: 'auth:1', flow: 'browser' });
          return { action: 'accept', content: { count: 2 } }; },
        url(input) { assert.equal(input.url, 'https://login.example.invalid/consent'); opened.resolve();
          return { decision: consent.promise, complete() { urlCompleted.resolve(); }, release() { released += 1; } }; },
      } })], definitions: [hostDefinition],
  });
  t.after(async () => { await registry.dispose(); peer.destroy(); });
  const instance = registry.requireInstance(hostDefinition.instanceId);
  assert.equal(instance.adapter.authentication.kind, 'supported');
  if (instance.adapter.authentication.kind !== 'supported') return;
  const stream = instance.adapter.authentication.start({ attemptId: 'auth:1', flow: 'browser' })[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value?.kind, 'authentication');
  await peer.wait((frame) => frame.method === 'authenticate');
  assert.ok(authenticateId);
  const form = { mode: 'form', message: 'Choose count', requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['count'] } };
  assert.equal((await peer.request('elicitation/create', { ...form, requestId: 'unknown' })).error?.code, -32602);
  assert.equal(forms, 0);
  assert.deepEqual((await peer.request('elicitation/create', { ...form, requestId: authenticateId })).result, { action: 'accept', content: { count: 2 } });
  const response = peer.request('elicitation/create', { requestId: authenticateId, mode: 'url', message: 'Authorize', elicitationId: 'url:1', url: 'https://login.example.invalid/consent' });
  await opened.promise;
  assert.equal(peer.frames.some((frame) => frame.result && typeof frame.result === 'object' && !Array.isArray(frame.result) && frame.result.action === 'accept' && !('content' in frame.result)), false);
  consent.resolve('accept');
  assert.deepEqual((await response).result, { action: 'accept' });
  peer.send({ jsonrpc: '2.0', method: 'elicitation/complete', params: { elicitationId: 'url:1' } });
  await urlCompleted.promise;
  peer.send({ jsonrpc: '2.0', id: authenticateId, result: {} });
  const completed = (await stream.next()).value;
  assert.equal(completed?.kind, 'authentication');
  if (completed?.kind === 'authentication') assert.equal(completed.progress.status, 'completed');
  assert.equal((await stream.next()).done, true);
  assert.equal(released, 1);
  assert.equal((await peer.request('elicitation/create', { ...form, requestId: authenticateId })).error?.code, -32602);
  assert.equal(forms, 1);
  await instance.adapter.createSession(hostSessionContext());
  assert.equal(peer.frames.filter((frame) => frame.method === 'initialize').length, 1);
  assert.equal(peer.frames.filter((frame) => frame.method === 'authenticate').length, 1);
  const inactive = await instance.adapter.authentication.cancel({ attemptId: 'auth:1' });
  assert.equal(inactive.status, 'failed');
  assert.equal(inactive.error?.category, 'invalid_request');
  assert.deepEqual(inactive.error?.recovery, { kind: 'none' });
});

for (const action of ['cancel', 'dispose'] as const) {
  test(`${action} retires authentication and owned URL UI while the progress consumer is paused`, { timeout: 2_000 }, async (t) => {
    const peer = createHostPeer(agentInitialize);
    let requestId: string | number | undefined;
    const started = fixtureDeferred<void>();
    let released = 0;
    let signal: AbortSignal | undefined;
    peer.handle((frame) => { if (frame.method === 'authenticate') { requestId = frame.id; return true; } });
    const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease,
      authentication: { browser: { methodId: 'fixture-browser' } }, host: { url(input) {
        signal = input.signal; started.resolve();
        return { decision: new Promise<AcpHostUrlDecision>(() => {}), release() { released += 1; } };
      } } }).materialize(hostDefinition);
    assert.equal(instance.adapter.authentication.kind, 'supported');
    if (instance.adapter.authentication.kind !== 'supported') return;
    const progress = instance.adapter.authentication.start({ attemptId: 'auth:paused', flow: 'browser' })[Symbol.asyncIterator]();
    t.after(async () => { await instance.dispose(); peer.destroy(); });
    await progress.next();
    await peer.wait((frame) => frame.method === 'authenticate');
    assert.ok(requestId);
    const reverse = peer.request('elicitation/create', { requestId, mode: 'url', message: 'Authorize', elicitationId: 'paused', url: 'https://login.example.invalid/' });
    void reverse;
    await started.promise;
    if (action === 'cancel') {
      const result = await instance.adapter.authentication.cancel({ attemptId: 'auth:paused', reason: 'user_requested' });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'authentication_outcome_uncertain');
    } else await instance.dispose();
    assert.equal(signal?.aborted, true);
    assert.equal(released, 1);
    const terminal = (await progress.next()).value;
    assert.equal(terminal?.kind, 'authentication');
    if (terminal?.kind === 'authentication') assert.equal(terminal.progress.error?.code, 'authentication_outcome_uncertain');
    await progress.return?.();
    await instance.dispose();
    assert.equal(peer.stdout.destroyed, false);
    assert.equal(peer.stdin.destroyed, false);
    peer.destroy();
  });
}

test('terminal authentication uses a separate owned lease and retries failed cleanup only on explicit disposal', { timeout: 2_000 }, async () => {
  const initialize: AcpJsonObject = { protocolVersion: 1, authMethods: [{ type: 'terminal', id: 'login', name: 'Login', args: ['login'], env: { FIXTURE_AUTH: '1' } }] };
  const peers = [createHostPeer(initialize), createHostPeer(initialize)];
  let acquisitions = 0;
  class LoginLease implements AcpHostAuthenticationTerminalLease {
    readonly exited = Promise.resolve({ exitCode: 0 });
    releases = 0;
    release() { this.releases += 1; if (this.releases === 1) throw new Error('private-terminal-release-diagnostic'); }
  }
  const login = new LoginLease();
  const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peers[acquisitions++]!.lease,
    authentication: { terminal: { methodId: 'login' } }, host: { authenticateInTerminal(input) {
      assert.deepEqual(input.args, ['login']); assert.deepEqual(input.env, { FIXTURE_AUTH: '1' }); return login;
    } } }).materialize(hostDefinition);
  assert.equal(instance.adapter.authentication.kind, 'supported');
  if (instance.adapter.authentication.kind !== 'supported') return;
  const outputs = [];
  for await (const output of instance.adapter.authentication.start({ attemptId: 'auth:terminal', flow: 'terminal' })) outputs.push(output);
  assert.equal(login.releases, 1);
  assert.equal(acquisitions, 1);
  assert.equal(outputs.at(-1)?.kind, 'authentication');
  assert.equal(JSON.stringify(outputs).includes('private-terminal-release-diagnostic'), false);
  assert.equal(peers[0]!.frames.some((frame) => frame.method === 'authenticate'), false);
  await assert.rejects(async () => instance.adapter.createSession(hostSessionContext()), (error: unknown) => error instanceof Error && 'reasonCode' in error && error.reasonCode === 'acp_authentication_cleanup_pending');
  assert.equal((await instance.checkReadiness()).status, 'unavailable');
  assert.equal(acquisitions, 1);
  await instance.dispose();
  assert.equal(login.releases, 2);
  await instance.dispose();
  assert.equal(login.releases, 2);
  for (const peer of peers) peer.destroy();
});

test('a never-settling terminal authentication wait removes its abort listener and bounds the outcome', { timeout: 2_000 }, async () => {
  const peer = createHostPeer({ protocolVersion: 1, authMethods: [{ type: 'terminal', id: 'login', name: 'Login' }] });
  let signal: AbortSignal | undefined;
  let releases = 0;
  const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease,
    limits: { authenticationTimeoutMs: 30 }, authentication: { terminal: { methodId: 'login' } }, host: {
      authenticateInTerminal(input) { signal = input.signal; return { exited: new Promise(() => {}), release() { releases += 1; } }; },
    } }).materialize(hostDefinition);
  assert.equal(instance.adapter.authentication.kind, 'supported');
  if (instance.adapter.authentication.kind !== 'supported') return;
  const outputs = [];
  for await (const output of instance.adapter.authentication.start({ attemptId: 'auth:timeout', flow: 'terminal' })) outputs.push(output);
  assert.equal(signal?.aborted, true);
  assert.equal(getEventListeners(signal!, 'abort').length, 0);
  assert.equal(releases, 1);
  const terminal = outputs.at(-1);
  assert.equal(terminal?.kind, 'authentication');
  if (terminal?.kind === 'authentication') assert.equal(terminal.progress.error?.code, 'authentication_outcome_uncertain');
  await instance.dispose(); peer.destroy();
});

test('canceling during terminal lease delivery observes a rejecting exit promise and releases the owned login once', { timeout: 2_000 }, async (t) => {
  const peer = createHostPeer({ protocolVersion: 1, authMethods: [{ type: 'terminal', id: 'login', name: 'Login' }] });
  const entered = fixtureDeferred<void>();
  let releases = 0;
  const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease,
    authentication: { terminal: { methodId: 'login' } }, host: { authenticateInTerminal(input) {
      const exited = new Promise<never>((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
      entered.resolve();
      return { exited, release() { releases += 1; } };
    } } }).materialize(hostDefinition);
  t.after(async () => { await instance.dispose(); peer.destroy(); });
  assert.equal(instance.adapter.authentication.kind, 'supported');
  if (instance.adapter.authentication.kind !== 'supported') return;
  const stream = instance.adapter.authentication.start({ attemptId: 'auth:lease-delivery', flow: 'terminal' })[Symbol.asyncIterator]();
  const first = stream.next();
  await entered.promise;
  assert.equal((await instance.adapter.authentication.cancel({ attemptId: 'auth:lease-delivery' })).status, 'failed');
  await first;
  const result = (await stream.next()).value;
  assert.equal(result?.kind, 'authentication');
  if (result?.kind === 'authentication') assert.equal(result.progress.error?.code, 'authentication_outcome_uncertain');
  assert.equal(releases, 1);
  await stream.return?.();
});

test('terminal authentication reconnect preserves explicit standard extension handling and rejects a changed frozen envelope', { timeout: 2_000 }, async () => {
  for (const changed of [false, true]) {
    const initialize: AcpJsonObject = { protocolVersion: 1, agentInfo: { name: 'fixture', version: '1' }, authMethods: [{ type: 'terminal', id: 'login', name: 'Login' }] };
    const peers = [createHostPeer(initialize), createHostPeer(changed ? { ...initialize, agentInfo: { name: 'fixture', version: '2' } } : initialize)];
    peers[1]!.handle((frame) => {
      if (frame.method === 'initialize') peers[1]!.send({ jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: { servers: [] } });
    });
    let acquisitions = 0;
    let releases = 0;
    const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, unknownExtensionPolicy: 'standard', createConnection: () => peers[acquisitions++]!.lease,
      authentication: { terminal: { methodId: 'login' } }, host: { authenticateInTerminal() { return { exited: Promise.resolve({ exitCode: 0 }), release() { releases += 1; } }; } } }).materialize(hostDefinition);
    assert.equal(instance.adapter.authentication.kind, 'supported');
    if (instance.adapter.authentication.kind !== 'supported') continue;
    const outputs = [];
    for await (const output of instance.adapter.authentication.start({ attemptId: 'auth:reconnect', flow: 'terminal' })) outputs.push(output);
    const terminal = outputs.at(-1);
    assert.equal(terminal?.kind, 'authentication');
    if (terminal?.kind === 'authentication') assert.equal(terminal.progress.status, changed ? 'failed' : 'completed');
    assert.equal(acquisitions, 2);
    assert.equal(releases, 1);
    if (!changed) await instance.adapter.createSession(hostSessionContext());
    assert.equal(peers[1]!.frames.filter((frame) => frame.method === 'session/new').length, changed ? 0 : 1);
    await instance.dispose(); for (const peer of peers) peer.destroy();
  }
});
