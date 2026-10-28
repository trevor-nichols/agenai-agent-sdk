import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { Sandbox } from '@agen-ai/sandbox';
import { createCredentialFixture } from '../../credentials/tests/fixture.js';
import { runSandboxGrokTurn, SandboxGrokRunError } from '../run.js';
import { budgets } from './fixture.js';
import { nativeInitializeResponse } from './native-session.js';

const noFileRequest = {
  stat() { throw new Error('No file request in this protocol fixture.'); },
  list() { throw new Error('No file request in this protocol fixture.'); },
  readFile() { throw new Error('No file request in this protocol fixture.'); },
};

async function peerFixture({ firstStopFails = false, files }: { firstStopFails?: boolean; files?: Sandbox['files'] } = {}) {
  const fixture = createCredentialFixture({ finishOnEof: false, firstStopFails });
  const original = await fixture.owner.start();
  // The public memory backend owns process/stop. The default byte-only port grants no controller files.
  const sandbox: Sandbox = { ...original, get state() { return original.state; },
    files: files ?? { kind: 'read_only', ...noFileRequest } };
  let cursor = 0;
  const next = async () => {
    for (let attempt = 0; attempt < 2000; attempt++) {
      const lines = Buffer.concat(fixture.received).toString('utf8').split('\n').filter(Boolean);
      const line = lines[cursor];
      if (line !== undefined) {
        cursor++;
        const frame: unknown = JSON.parse(line);
        if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Malformed fixture host frame.');
        return frame;
      }
      await setImmediate();
    }
    throw new Error('The fixture did not receive its next host frame.');
  };
  const send = (frame: unknown) => fixture.stdout.push(Buffer.from(`${JSON.stringify(frame)}\n`));
  const open = async ({ write = false } = {}) => {
    const initialize = await next();
    assert('id' in initialize && 'method' in initialize);
    assert.equal(initialize.method, 'initialize');
    assert.equal(initialize.id, 'sandbox-grok:1');
    assert('result' in nativeInitializeResponse);
    send({ ...nativeInitializeResponse, id: initialize.id });
    const create = await next();
    assert('id' in create && 'method' in create && 'params' in create);
    assert.equal(create.method, 'session/new');
    assert.deepEqual(create.params, { cwd: '/workspace/work', mcpServers: [],
      _meta: { clientFsRead: true, clientFsWrite: write, clientTerminal: false } });
    send({ jsonrpc: '2.0', id: create.id, result: { sessionId: 'selected-session', models: { currentModelId: 'grok-build-0.1',
      availableModels: [{ modelId: 'grok-build-0.1', name: 'Selected model' }] } } });
    const prompt = await next();
    assert('id' in prompt && 'method' in prompt);
    assert.equal(prompt.method, 'session/prompt');
    return prompt.id;
  };
  return { fixture, sandbox, next, send, open };
}

function request(signal?: AbortSignal) {
  return { launch: { credential: { kind: 'api_key' as const, value: 'synthetic-xai-key' }, guestExecutable: '/opt/agenai/native/grok' as const },
    task: 'Perform one explicitly permitted edit.', grant: { kind: 'read_only' as const }, budgets,
    onSessionUpdate() {}, allowPermission: () => true, ...(signal === undefined ? {} : { signal }) };
}

const nativeUpdate = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'selected-session',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'sensitive-native-output' } } } };

for (const timing of ['after_cleanup_starts', 'same_chunk_as_completion'] as const) {
  test(`Grok preserves observer rejection ${timing}`, { timeout: 5000 }, async (t) => {
    const peer = await peerFixture();
    t.after(() => peer.fixture.owner.destroy());
    const observer = Promise.withResolvers<void>();
    let entered = false;
    const observed = runSandboxGrokTurn(peer.sandbox, { ...request(), onSessionUpdate() {
      entered = true;
      if (timing === 'same_chunk_as_completion') throw new Error('sensitive-observer-failure');
      return observer.promise;
    } }).catch((error: unknown) => error);
    const promptId = await peer.open();
    const terminal = { jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } };
    if (timing === 'same_chunk_as_completion') {
      peer.fixture.stdout.push(Buffer.from([terminal, nativeUpdate].map((frame) => JSON.stringify(frame)).join('\n') + '\n'));
    } else {
      peer.send(nativeUpdate);
      peer.send(terminal);
      for (let attempt = 0; attempt < 2000 && peer.fixture.stopAttempts === 0; attempt++) await setImmediate();
      assert(entered);
      assert.equal(peer.fixture.stopAttempts, 1);
      observer.reject(new Error('sensitive-observer-failure'));
    }
    const result: unknown = await observed;
    assert(entered);
    assert(result instanceof SandboxGrokRunError);
    assert.equal(result.code, 'execution_failed');
    await result.retryCleanup();
    assert.equal(peer.fixture.processCalls, 1);
    assert.equal(peer.fixture.stopAttempts, 1);
    assert.deepEqual([...peer.fixture.resources], ['storage']);
    assert(!JSON.stringify(result).includes('sensitive-observer-failure'));
  });
}

test('Grok rejects a fatal final protocol frame even after the prompt response settled', { timeout: 5000 }, async (t) => {
  const peer = await peerFixture();
  t.after(() => peer.fixture.owner.destroy());
  const observed = runSandboxGrokTurn(peer.sandbox, request()).catch((error: unknown) => error);
  const promptId = await peer.open();
  peer.fixture.stdout.push(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } }) + '\nnot-json\n'));
  const result: unknown = await observed;
  assert(result instanceof SandboxGrokRunError);
  assert.equal(result.code, 'execution_failed');
  assert.deepEqual([...peer.fixture.resources], ['storage']);
});

test('Grok retains cleanup ownership of an observer that outlives shutdown until its later settlement', { timeout: 5000 }, async (t) => {
  const peer = await peerFixture();
  t.after(() => peer.fixture.owner.destroy());
  const observer = Promise.withResolvers<void>();
  let entered = false;
  const observed = runSandboxGrokTurn(peer.sandbox, { ...request(), limits: { shutdownDrainMs: 10 },
    onSessionUpdate() { entered = true; return observer.promise; } }).catch((error: unknown) => error);
  const promptId = await peer.open();
  peer.send(nativeUpdate);
  peer.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  const result: unknown = await observed;
  assert(entered);
  assert(result instanceof SandboxGrokRunError);
  assert.equal(result.code, 'cleanup_failed');
  await assert.rejects(result.retryCleanup(), (error: unknown) => error instanceof SandboxGrokRunError && error.code === 'cleanup_failed');
  observer.reject(new Error('sensitive-late-observer-failure'));
  await setImmediate();
  await result.retryCleanup();
  assert.equal(peer.fixture.processCalls, 1);
  assert.equal(peer.fixture.stopAttempts, 1);
  assert.deepEqual([...peer.fixture.resources], ['storage']);
});

test('Grok ACP keeps one reader through session binding, sensitive updates and exact once-only native permission', { timeout: 5000 }, async (t) => {
  const peer = await peerFixture();
  t.after(() => peer.fixture.owner.destroy());
  let policyCalls = 0; let observedUpdates = 0;
  const pending = runSandboxGrokTurn(peer.sandbox, { ...request(), onSessionUpdate() { observedUpdates++; },
    allowPermission(tool) { policyCalls++; return tool.kind === 'edit'; } });
  const observed = pending.catch((error: unknown) => ({ error }));
  const promptId = await peer.open();
  peer.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'selected-session',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'sensitive-native-output' } } } });
  const once = { optionId: 'once', kind: 'allow_once', name: 'Once' };
  const always = { optionId: 'always', kind: 'allow_always', name: 'Always' };
  const rows = [
    { id: 1, sessionId: 'another-session', options: [once], expected: { outcome: 'cancelled' } },
    { id: 2, sessionId: 'selected-session', options: [always], expected: { outcome: 'cancelled' } },
    { id: 3, sessionId: 'selected-session', options: [always, once], expected: { outcome: 'selected', optionId: 'once' } },
  ];
  for (const row of rows) {
    peer.send({ jsonrpc: '2.0', id: row.id, method: 'session/request_permission', params: {
      sessionId: row.sessionId, toolCall: { toolCallId: `tool-${row.id}`, kind: 'edit' }, options: row.options } });
    assert.deepEqual(await peer.next(), { jsonrpc: '2.0', id: row.id, result: { outcome: row.expected } });
  }
  peer.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  const result = await observed;
  assert(!('error' in result));
  assert.deepEqual({ stopReason: result.stopReason, updates: result.updates, permissionSelections: result.permissionSelections },
    { stopReason: 'end_turn', updates: 1, permissionSelections: 1 });
  assert.equal(policyCalls, 1);
  assert.equal(observedUpdates, 1);
  assert.equal(peer.fixture.processCalls, 1);
  assert.deepEqual([...peer.fixture.resources], ['storage']);
  assert(!JSON.stringify(result).includes('sensitive-native-output'));
});

test('Grok cancellation fences its pending native prompt and stops the original reservation without credential replay', { timeout: 5000 }, async (t) => {
  const peer = await peerFixture();
  t.after(() => peer.fixture.owner.destroy());
  const controller = new AbortController();
  const observed = runSandboxGrokTurn(peer.sandbox, request(controller.signal)).catch((error: unknown) => error);
  await peer.open();
  controller.abort();
  const result: unknown = await observed;
  assert(result instanceof SandboxGrokRunError);
  assert.equal(result.code, 'cancelled');
  assert.equal(peer.fixture.processCalls, 1);
  assert.deepEqual([...peer.fixture.resources], ['storage']);
  assert.equal(peer.fixture.stopAttempts, 1);
  assert(!JSON.stringify(result).includes('synthetic-xai-key'));
});

for (const firstStopFails of [false, true]) {
  test(`Grok fails the turn on an uncertain live-file write and ${firstStopFails ? 'retries its failed original stop' : 'still completes cleanup'}`, { timeout: 5000 }, async (t) => {
    const writes: number[] = [];
    const peer = await peerFixture({ firstStopFails, files: { kind: 'read_write', ...noFileRequest,
      async writeFile(_path, source) {
        let bytes = 0;
        for await (const chunk of source) bytes += chunk.byteLength;
        writes.push(bytes);
        return { kind: 'uncertain', effect: 'unknown', bytes: null };
      } } });
    t.after(() => peer.fixture.owner.destroy());
    const observed = runSandboxGrokTurn(peer.sandbox, { ...request(), grant: { kind: 'read_write' } }).catch((error: unknown) => error);
    const promptId = await peer.open({ write: true });
    peer.send({ jsonrpc: '2.0', id: 'native-write', method: 'fs/write_text_file',
      params: { sessionId: 'selected-session', path: '/workspace/work/result.txt', content: 'possibly published' } });
    const rejected = await peer.next();
    assert('id' in rejected && 'error' in rejected);
    assert.equal(rejected.id, 'native-write');
    // A native turn can still end normally after the host rejected one of its writes.
    peer.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    const result: unknown = await observed;
    assert(result instanceof SandboxGrokRunError);
    assert.equal(result.code, firstStopFails ? 'cleanup_failed' : 'execution_failed');
    await result.retryCleanup();
    assert.equal(peer.fixture.stopAttempts, firstStopFails ? 2 : 1);
    assert.deepEqual([...peer.fixture.resources], ['storage']);
    assert.deepEqual(writes, [Buffer.byteLength('possibly published')]);
  });
}

for (const incompatible of ['version', 'auth_route', 'model'] as const) {
  test(`Grok rejects incompatible native ${incompatible} before prompt dispatch`, { timeout: 5000 }, async (t) => {
    const peer = await peerFixture();
    t.after(() => peer.fixture.owner.destroy());
    const observed = runSandboxGrokTurn(peer.sandbox, request()).catch((error: unknown) => error);
    const initialize = await peer.next();
    assert('id' in initialize);
    assert('result' in nativeInitializeResponse);
    const nativeResult = nativeInitializeResponse.result;
    assert(nativeResult !== null && typeof nativeResult === 'object' && !Array.isArray(nativeResult));
    peer.send({ ...nativeInitializeResponse, id: initialize.id, result: { ...nativeResult,
      ...(incompatible === 'version' ? { _meta: { agentVersion: '1.0.70' } } : {}),
      ...(incompatible === 'auth_route' ? { authMethods: [{ id: 'browser', name: 'Unselected browser route' }] } : {}),
    } });
    if (incompatible === 'model') {
      const session = await peer.next();
      assert('id' in session);
      peer.send({ jsonrpc: '2.0', id: session.id, result: { sessionId: 'selected-session', models: { currentModelId: 'unselected-model',
        availableModels: [{ modelId: 'unselected-model', name: 'Unselected model' }] } } });
    }
    const result: unknown = await observed;
    assert(result instanceof SandboxGrokRunError);
    assert.equal(result.code, 'execution_failed');
    const dispatched: { method?: string }[] = Buffer.concat(peer.fixture.received).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(dispatched.map((frame) => frame.method), incompatible === 'model' ? ['initialize', 'session/new'] : ['initialize']);
    assert.deepEqual([...peer.fixture.resources], ['storage']);
  });
}
