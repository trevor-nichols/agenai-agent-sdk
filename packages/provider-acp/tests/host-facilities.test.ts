import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { parseAgentEnvironmentId, parseAgentTurnId } from '@agen-ai/agent-protocol';
import { AgentProviderSessionCleanupError, createAgentProviderRegistry, type AgentProviderOutput } from '@agen-ai/agent-runtime';
import { createAcpProviderDriver, type AcpHostFormInput, type AcpHostFormResponse, type AcpHostTerminalLease, type AcpHostUrlDecision } from '../src/index.js';
import { createHostPeer, fixtureDeferred, hostDefinition, hostProviderKey, hostSessionContext } from './node-fixtures/host-peer.js';
import { hostHumanFixture } from './node-fixtures/host-human.js';

test('filesystem facilities reject unbound and foreign sessions before host callbacks and preserve host authorization errors', { timeout: 2_000 }, async (t) => {
  const peer = createHostPeer();
  let reads = 0;
  let writes = 0;
  let unbound: ReturnType<typeof peer.request> | undefined;
  peer.handle((frame) => {
    if (frame.method === 'initialize') unbound = peer.request('fs/read_text_file', { sessionId: 'native-session', path: '/fixture/readme' });
  });
  const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease, host: {
    readTextFile(input) {
      reads += 1; assert.equal(input.sessionId, hostSessionContext().sessionId); assert.equal(input.workingDirectory, '/fixture');
      if (input.path === '/denied') throw new Error('secret-path-and-token');
      assert.equal(input.line, 2); assert.equal(input.limit, 3); return 'approved document';
    },
    writeTextFile(input) { writes += 1; assert.equal(input.path, '/fixture/write'); assert.equal(input.content, 'text'); },
  } }).materialize(hostDefinition);
  t.after(async () => { await instance.dispose(); peer.destroy(); });
  assert.equal((await unbound)?.error?.code, -32602);
  await instance.adapter.createSession(hostSessionContext());
  assert.equal((await peer.request('fs/read_text_file', { sessionId: 'foreign', path: '/fixture/readme' })).error?.code, -32602);
  assert.equal(reads, 0);
  assert.deepEqual((await peer.request('fs/read_text_file', { sessionId: 'native-session', path: '/fixture/readme', line: 2, limit: 3 })).result, { content: 'approved document' });
  assert.deepEqual((await peer.request('fs/write_text_file', { sessionId: 'native-session', path: '/fixture/write', content: 'text' })).result, {});
  const denied = await peer.request('fs/read_text_file', { sessionId: 'native-session', path: '/denied' });
  assert.equal(denied.error?.code, -32603);
  assert.equal(JSON.stringify(denied).includes('secret-path-and-token'), false);
  assert.equal(reads, 2); assert.equal(writes, 1);
});

test('complete terminal leases preserve output bounds, independent wait/kill, exact session handles and retryable cleanup', { timeout: 3_000 }, async (t) => {
  const peer = createHostPeer();
  class Terminal implements AcpHostTerminalLease {
    readonly exit = fixtureDeferred<{ exitCode: number }>();
    reads = 0;
    kills = 0;
    releases = 0;
    failRelease = false;
    output() { this.reads += 1; return { output: 'a😀éZ', truncated: false }; }
    waitForExit() { return this.exit.promise; }
    kill() { this.kills += 1; this.exit.resolve({ exitCode: 0 }); }
    release() { this.releases += 1; if (this.failRelease) { this.failRelease = false; throw new Error('temporary-terminal-release'); } this.exit.resolve({ exitCode: 0 }); }
  }
  const terminals: Terminal[] = [];
  const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease, host: {
    createTerminal(input) { assert.equal(input.command, '/approved/tool'); assert.deepEqual(input.args, ['test']);
      assert.equal(input.outputByteLimit, 5); const terminal = new Terminal(); terminals.push(terminal); return terminal; },
  } }).materialize(hostDefinition);
  t.after(async () => { await instance.dispose(); peer.destroy(); });
  await instance.adapter.createSession(hostSessionContext());
  const create = await peer.request('terminal/create', { sessionId: 'native-session', command: '/approved/tool', args: ['test'], env: [], outputByteLimit: 5 });
  assert.ok(create.result && typeof create.result === 'object' && !Array.isArray(create.result));
  const terminalId = create.result.terminalId;
  assert.equal(typeof terminalId, 'string');
  const terminal = terminals[0]!;
  assert.equal((await peer.request('terminal/output', { sessionId: 'foreign', terminalId })).error?.code, -32602);
  assert.equal((await peer.request('terminal/output', { sessionId: 'native-session', terminalId: 'unknown' })).error?.code, -32602);
  assert.equal(terminal.reads, 0);
  assert.deepEqual((await peer.request('terminal/output', { sessionId: 'native-session', terminalId })).result, { output: 'éZ', truncated: true });
  const waited = peer.request('terminal/wait_for_exit', { sessionId: 'native-session', terminalId });
  assert.deepEqual((await peer.request('terminal/kill', { sessionId: 'native-session', terminalId })).result, {});
  assert.deepEqual((await waited).result, { exitCode: 0 });
  assert.equal(terminal.kills, 1);
  assert.deepEqual((await peer.request('terminal/release', { sessionId: 'native-session', terminalId })).result, {});
  assert.equal((await peer.request('terminal/output', { sessionId: 'native-session', terminalId })).error?.code, -32602);
  assert.equal(terminal.releases, 1);
  const second = await peer.request('terminal/create', { sessionId: 'native-session', command: '/approved/tool', args: ['test'], outputByteLimit: 5 });
  assert.ok(second.result && typeof second.result === 'object' && !Array.isArray(second.result));
  terminals[1]!.failRelease = true;
  await assert.rejects(async () => instance.dispose(), AggregateError);
  assert.equal(terminals[1]!.releases, 1);
  await instance.dispose();
  assert.equal(terminals[1]!.releases, 2);
  assert.equal(peer.stdout.destroyed, false);
  peer.destroy();
});

test('a finite terminal wait expires independently while its lease remains available for output and explicit release', { timeout: 3000 }, async (t) => {
  const peer = createHostPeer();
  let releases = 0;
  let waitSignal: AbortSignal | undefined;
  const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease,
    limits: { terminalWaitTimeoutMs: 20, hostOperationTimeoutMs: 1000 },
    host: { createTerminal() { return {
      output() { return { output: 'still retained', truncated: false }; },
      waitForExit(signal) { waitSignal = signal; return new Promise<never>(() => {}); },
      kill() {}, release() { releases += 1; },
    }; } },
  }).materialize(hostDefinition);
  t.after(async () => { await instance.dispose(); peer.destroy(); });
  await instance.adapter.createSession(hostSessionContext());
  const created = await peer.request('terminal/create', { sessionId: 'native-session', command: '/approved/tool' });
  assert(created.result && typeof created.result === 'object' && !Array.isArray(created.result));
  const terminalId = created.result.terminalId;
  assert.equal((await peer.request('terminal/wait_for_exit', { sessionId: 'native-session', terminalId })).error?.code, -32603);
  assert.equal(waitSignal?.aborted, true);
  assert.equal(releases, 0);
  assert.deepEqual((await peer.request('terminal/output', { sessionId: 'native-session', terminalId })).result,
    { output: 'still retained', truncated: false });
  assert.deepEqual((await peer.request('terminal/release', { sessionId: 'native-session', terminalId })).result, {});
  assert.equal(releases, 1);
});

test('accepted session URLs retain bounded capacity until completion and never autoaccept declined consent', { timeout: 2_000 }, async (t) => {
  const peer = createHostPeer();
  peer.handle((frame) => frame.method === 'session/prompt');
  let opened = 0;
  let released = 0;
  const completed = fixtureDeferred<void>();
  let decision: AcpHostUrlDecision = 'accept';
  const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease,
    limits: { maxPendingRequests: 1 }, host: { url() {
      opened += 1;
      return { decision: Promise.resolve(decision), release() { released += 1; completed.resolve(); } };
    } } }).materialize(hostDefinition);
  t.after(async () => { await instance.dispose(); peer.destroy(); });
  const session = await instance.adapter.createSession(hostSessionContext());
  const consumed = (async () => {
    for await (const output of session.startTurn({ turnId: parseAgentTurnId('turn:url'), interactionMode: 'default', parts: [{ type: 'text', text: 'Authorize' }] }).outputs) void output;
  })();
  void consumed.catch(() => undefined);
  const prompt = await peer.wait((frame) => frame.method === 'session/prompt');
  const params = { sessionId: 'native-session', mode: 'url', message: 'Authorize', url: 'https://login.example.invalid/', elicitationId: 'url:1' };
  assert.deepEqual((await peer.request('elicitation/create', params)).result, { action: 'accept' });
  await setImmediate();
  assert.equal((await peer.request('elicitation/create', { ...params, elicitationId: 'url:2' })).error?.code, -32602);
  assert.equal(opened, 1);
  peer.send({ jsonrpc: '2.0', method: 'elicitation/complete', params: { elicitationId: 'url:1' } });
  await completed.promise;
  await setImmediate();
  decision = 'decline';
  assert.deepEqual((await peer.request('elicitation/create', { ...params, elicitationId: 'url:2' })).result, { action: 'decline' });
  assert.equal(opened, 2); assert.equal(released, 2);
  peer.send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
  await consumed;
});

test('host callback concurrency is bounded before invoking a second native operation', { timeout: 2_000 }, async (t) => {
  const peer = createHostPeer();
  const content = fixtureDeferred<string>();
  const entered = fixtureDeferred<void>();
  let calls = 0;
  const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease,
    limits: { maxPendingRequests: 1 }, host: { readTextFile() { calls += 1; entered.resolve(); return content.promise; } } }).materialize(hostDefinition);
  t.after(async () => { await instance.dispose(); peer.destroy(); });
  await instance.adapter.createSession(hostSessionContext());
  const first = peer.request('fs/read_text_file', { sessionId: 'native-session', path: '/fixture' });
  await entered.promise;
  assert.equal((await peer.request('fs/read_text_file', { sessionId: 'native-session', path: '/fixture' })).error?.code, -32000);
  assert.equal(calls, 1);
  content.resolve('ready');
  assert.deepEqual((await first).result, { content: 'ready' });
});

test('host-approved MCP setup is sent without inventing connected integration inventory', { timeout: 2_000 }, async (t) => {
  const peer = createHostPeer({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } });
  const servers = [{ name: 'fixture', type: 'http' as const, url: 'https://mcp.example.invalid/', headers: [{ name: 'Authorization', value: 'fixture-secret' }] }];
  const instance = await createAcpProviderDriver({ providerKey: hostProviderKey, createConnection: () => peer.lease, mcpServers: servers }).materialize(hostDefinition);
  t.after(async () => { await instance.dispose(); peer.destroy(); });
  const session = await instance.adapter.createSession(hostSessionContext());
  const frame = peer.frames.find((candidate) => candidate.method === 'session/new');
  assert.deepEqual(frame?.params?.mcpServers, servers);
  assert.equal(instance.capabilities.integrations.kind, 'unsupported');
  assert.equal(session.environment.kind, 'read_and_watch');
  const snapshot = await session.environment.readEnvironment({ signal: new AbortController().signal, environmentId: parseAgentEnvironmentId('environment:fixture') });
  assert.deepEqual(snapshot.integrations, { kind: 'unsupported', reasons: [] });
  assert.equal(JSON.stringify(snapshot).includes('fixture-secret'), false);
});

const nativeForm = { sessionId: 'native-session', mode: 'form', message: 'Choose a native count', requestedSchema: {
  type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['count'],
} };

for (const policy of ['default', 'bounded', 'unbounded'] as const) {
  test(`neutral native host forms use the ${policy} human policy independently of authentication`, { timeout: 5_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-16T12:00:00.000Z') });
    const entered = fixtureDeferred<AbortSignal>();
    const answer = fixtureDeferred<AcpHostFormResponse>();
    const native = policy === 'default' ? undefined : hostHumanFixture(t, () => { answer.resolve({ action: 'cancel' }); });
    const borrowed = native ? undefined : createHostPeer();
    borrowed?.handle((frame) => frame.method === 'session/prompt');
    const peer = native?.peer ?? borrowed!;
    let forms = 0;
    const options = { limits: { authenticationTimeoutMs: 10 }, host: { form(input: AcpHostFormInput) {
        forms += 1; assert.equal(input.scope.kind, 'session'); entered.resolve(input.signal); return answer.promise;
      } } };
    const registry = native ? await native.registered(options) : await createAgentProviderRegistry({ definitions: [hostDefinition], drivers: [createAcpProviderDriver({
      ...options, providerKey: hostProviderKey, createConnection: () => borrowed!.lease,
    })] });
    if (borrowed) t.after(async () => { answer.resolve({ action: 'cancel' }); await registry.dispose(); borrowed.destroy(); });
    const adapter = registry.requireInstance(hostDefinition.instanceId).adapter;
    const session = await adapter.createSession({ ...(native?.context ?? hostSessionContext()),
      ...(policy === 'default' ? {} : { interactions: policy === 'unbounded'
        ? { humanWait: { kind: 'until_withdrawn_or_closed' }, onRequest() { throw new Error('No outside-turn request was offered.'); } }
        : { limits: { requestTimeoutMs: 1_000 }, onRequest() { throw new Error('No outside-turn request was offered.'); } } }),
    });
    const outputs: AgentProviderOutput[] = [];
    const consumed = (async () => {
      for await (const output of session.startTurn({ turnId: parseAgentTurnId(`turn:human:${policy}`), interactionMode: 'default', parts: [{ type: 'text', text: 'Native host form' }] }).outputs) outputs.push(output);
    })();
    void consumed.catch(() => {});
    const prompt = await peer.wait((frame) => frame.method === 'session/prompt');
    const response = peer.request('elicitation/create', nativeForm, 'neutral-form');
    const signal = await entered.promise;
    const wait = policy === 'bounded' ? 1_000 : 300_000;
    t.mock.timers.tick(wait - 1); await setImmediate();
    assert.equal(signal.aborted, false, 'The authentication budget must not time out a neutral session form.');
    t.mock.timers.tick(policy === 'unbounded' ? 2 : 1); await setImmediate();
    assert.equal(signal.aborted, policy !== 'unbounded');
    if (policy !== 'unbounded') {
      const refused = await response;
      assert.equal(refused.error?.code, -32603);
      assert.equal(refused.result, undefined);
    }
    answer.resolve({ action: 'accept', content: { count: 2 } });
    if (policy === 'unbounded') assert.deepEqual((await response).result, { action: 'accept', content: { count: 2 } });
    await setImmediate();
    peer.send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    await consumed;
    assert.equal(forms, 1);
    assert.equal(outputs.some((output) => output.kind === 'event' && output.event.type === 'request.opened'), false);
    assert.equal(peer.frames.filter((frame) => frame.id === 'neutral-form').length, 1);
    await session.close({ reason: 'idle' });
  });
}

test('an ignored neutral form cancellation retains the same actual callback through bounded cleanup and retry', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-16T12:00:00.000Z') });
  const entered = fixtureDeferred<AbortSignal>();
  const answer = fixtureDeferred<AcpHostFormResponse>();
  const fixture = hostHumanFixture(t, () => { answer.resolve({ action: 'cancel' }); });
  const peer = fixture.peer;
  let callbacks = 0;
  const registry = await fixture.registered({
    limits: { hostOperationTimeoutMs: 1_000 }, host: { form(input) { callbacks += 1; entered.resolve(input.signal); return answer.promise; } },
  });
  const session = await registry.requireInstance(hostDefinition.instanceId).adapter.createSession({ ...fixture.context,
    interactions: { humanWait: { kind: 'until_withdrawn_or_closed' }, onRequest() {} },
  });
  const consumed = (async () => {
    for await (const _output of session.startTurn({ turnId: parseAgentTurnId('turn:ignored-form'), interactionMode: 'default', parts: [{ type: 'text', text: 'Retain the original form callback.' }] }).outputs) {}
  })();
  void consumed.catch(() => {});
  await peer.wait((frame) => frame.method === 'session/prompt');
  const response = peer.request('elicitation/create', nativeForm, 'ignored-form');
  const signal = await entered.promise;
  peer.send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 'ignored-form' } });
  assert.equal((await response).error?.code, -32800);
  assert.equal(signal.aborted, true);
  let retained: AgentProviderSessionCleanupError | undefined;
  let cleanupFinished = false;
  const closing = Promise.resolve(session.close({ reason: 'shutdown' })).then(() => { cleanupFinished = true; });
  const refused = assert.rejects(closing, (cause: unknown) => {
    assert.ok(cause instanceof AgentProviderSessionCleanupError); retained = cause; return true;
  });
  void refused.catch(() => {});
  await fixture.nativeClosed;
  await setImmediate();
  assert.equal(cleanupFinished, false, 'Actual native shutdown cannot join an ignored host callback.');
  t.mock.timers.tick(200); await refused;
  assert.ok(retained);
  let joined = false;
  const retry = retained.retryCleanup().then(() => { joined = true; });
  await setImmediate();
  assert.equal(joined, false);
  assert.equal(callbacks, 1);
  answer.resolve({ action: 'accept', content: { count: 2 } });
  await retry;
  await retained.retryCleanup();
  await consumed.catch(() => {});
  assert.equal(joined, true);
  assert.equal(callbacks, 1);
  assert.equal(peer.frames.filter((frame) => frame.id === 'ignored-form').length, 1);
  assert.equal(peer.frames.find((frame) => frame.id === 'ignored-form')?.result, undefined);
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
});

test('URL ceremonies retain their finite authentication deadline under an unbounded session human policy', { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-16T12:00:00.000Z') });
  const decision = fixtureDeferred<AcpHostUrlDecision>();
  const entered = fixtureDeferred<AbortSignal>();
  const fixture = hostHumanFixture(t, () => { decision.resolve('cancel'); });
  const peer = fixture.peer;
  let released = 0;
  const registry = await fixture.registered({ limits: { authenticationTimeoutMs: 1_000 }, host: { url(input) {
    assert.equal(input.scope.kind, 'session'); entered.resolve(input.signal);
    return { decision: decision.promise, release() { released += 1; } };
  } } });
  const session = await registry.requireInstance(hostDefinition.instanceId).adapter.createSession({ ...fixture.context,
    interactions: { humanWait: { kind: 'until_withdrawn_or_closed' }, onRequest() {} },
  });
  const consumed = (async () => {
    for await (const _output of session.startTurn({ turnId: parseAgentTurnId('turn:url-deadline'), interactionMode: 'default', parts: [{ type: 'text', text: 'Authorize a URL ceremony.' }] }).outputs) {}
  })();
  void consumed.catch(() => {});
  const prompt = await peer.wait((frame) => frame.method === 'session/prompt');
  const response = peer.request('elicitation/create', { sessionId: 'native-session', mode: 'url', message: 'Authorize',
    elicitationId: 'url:finite', url: 'https://login.example.invalid/' }, 'finite-url');
  const signal = await entered.promise;
  t.mock.timers.tick(999); await setImmediate();
  assert.deepEqual([signal.aborted, released], [false, 0]);
  t.mock.timers.tick(1);
  const refused = await response;
  assert.equal(refused.error?.code, -32603);
  assert.equal(refused.result, undefined);
  assert.deepEqual([signal.aborted, released], [true, 1]);
  peer.send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
  await consumed;
  await session.close({ reason: 'idle' });
  assert.equal(released, 1);
});
