import assert from 'node:assert/strict';
import type { AgentHistoryRecord, AgentHistoryTranscriptPage } from '@agen-ai/agent-history';
import { createCodexHistory, type CodexHistoryConnection } from '@agen-ai/agent-history/codex';
import { proveBrowseExample } from './browse-example.js';

const ids = ['30000001-1111-4111-8111-111111111111', '30000002-1111-4111-8111-111111111111'] as const;
const methods: string[] = [];
const catalogDirections: string[] = [];
const encode = (result: unknown) => new TextEncoder().encode(JSON.stringify({ id: 1, result }));
const threads = ids.map((id, index) => ({ id, preview: index === 0 ? 'Borrowed Alpha' : 'Borrowed Beta',
  name: null, historyMode: 'legacy', cwd: '/synthetic/project', createdAt: 1767268800 + index,
  updatedAt: 1767268800 + index, parentThreadId: null, model: null, turns: [], status: { type: 'notLoaded' } }));
const turns = [
  { id: 'turn-native-one', itemsView: 'full', items: [
    { id: 'item-native-one', type: 'userMessage', content: [{ type: 'text', text: 'Borrowed question one' }] },
    { id: 'item-native-two', type: 'agentMessage', text: 'Borrowed answer one' },
  ] },
  { id: 'turn-native-two', itemsView: 'full', items: [
    { id: 'item-native-three', type: 'userMessage', content: [{ type: 'text', text: 'Borrowed question two' }] },
    { id: 'item-native-four', type: 'agentMessage', text: 'Borrowed answer two' },
  ] },
];

const connection: CodexHistoryConnection = {
  runtimeVersion: '0.163.0',
  async request(request, context) {
    assert.equal(context.signal.aborted, false);
    methods.push(request.method);
    let response: Uint8Array;
    switch (request.method) {
      case 'thread/list': {
        assert.equal(request.params.useStateDbOnly, true);
        assert.equal(request.params.limit, 1);
        assert.equal(request.params.sortKey, 'created_at');
        catalogDirections.push(request.params.sortDirection);
        assert.deepEqual(request.params.sourceKinds, ['cli']);
        assert.deepEqual(request.params.modelProviders, []);
        if (request.params.searchTerm !== undefined) {
          assert.equal(request.params.searchTerm, 'Alpha');
          response = encode({ data: [threads[0]], nextCursor: null });
          break;
        }
        const index = request.params.cursor === undefined ? 0 : 1;
        if (index === 1) assert.equal(request.params.cursor, 'native-catalog-next');
        const ordered = request.params.sortDirection === 'asc' ? threads : [...threads].reverse();
        response = encode({ data: [ordered[index]], nextCursor: index === 0 ? 'native-catalog-next' : null });
        break;
      }
      case 'thread/read': {
        assert.equal(request.params.includeTurns, false);
        assert.equal(request.params.threadId, ids[0]);
        response = encode({ thread: threads[0] });
        break;
      }
      case 'thread/turns/list': {
        assert.equal(request.params.threadId, ids[0]);
        assert.equal(request.params.sortDirection, 'asc');
        assert.equal(request.params.itemsView, 'full');
        const index = request.params.cursor === undefined ? 0 : 1;
        if (index === 1) assert.equal(request.params.cursor, 'native-turn-next');
        response = encode({ data: [turns[index]], nextCursor: index === 0 ? 'native-turn-next' : null });
        break;
      }
      case 'thread/items/list': throw new Error('This borrowed fixture is a legacy store and must use turn pagination.');
      default: throw new Error('This default-disabled history source must not send management requests.');
    }
    assert(response.byteLength <= context.maxResponseBytes);
    return response;
  },
};

const history = createCodexHistory({
  sourceId: 'packed-borrowed-codex', generation: 'fixture-generation', scope: { kind: 'all_projects' },
  catalogPolicy: 'state_db_only', sourceKinds: ['cli'], connection, resources: { kind: 'caller_owned' },
});
try {
  const catalog = history.catalog, lookup = history.lookup, transcript = history.transcript;
  if (catalog.status !== 'supported' || lookup.status !== 'supported' || transcript.status !== 'supported') {
    throw new Error('Borrowed Codex history ports are unavailable');
  }
  assert.equal(history.source.resourceOwnership, 'borrowed');
  if (history.metadataSearch.status !== 'supported') throw new Error('Native Codex title search is unavailable');
  const found = await history.metadataSearch.search({ query: 'Alpha', order: 'created_asc', limit: 1 });
  assert.deepEqual(found.items.map((hit) => hit.conversation.title), ['Borrowed Alpha']);
  const first = await catalog.list({ limit: 1, order: 'created_asc' });
  assert.equal(first.items[0]?.title, 'Borrowed Alpha');
  assert(first.nextCursor);
  const second = await catalog.list({ limit: 1, order: 'created_asc', cursor: first.nextCursor });
  assert.equal(second.items[0]?.title, 'Borrowed Beta');
  assert.equal(second.nextCursor, undefined);
  const ref = first.items[0]?.ref;
  assert(ref);
  assert.equal((await lookup.get({ conversation: ref })).title, 'Borrowed Alpha');
  const records: AgentHistoryRecord[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 8; index += 1) {
    const page: AgentHistoryTranscriptPage = await transcript.read({ conversation: ref, limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    assert(page.items.length <= 1);
    if (page.items.length === 0) assert.equal(page.nextCursor, undefined);
    assert.deepEqual(page.coverage, { view: 'retained_chain', children: 'excluded', omissions: ['native_retention', 'subagents_excluded'] });
    records.push(...page.items);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(records.map((record) => record.kind === 'message' ? record.content : record), [
    [{ kind: 'text', text: 'Borrowed question one' }], [{ kind: 'text', text: 'Borrowed answer one' }],
    [{ kind: 'text', text: 'Borrowed question two' }], [{ kind: 'text', text: 'Borrowed answer two' }],
  ]);
  assert.deepEqual(records.map((record) => record.native), [
    { turnId: 'turn-native-one', itemId: 'item-native-one' }, { turnId: 'turn-native-one', itemId: 'item-native-two' },
    { turnId: 'turn-native-two', itemId: 'item-native-three' }, { turnId: 'turn-native-two', itemId: 'item-native-four' },
  ]);
  const before = methods.length;
  await assert.rejects(catalog.list({ limit: 1, order: 'created_desc', cursor: first.nextCursor }), { code: 'invalid_cursor' });
  assert.equal(methods.length, before);
  assert.deepEqual(catalogDirections, ['asc', 'asc', 'asc']);
  const browseExample = await proveBrowseExample(history, ids[0],
    { catalogCount: 2, transcript: { status: 'read', records: 4, view: 'retained_chain' } });
  assert.deepEqual(catalogDirections, ['asc', 'asc', 'asc', 'desc', 'desc']);
  await history.close();
  const afterClose = await connection.request({ method: 'thread/read', params: { threadId: ids[0], includeTurns: false } },
    { signal: new AbortController().signal, maxResponseBytes: 65536 });
  assert.equal(JSON.parse(new TextDecoder().decode(afterClose)).result.thread.id, ids[0]);
  assert.deepEqual([...new Set(methods)].sort(), ['thread/list', 'thread/read', 'thread/turns/list']);
  process.stdout.write(`${JSON.stringify({ proof: 'packed-codex-borrowed-history', evidence: 'synthetic',
    titles: ['Borrowed Alpha', 'Borrowed Beta'], records: records.length, nativeIdentityPreserved: true,
    foreignCursorDelegations: 0, borrowedPortUsableAfterClose: true, executionMethods: 0, titleSearchMatches: found.items.length, browseExample })}\n`);
} finally { await history.close(); }
