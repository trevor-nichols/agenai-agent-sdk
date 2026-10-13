import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentEnvironmentId, parseAgentTurnId } from '@agen-ai/agent-protocol';
import { createAcpProviderDriver, type AcpHostTerminalLease, type AcpHostUrlDecision } from '../src/index.js';
import { createHostPeer, fixtureDeferred, hostDefinition, hostProviderKey, hostSessionContext } from './node-fixtures/host-peer.js';

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
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await peer.request('elicitation/create', { ...params, elicitationId: 'url:2' })).error?.code, -32602);
  assert.equal(opened, 1);
  peer.send({ jsonrpc: '2.0', method: 'elicitation/complete', params: { elicitationId: 'url:1' } });
  await completed.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
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
