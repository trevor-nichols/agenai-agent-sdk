import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentProviderConversationId } from '@agen-ai/agent-protocol';
import { createCodexHistory, type CodexHistoryConnection, type CodexHistoryRequest, type CodexHistoryRequestContext } from '../dist/codex.js';
import type { AgentHistory, AgentHistoryConversationRef, AgentHistoryRecord } from '../src/index.js';

const threadId = '20000001-1111-4111-8111-111111111111';
const otherThreadId = '20000002-1111-4111-8111-111111111111';

function nativeThread(overrides: Record<string, unknown> = {}) {
  return { id: threadId, historyMode: 'legacy', cwd: '/synthetic/project', preview: 'Stored Codex conversation',
    name: null, model: null, createdAt: 1767268800, updatedAt: 1767268860, parentThreadId: null, turns: [], ...overrides };
}

function response(result: unknown): Uint8Array { return Buffer.from(JSON.stringify({ id: 1, result })); }
function nativeError(code: number, message: string): Uint8Array { return Buffer.from(JSON.stringify({ id: 1, error: { code, message } })); }
function code(expected: string) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}

function port(handler: (request: CodexHistoryRequest, context: CodexHistoryRequestContext) => Uint8Array | Promise<Uint8Array>) {
  const trace: CodexHistoryRequest[] = [];
  const connection: CodexHistoryConnection = { runtimeVersion: '0.163.0', request: async (request, context) => {
    trace.push(structuredClone(request));
    assert.equal(context.maxResponseBytes, 2_097_152);
    assert.equal(context.signal.aborted, false);
    return handler(request, context);
  } };
  return { connection, trace };
}

function options(connection: CodexHistoryConnection) {
  return { sourceId: 'borrowed-codex-fixture', generation: 'fixture-generation', scope: { kind: 'all_projects' as const },
    catalogPolicy: 'scan_and_repair' as const, connection, resources: { kind: 'caller_owned' as const } };
}

function ref(history: AgentHistory, id = threadId): AgentHistoryConversationRef {
  return { source: { providerKey: history.source.providerKey, sourceId: history.source.sourceId, generation: history.source.generation },
    conversationId: parseAgentProviderConversationId(id) };
}
function catalog(history: AgentHistory) {
  if (history.catalog.status !== 'supported') assert.fail('Codex catalog must be supported.');
  return history.catalog.list;
}
function lookup(history: AgentHistory) {
  if (history.lookup.status !== 'supported') assert.fail('Codex metadata lookup must be supported.');
  return history.lookup.get;
}
function transcript(history: AgentHistory) {
  if (history.transcript.status !== 'supported') assert.fail('Codex main transcript must be supported.');
  return history.transcript.read;
}
function metadataSearch(history: AgentHistory) {
  if (history.metadataSearch.status !== 'supported') assert.fail('Codex native title search must be supported.');
  return history.metadataSearch.search;
}

test('borrowed Codex title search delegates only native metadata and binds continuation to its query', async (t) => {
  const native = port((request) => {
    if (request.method !== 'thread/list') assert.fail('Title search must not read transcript content.');
    assert.equal(request.params.searchTerm, 'Stored');
    const next = request.params.cursor !== undefined;
    return response({ data: [nativeThread({ id: next ? otherThreadId : threadId })], nextCursor: next ? null : 'native-search-next' });
  });
  const history = createCodexHistory(options(native.connection));
  t.after(() => history.close());
  const first = await metadataSearch(history)({ query: 'Stored', limit: 1 });
  assert.equal(first.items[0].conversation.title, 'Stored Codex conversation');
  assert(first.nextCursor);
  const before = native.trace.length;
  await assert.rejects(metadataSearch(history)({ query: 'Changed', limit: 1, cursor: first.nextCursor }), code('invalid_cursor'));
  assert.equal(native.trace.length, before);
  assert.equal((await metadataSearch(history)({ query: 'Stored', limit: 1, cursor: first.nextCursor })).items[0].conversation.ref.conversationId, otherThreadId);
});

test('Codex management dispatches only after quiescent scope checks and preserves its native receipt across refresh failure', async (t) => {
  let failReads = false;
  const native = port((request) => {
    if (request.method === 'thread/read') return failReads ? nativeError(-32603, 'Synthetic refresh failure')
      : response({ thread: nativeThread({ status: { type: 'notLoaded' } }) });
    assert.deepEqual(request, { method: 'thread/name/set', params: { threadId, name: 'Explicit stored title' } });
    return response({});
  });
  const history = createCodexHistory({ ...options(native.connection), management: ['rename'] });
  t.after(() => history.close());
  if (history.rename.status !== 'supported') assert.fail('Explicit rename selection must be available.');
  assert.equal(history.archive.status, 'unsupported');
  const effects = history.rename.descriptor.effects;
  const rejected = await history.rename.apply({ conversation: ref(history), title: 'Explicit stored title', acceptEffects: { ...effects, descendants: 'descendants' } });
  assert.equal(rejected.status, 'not_applied');
  assert.equal(native.trace.length, 0);
  const receipt = await history.rename.apply({ conversation: ref(history), title: 'Explicit stored title', acceptEffects: effects });
  assert.deepEqual(receipt, { status: 'applied', ref: ref(history) });
  assert.deepEqual(native.trace.map((request) => request.method), ['thread/read', 'thread/name/set']);
  failReads = true;
  await assert.rejects(lookup(history)({ conversation: ref(history) }), code('native_failure'));
  assert.equal(receipt.status, 'applied');
});

test('Codex missing, foreign and active prechecks remain not applied without dispatching a native mutator', async (t) => {
  for (const fixture of [
    { result: nativeError(-32600, `thread not loaded: ${threadId}`), reason: 'not_found' },
    { result: response({ thread: nativeThread({ cwd: '/synthetic/other-project', status: { type: 'notLoaded' } }) }), reason: 'unsupported_scope' },
    { result: response({ thread: nativeThread({ status: { type: 'active' } }) }), reason: 'unsupported_scope' },
  ]) {
    const native = port(() => fixture.result);
    const history = createCodexHistory({ ...options(native.connection), management: ['delete'],
      scope: { kind: 'project', projectPath: '/synthetic/project', worktrees: 'excluded' } });
    t.after(() => history.close());
    if (history.delete.status !== 'supported') assert.fail('Delete was explicitly selected.');
    const receipt = await history.delete.apply({ conversation: ref(history), acceptEffects: history.delete.descriptor.effects });
    assert.equal(receipt.status, 'not_applied');
    if (receipt.status !== 'not_applied') assert.fail('A precheck must retain a definitive rejection.');
    assert.equal(receipt.reason.code, fixture.reason);
    assert.deepEqual(native.trace.map((request) => request.method), ['thread/read']);
    await history.close();
  }
});

test('Codex lost mutation responses are uncertain without retry and fence later mutation while reads survive', async (t) => {
  const native = port((request) => {
    if (request.method === 'thread/read') return response({ thread: nativeThread({ status: { type: 'idle' } }) });
    assert.equal(request.method, 'thread/name/set');
    throw new Error('Connection lost after accepting the native rename.');
  });
  const history = createCodexHistory({ ...options(native.connection), management: ['rename'] });
  t.after(() => history.close());
  if (history.rename.status !== 'supported') assert.fail('Rename was explicitly selected.');
  const input = { conversation: ref(history), title: 'Explicit stored title', acceptEffects: history.rename.descriptor.effects };
  assert.equal((await history.rename.apply(input)).status, 'outcome_unknown');
  const before = native.trace.length;
  assert.equal((await history.rename.apply(input)).status, 'not_applied');
  assert.equal(native.trace.length, before);
  assert.equal((await lookup(history)({ conversation: ref(history) })).title, 'Stored Codex conversation');
  assert.equal(native.trace.filter((request) => request.method === 'thread/name/set').length, 1);
});

async function records(history: AgentHistory): Promise<AgentHistoryRecord[]> {
  const result: AgentHistoryRecord[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = await transcript(history)({ conversation: ref(history), limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    assert.equal(page.coverage.view, 'retained_chain');
    assert.equal(page.coverage.children, 'excluded');
    result.push(...page.items);
    if (page.nextCursor === undefined) return result;
    cursor = page.nextCursor;
  }
  assert.fail('The finite fixture must complete within twenty public pages.');
}

test('borrowed Codex legacy traversal preserves mixed records across intra-turn continuations without execution methods', async (t) => {
  const firstItems = [
    { type: 'userMessage', id: 'item-user', content: [{ type: 'text', text: 'Stored user input' }, { type: 'image', url: 'https://fixture.invalid/image.png', detail: null }] },
    { type: 'reasoning', id: 'item-thinking', summary: ['Stored reasoning summary'], content: ['Stored reasoning detail'] },
    { type: 'commandExecution', id: 'item-command', command: 'printf stored', cwd: '/synthetic/project', status: 'completed', aggregatedOutput: 'Stored command output', exitCode: 0 },
    { type: 'functionCallOutput', id: 'item-function-output', name: 'fixture-function', output: 'Stored function output' },
    { type: 'contextCompaction', id: 'item-compaction' },
    { type: 'futureStoredVariant', id: 'item-unknown', secretPayload: 'never execute this' },
    { type: 'agentMessage', id: 'item-assistant', text: 'Stored first answer' },
  ];
  const connection = port((request) => {
    if (request.method === 'thread/read') return response({ thread: nativeThread() });
    if (request.method === 'thread/turns/list') {
      const second = request.params.cursor === 'next-native-turn';
      return response({ data: [{ id: second ? 'turn-second' : 'turn-first', itemsView: 'full', status: 'completed',
        items: second ? [{ type: 'agentMessage', id: 'item-final', text: 'Stored final answer' }] : firstItems }],
      nextCursor: second ? null : 'next-native-turn' });
    }
    assert.fail(`Legacy traversal must use saved turn pages, received ${request.method}.`);
  });
  const history = createCodexHistory(options(connection.connection));
  t.after(() => history.close());
  const actual = await records(history);
  assert.deepEqual(actual.map((record) => record.kind), ['message', 'message', 'tool_call', 'tool_result', 'tool_result', 'compaction', 'notice', 'message', 'message']);
  assert.deepEqual(actual[0], { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Stored user input' },
    { kind: 'attachment', attachmentKind: 'image', reference: { kind: 'uri', uri: 'https://fixture.invalid/image.png' } }],
  native: { turnId: 'turn-first', itemId: 'item-user' } });
  assert.deepEqual(actual[1], { kind: 'message', role: 'assistant', content: [
    { kind: 'thinking', text: 'Stored reasoning summary' }, { kind: 'thinking', text: 'Stored reasoning detail' }],
  native: { turnId: 'turn-first', itemId: 'item-thinking' } });
  assert.deepEqual(actual[2], { kind: 'tool_call', name: 'commandExecution', arguments: { command: 'printf stored', cwd: '/synthetic/project' }, native: { turnId: 'turn-first', itemId: 'item-command' } });
  assert.deepEqual(actual[3], { kind: 'tool_result', outcome: 'succeeded', content: [{ kind: 'text', text: 'Stored command output' }], native: { turnId: 'turn-first', itemId: 'item-command' } });
  assert.deepEqual(actual[4], { kind: 'tool_result', outcome: 'unknown', content: [{ kind: 'text', text: 'Stored function output' }], native: { turnId: 'turn-first', itemId: 'item-function-output' } });
  assert.equal(actual[6].kind === 'notice' ? actual[6].code : undefined, 'codex.unsupported_record_kind');
  assert.deepEqual(actual.slice(-2).map((record) => record.kind === 'message' ? record.content : record), [
    [{ kind: 'text', text: 'Stored first answer' }], [{ kind: 'text', text: 'Stored final answer' }],
  ]);
  assert.deepEqual(actual.map((record) => record.native?.itemId), ['item-user', 'item-thinking', 'item-command', 'item-command', 'item-function-output', 'item-compaction', 'item-unknown', 'item-assistant', 'item-final']);
  assert.equal(connection.trace.some((request) => request.method === 'thread/turns/list'), true);
  assert.deepEqual([...new Set(connection.trace.map((request) => request.method))].sort(), ['thread/read', 'thread/turns/list']);
  for (const operation of [history.rename, history.archive, history.restore, history.delete]) {
    assert.equal(operation.status, 'unsupported'); assert.equal('apply' in operation, false);
  }
});

test('borrowed Codex indexed item pages retain order and native references across native continuations', async (t) => {
  const items = [
    { turnId: 'turn-a', item: { type: 'userMessage', id: 'indexed-user', content: [{ type: 'text', text: 'Indexed user' }] } },
    { turnId: 'turn-a', item: { type: 'agentMessage', id: 'indexed-answer', text: 'Indexed answer' } },
    { turnId: 'turn-b', item: { type: 'agentMessage', id: 'indexed-final', text: 'Indexed final' } },
  ];
  const connection = port((request) => {
    if (request.method === 'thread/read') return response({ thread: nativeThread({ historyMode: 'paginated' }) });
    if (request.method === 'thread/items/list') {
      const start = request.params.cursor === undefined ? 0 : Number(request.params.cursor.slice('native-item-'.length));
      const end = Math.min(start + request.params.limit, items.length);
      return response({ data: items.slice(start, end), nextCursor: end === items.length ? null : `native-item-${end}` });
    }
    assert.fail(`Indexed traversal must use indexed item pages, received ${request.method}.`);
  });
  const history = createCodexHistory(options(connection.connection));
  t.after(() => history.close());
  const actual = await records(history);
  assert.deepEqual(actual.map((record) => record.kind === 'message' ? record.content : record), [
    [{ kind: 'text', text: 'Indexed user' }], [{ kind: 'text', text: 'Indexed answer' }], [{ kind: 'text', text: 'Indexed final' }],
  ]);
  assert.deepEqual(actual.map((record) => record.native), [
    { turnId: 'turn-a', itemId: 'indexed-user' }, { turnId: 'turn-a', itemId: 'indexed-answer' }, { turnId: 'turn-b', itemId: 'indexed-final' },
  ]);
  assert.equal(connection.trace.filter((request) => request.method === 'thread/items/list').some((request) => request.params.cursor !== undefined), true);
});

test('borrowed Codex catalog translates explicit native filters and preserves parent metadata', async (t) => {
  const connection = port((request) => {
    assert.equal(request.method, 'thread/list');
    return response({ data: [nativeThread({ id: otherThreadId, preview: 'Child saved history', parentThreadId: threadId,
      cwd: '/synthetic/other-project', model: 'stored-model' })], nextCursor: null });
  });
  const history = createCodexHistory({ ...options(connection.connection), catalogPolicy: 'state_db_only' });
  t.after(() => history.close());
  const page = await catalog(history)({ limit: 1, order: 'created_asc', projectPath: '/synthetic/other-project',
    sourceKinds: ['exec', 'subAgentThreadSpawn'], archived: 'only' });
  assert.deepEqual(connection.trace, [{ method: 'thread/list', params: { limit: 1, sortKey: 'created_at', sortDirection: 'asc',
    modelProviders: [], sourceKinds: ['exec', 'subAgentThreadSpawn'], archived: true, cwd: '/synthetic/other-project', useStateDbOnly: true } }]);
  assert.equal(page.items[0].title, 'Child saved history');
  assert.equal(page.items[0].model, 'stored-model');
  assert.deepEqual(page.items[0].parent, ref(history));
  assert.equal(page.items[0].archiveState, 'archived');
  assert.equal(page.consistency, 'live');
  const spawnSource = (parent: unknown) => ({ subAgent: { thread_spawn: { parent_thread_id: parent } } });
  const lineageCases = [
    { name: 'null primary uses native spawn parent', primary: null, source: spawnSource(threadId), outcome: 'parent' },
    { name: 'absent primary uses native spawn parent', primary: undefined, source: spawnSource(threadId), outcome: 'parent' },
    { name: 'explicit primary takes precedence', primary: threadId, source: spawnSource(otherThreadId), outcome: 'parent' },
    { name: 'unknown source remains inert', primary: null, source: { subAgent: { future_kind: { parent_thread_id: threadId } } }, outcome: 'none' },
    { name: 'invalid recognized parent is rejected', primary: null, source: spawnSource(' invalid-parent '), outcome: 'error' },
    { name: 'oversized recognized parent is rejected', primary: null, source: spawnSource('x'.repeat(513)), outcome: 'error' },
  ];
  for (const fixture of lineageCases) {
    const native = port(() => response({ data: [nativeThread({ id: otherThreadId, parentThreadId: fixture.primary, source: fixture.source })], nextCursor: null }));
    const source = createCodexHistory(options(native.connection));
    t.after(() => source.close());
    if (fixture.outcome === 'error') {
      await assert.rejects(catalog(source)({ limit: 1 }), code('native_failure'), fixture.name);
    } else {
      const result = await catalog(source)({ limit: 1 });
      assert.equal(result.items[0].ref.conversationId, otherThreadId, fixture.name);
      assert.deepEqual(result.items[0].parent, fixture.outcome === 'parent' ? ref(source) : undefined, fixture.name);
    }
    await source.close();
  }
});

test('borrowed Codex malformed and oversized response frames fail explicitly while subsequent reads remain usable', async (t) => {
  const cases = [
    { bytes: Buffer.from([0xff]), error: 'native_failure' },
    { bytes: Buffer.from('{invalid-json'), error: 'native_failure' },
    { bytes: Buffer.from(JSON.stringify({ id: 1, result: {}, error: { code: -32600, message: 'ambiguous' } })), error: 'native_failure' },
    { bytes: Buffer.alloc(2_097_153, 32), error: 'limit_exhausted' },
    { bytes: response({ thread: nativeThread({ id: otherThreadId }) }), error: 'native_failure' },
  ];
  for (const fixture of cases) {
    let first = true;
    const connection = port(() => { if (first) { first = false; return fixture.bytes; } return response({ thread: nativeThread() }); });
    const history = createCodexHistory(options(connection.connection));
    t.after(() => history.close());
    await assert.rejects(lookup(history)({ conversation: ref(history) }), code(fixture.error));
    assert.equal((await lookup(history)({ conversation: ref(history) })).title, 'Stored Codex conversation');
    await history.close();
  }
});

test('borrowed Codex empty saved threads remain distinct from missing and unsupported native reads', async (t) => {
  let unsupported = false;
  const connection = port((request) => {
    if (request.method !== 'thread/list' && request.params.threadId === otherThreadId) return nativeError(-32600, `thread not loaded: ${otherThreadId}`);
    if (request.method === 'thread/read') return response({ thread: nativeThread({ preview: '' }) });
    if (request.method === 'thread/turns/list' && !unsupported) return response({ data: [], nextCursor: null });
    return nativeError(-32601, 'thread/items/list is not supported yet');
  });
  const history = createCodexHistory(options(connection.connection));
  t.after(() => history.close());
  assert.equal((await lookup(history)({ conversation: ref(history) })).ref.conversationId, threadId);
  assert.deepEqual((await transcript(history)({ conversation: ref(history), limit: 1 })).items, []);
  await assert.rejects(lookup(history)({ conversation: ref(history, otherThreadId) }), code('not_found'));
  await assert.rejects(transcript(history)({ conversation: ref(history, otherThreadId), limit: 1 }), code('not_found'));
  unsupported = true;
  await assert.rejects(transcript(history)({ conversation: ref(history), limit: 1 }), code('unsupported_scope'));
});

test('borrowed Codex continuation rejects changed store mode and retained item anchors', async (t) => {
  for (const change of ['mode', 'anchor'] as const) {
    let changed = false;
    const connection = port((request) => {
      if (request.method === 'thread/read') return response({ thread: nativeThread({ historyMode: changed && change === 'mode' ? 'paginated' : 'legacy' }) });
      if (request.method === 'thread/turns/list') return response({ data: [{ id: 'turn-stable', itemsView: 'full', status: 'completed', items: [
        { type: 'agentMessage', id: changed && change === 'anchor' ? 'replaced-item' : 'item-stable', text: 'First retained answer' },
        { type: 'agentMessage', id: changed && change === 'anchor' ? 'replaced-next-item' : 'item-next', text: 'Second retained answer' },
      ] }], nextCursor: null });
      assert.fail('Changed history must reject the old continuation instead of switching native traversal methods.');
    });
    const history = createCodexHistory(options(connection.connection));
    t.after(() => history.close());
    const first = await transcript(history)({ conversation: ref(history), limit: 1 });
    assert.deepEqual(first.items.map((item) => item.kind === 'message' ? item.content : item), [[{ kind: 'text', text: 'First retained answer' }]]);
    if (first.nextCursor === undefined) assert.fail('The first retained record must carry a continuation.');
    changed = true;
    await assert.rejects(transcript(history)({ conversation: ref(history), limit: 1, cursor: first.nextCursor }), code('invalid_cursor'));
    await history.close();
  }
});

test('closing a borrowed Codex source aborts its entered read and leaves the caller connection usable', async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  let block = true;
  const connection = port(async (_request, context) => {
    if (!block) return response({ thread: nativeThread() });
    entered.resolve(context.signal);
    await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('The caller-owned connection stopped this read after its source signal.');
  });
  const history = createCodexHistory(options(connection.connection));
  const reading = lookup(history)({ conversation: ref(history) });
  const rejection = assert.rejects(reading, code('closed'));
  const signal = await entered.promise;
  await history.close();
  await rejection;
  assert.equal(signal.aborted, true);
  block = false;
  const direct = await connection.connection.request({ method: 'thread/read', params: { threadId, includeTurns: false } },
    { signal: new AbortController().signal, maxResponseBytes: 2_097_152 });
  assert.equal(new TextDecoder().decode(direct).includes('Stored Codex conversation'), true);
  const nextHistory = createCodexHistory({ ...options(connection.connection), sourceId: 'reused-caller-connection' });
  try { assert.equal((await lookup(nextHistory)({ conversation: ref(nextHistory) })).title, 'Stored Codex conversation'); }
  finally { await nextHistory.close(); }
});
