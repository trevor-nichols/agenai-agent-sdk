import assert from 'node:assert/strict';
import {
  parseAgentHistoryConversationRef,
  type AgentHistory, type AgentHistoryCatalogPage, type AgentHistoryConversationRef,
  type AgentHistoryConversationSummary, type AgentHistoryRecord, type AgentHistoryTranscriptPage,
} from '@agen-ai/agent-history';
import { createOpenCodeHistory } from '@agen-ai/agent-history/opencode';
import { proveBrowseExample } from './browse-example.js';
import {
  createOpenCodeFixture, openCodeFileSha256, resolveOpenCodeFixtureExecutable,
  OPENCODE_LINUX_X64_SHA256, OPENCODE_NATIVE_VERSION,
} from './opencode-fixture.js';

const executable = await resolveOpenCodeFixtureExecutable();
assert.equal(await openCodeFileSha256(executable), OPENCODE_LINUX_X64_SHA256);
const fixture = await createOpenCodeFixture(executable);
const histories: AgentHistory[] = [];
const requests: { readonly method: string; readonly path: string }[] = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input));
  assert.equal(url.origin, fixture.endpoint);
  requests.push({ method: init?.method ?? request?.method ?? 'GET', path: url.pathname });
  return nativeFetch(input, init);
};
const options = {
  sourceId: 'packed-native-opencode', generation: 'fixture-generation',
  scope: { kind: 'project' as const, projectPath: fixture.projectPath, worktrees: 'excluded' as const },
  server: { baseUrl: fixture.endpoint, headers: fixture.headers, runtimeVersion: '2.1.2' as const },
  resources: { kind: 'caller_owned' as const },
};

function ports(history: AgentHistory) {
  const catalog = history.catalog, lookup = history.lookup, transcript = history.transcript;
  if (catalog.status !== 'supported' || lookup.status !== 'supported' || transcript.status !== 'supported') {
    throw new Error('The exact native OpenCode history ports are unavailable');
  }
  return { catalog, lookup, transcript };
}

function ref(history: AgentHistory, conversationId: string): AgentHistoryConversationRef {
  return parseAgentHistoryConversationRef({ source: { providerKey: history.source.providerKey,
    sourceId: history.source.sourceId, generation: history.source.generation }, conversationId });
}

async function catalog(history: AgentHistory): Promise<readonly AgentHistoryConversationSummary[]> {
  const port = ports(history).catalog, items: AgentHistoryConversationSummary[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 12; index += 1) {
    const page: AgentHistoryCatalogPage = await port.list({ limit: 1, order: 'updated_asc',
      ...(cursor === undefined ? {} : { cursor }) });
    assert(page.items.length <= 1);
    assert.equal(page.consistency, 'live');
    assert.equal(page.coverage.view, 'catalog');
    items.push(...page.items);
    if (page.nextCursor === undefined) return items;
    cursor = page.nextCursor;
  }
  throw new Error('Native OpenCode catalog did not finish within its fixture bound');
}

async function transcript(history: AgentHistory, id: string): Promise<readonly AgentHistoryRecord[]> {
  const port = ports(history).transcript, items: AgentHistoryRecord[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 20; index += 1) {
    const page: AgentHistoryTranscriptPage = await port.read({ conversation: ref(history, id), limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    assert(page.items.length <= 1);
    assert.equal(page.coverage.view, 'retained_chain');
    assert.equal(page.coverage.children, 'excluded');
    assert(page.coverage.omissions.includes('native_retention'));
    assert(page.coverage.omissions.includes('subagents_excluded'));
    if (page.items.some((item) => item.kind === 'compaction')) assert(page.coverage.omissions.includes('compacted'));
    items.push(...page.items);
    if (page.nextCursor === undefined) return items;
    cursor = page.nextCursor;
  }
  throw new Error('Native OpenCode transcript did not finish within its fixture bound');
}

try {
  const history = await createOpenCodeHistory(options);
  histories.push(history);
  assert.equal(history.source.kind, 'opencode-v2-server');
  assert.equal(history.source.resourceOwnership, 'borrowed');
  const listed = await catalog(history);
  assert.deepEqual(listed.map((item) => item.title), [
    'Alpha OpenCode history', 'Child OpenCode history', 'Empty OpenCode history', 'Archived OpenCode history',
  ]);
  assert.deepEqual(listed.map((item) => item.ref.conversationId), [fixture.ids.alpha, fixture.ids.child, fixture.ids.empty, fixture.ids.archived]);
  assert.equal(listed[1]?.parent?.conversationId, fixture.ids.alpha);
  assert.equal(listed[3]?.archiveState, 'archived');
  const alpha = await ports(history).lookup.get({ conversation: ref(history, fixture.ids.alpha) });
  assert.equal(alpha.title, 'Alpha OpenCode history');
  assert.equal(alpha.createdAt, '2026-01-01T12:00:00.000Z');
  assert.equal(alpha.projectPath, fixture.projectPath);
  if (history.metadataSearch.status !== 'supported') throw new Error('Native OpenCode title search is unavailable');
  const found = await history.metadataSearch.search({ query: 'aLpHa', limit: 1 });
  assert.deepEqual(found.items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.alpha]);
  assert.deepEqual((await history.metadataSearch.search({ query: 'Stored answer before tool', limit: 1 })).items, []);
  const records = await transcript(history, fixture.ids.alpha);
  assert.deepEqual(records.map((item) => item.kind), [
    'message', 'message', 'tool_call', 'tool_result', 'message', 'message', 'compaction', 'message', 'message',
  ]);
  assert.deepEqual(records.map((item) => item.native?.itemId), [
    'msg_ms005_user', 'msg_ms005_assistant', 'msg_ms005_assistant', 'msg_ms005_assistant', 'msg_ms005_assistant',
    'msg_ms005_system', 'msg_ms005_compaction', 'msg_ms005_final_user', 'msg_ms005_final_answer',
  ]);
  assert(records.every((item) => item.native?.turnId === undefined));
  const first = records[0];
  assert(first?.kind === 'message');
  assert.deepEqual(first.content, [
    { kind: 'text', text: 'Stored OpenCode question' },
    { kind: 'attachment', attachmentKind: 'file', name: 'fixture.txt', mediaType: 'text/plain',
      reference: { kind: 'uri', uri: 'data:text/plain;base64,aGlzdG9yeQ==' } },
  ]);
  const assistant = records[1];
  assert(assistant?.kind === 'message');
  assert.deepEqual(assistant.content, [
    { kind: 'thinking', text: 'Stored OpenCode reasoning' }, { kind: 'text', text: 'Stored answer before tool' },
  ]);
  const call = records[2], result = records[3];
  assert(call?.kind === 'tool_call' && result?.kind === 'tool_result');
  assert.deepEqual({ callId: call.callId, name: call.name, arguments: call.arguments },
    { callId: 'call_ms005_read', name: 'read', arguments: { path: '/synthetic/never-opened.txt' } });
  assert.deepEqual({ callId: result.callId, outcome: result.outcome, content: result.content },
    { callId: 'call_ms005_read', outcome: 'succeeded', content: [{ kind: 'text', text: 'Stored native tool result' }] });
  const compact = records[6];
  assert(compact?.kind === 'compaction');
  assert.equal(compact.summary, 'Imported native compaction summary');
  const userOnly = await createOpenCodeHistory({ ...options, generation: 'user-filter-generation', messageType: 'user' });
  histories.push(userOnly);
  const users = await transcript(userOnly, fixture.ids.alpha);
  assert.deepEqual(users.map((item) => item.native?.itemId), ['msg_ms005_user', 'msg_ms005_final_user']);
  assert.deepEqual(await transcript(history, fixture.ids.empty), []);
  await assert.rejects(ports(history).lookup.get({ conversation: ref(history, fixture.ids.missing) }), { code: 'not_found' });
  await assert.rejects(ports(history).lookup.get({ conversation: ref(history, fixture.ids.beta) }), { code: 'unsupported_scope' });
  await assert.rejects(ports(history).catalog.list({ projectPath: fixture.otherProjectPath }), { code: 'unsupported_scope' });
  const other = await createOpenCodeHistory({ ...options, sourceId: 'packed-other-opencode',
    scope: { ...options.scope, projectPath: fixture.otherProjectPath } });
  histories.push(other);
  const otherListed = await catalog(other);
  assert.deepEqual(otherListed.map((item) => item.title), ['Beta other-project history']);
  await assert.rejects(createOpenCodeHistory({ ...options, generation: 'denied-generation',
    server: { ...options.server, headers: { authorization: 'Basic aW52YWxpZDppbnZhbGlk' } } }), { code: 'access_denied' });
  const browseExample = await proveBrowseExample(history, fixture.ids.alpha,
    { catalogCount: 4, transcript: { status: 'read', records: 9, view: 'retained_chain' } });
  assert(requests.every((request) => request.method === 'GET'));
  const managed = await createOpenCodeHistory({ ...options, management: ['rename', 'archive', 'restore', 'delete'] });
  histories.push(managed);
  const { rename, archive, restore, delete: remove } = managed;
  if (rename.status !== 'supported' || archive.status !== 'supported' || restore.status !== 'supported' || remove.status !== 'supported') {
    throw new Error('Explicit OpenCode management selection is unavailable');
  }
  const target = ref(managed, fixture.ids.alpha);
  const nativeSession = async (id: string) => {
    const result = await fixture.request(`/api/session/${id}`);
    assert.equal(result.status, 200);
    assert(result.body && typeof result.body === 'object' && 'data' in result.body && result.body.data && typeof result.body.data === 'object');
    return result.body.data;
  };
  const renamed = await rename.apply({ conversation: target, title: 'Packed explicitly renamed title', acceptEffects: rename.descriptor.effects });
  assert.equal(renamed.status, 'applied');
  const nativeRenamed = await nativeSession(fixture.ids.alpha);
  assert.equal('title' in nativeRenamed ? nativeRenamed.title : undefined, 'Packed explicitly renamed title');
  const archived = await archive.apply({ conversation: target, acceptEffects: archive.descriptor.effects });
  assert.equal(archived.status, 'applied');
  assert.equal((await ports(managed).lookup.get({ conversation: target })).archiveState, 'archived');
  const nativeChild = await nativeSession(fixture.ids.child);
  assert('time' in nativeChild && nativeChild.time && typeof nativeChild.time === 'object');
  assert.equal('archived' in nativeChild.time ? nativeChild.time.archived : undefined, undefined);
  const restored = await restore.apply({ conversation: target, acceptEffects: restore.descriptor.effects });
  assert.equal(restored.status, 'applied');
  assert.equal((await ports(managed).lookup.get({ conversation: target })).archiveState, 'not_archived');
  const deleted = await remove.apply({ conversation: target, acceptEffects: remove.descriptor.effects });
  assert.equal(deleted.status, 'applied');
  assert.equal((await fixture.request(`/api/session/${fixture.ids.alpha}`)).status, 404);
  assert.equal((await fixture.request(`/api/session/${fixture.ids.child}`)).status, 404);
  assert.equal((await fixture.request(`/api/session/${fixture.ids.beta}`)).status, 200);
  await Promise.all(histories.map((source) => source.close()));
  await assert.rejects(ports(history).catalog.list({ limit: 1 }), { code: 'closed' });
  const stillUsable = await fixture.request('/api/info');
  assert.equal(stillUsable.status, 200);
  assert(stillUsable.body !== null && typeof stillUsable.body === 'object' && 'version' in stillUsable.body);
  assert.equal(stillUsable.body.version, '2.1.2');
  assert(requests.every((request) => request.method === 'GET'
    ? /^\/api\/(?:info|session(?:\/[a-zA-Z0-9_]+(?:\/message)?)?)$/u.test(request.path)
    : (request.method === 'PATCH' || request.method === 'DELETE') && request.path === `/api/session/${fixture.ids.alpha}`));
  assert.deepEqual(requests.filter((request) => request.method !== 'GET').map((request) => request.method), ['PATCH', 'PATCH', 'PATCH', 'DELETE']);
  process.stdout.write(`${JSON.stringify({
    proof: 'packed-opencode-native-history', evidence: 'native-reader-synthetic-store', version: OPENCODE_NATIVE_VERSION,
    executableSha256: OPENCODE_LINUX_X64_SHA256, projectCatalogCount: listed.length,
    otherProjectCatalogCount: otherListed.length, transcriptRecords: records.length, filteredUserRecords: users.length,
    emptyRecords: 0, missing: 'not_found', foreignProject: 'unsupported_scope', accessDenied: 'access_denied', serverUsableAfterClose: true,
    executionRequests: 0,
    titleSearchMatches: found.items.length, rename: renamed.status, archive: archived.status, restore: restored.status, delete: deleted.status,
    archiveParentOnly: true, restoreParentOnly: true, deleteCascade: true, browseExample,
  })}\n`);
} finally {
  try { await Promise.all(histories.map((source) => source.close())); }
  finally { globalThis.fetch = nativeFetch; await fixture.cleanup(); }
}
