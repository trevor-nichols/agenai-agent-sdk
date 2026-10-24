import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentProviderConversationId } from '@agen-ai/agent-protocol';
import { createOpenCodeHistory } from '../dist/opencode.js';
import type { AgentHistory, AgentHistoryCatalogPage, AgentHistoryConversationRef, AgentHistoryListInput,
  AgentHistoryRecord, AgentHistorySearchPage, AgentHistoryTranscriptPage } from '../src/index.js';
import { createOpenCodeFixture, openCodeFileSha256, OPENCODE_LINUX_X64_SHA256,
  resolveOpenCodeFixtureExecutable, type OpenCodeFixture } from './helpers/opencode-fixture.js';
import { createOpenCodeHttpPeer } from './helpers/opencode-http-peer.js';

const nativeOptions = { timeout: 60000,
  skip: process.platform === 'linux' && process.arch === 'x64' ? false : 'Native OpenCode fixtures require the qualified Linux x64 baseline 2.1.2 runtime.' };

function ref(history: AgentHistory, id: string): AgentHistoryConversationRef {
  return { source: { providerKey: history.source.providerKey, sourceId: history.source.sourceId, generation: history.source.generation },
    conversationId: parseAgentProviderConversationId(id) };
}
function catalog(history: AgentHistory) {
  if (history.catalog.status !== 'supported') assert.fail('Native OpenCode catalog must be supported.');
  return history.catalog.list;
}
function lookup(history: AgentHistory) {
  if (history.lookup.status !== 'supported') assert.fail('Native OpenCode lookup must be supported.');
  return history.lookup.get;
}
function transcript(history: AgentHistory) {
  if (history.transcript.status !== 'supported') assert.fail('Native OpenCode transcript must be supported.');
  return history.transcript.read;
}
function code(expected: string) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}
function options(fixture: OpenCodeFixture, projectPath = fixture.projectPath, baseUrl = fixture.endpoint) {
  return { sourceId: 'opencode-native-fixture', generation: 'fixture-generation',
    scope: { kind: 'project' as const, projectPath, worktrees: 'excluded' as const },
    server: { baseUrl, headers: fixture.headers, runtimeVersion: '2.1.2' as const }, resources: { kind: 'caller_owned' as const } };
}

test('OpenCode native title search retains case-insensitive SQL LIKE semantics and native query-bound pagination', nativeOptions, async (t) => {
  const fixture = await createOpenCodeFixture(await resolveOpenCodeFixtureExecutable());
  t.after(() => fixture.cleanup());
  const history = await createOpenCodeHistory(options(fixture));
  t.after(() => history.close());
  if (history.metadataSearch.status !== 'supported') assert.fail('Native title search must be available.');
  const search = history.metadataSearch.search;
  assert.deepEqual((await search({ query: 'aLpHa', limit: 1 })).items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.alpha]);
  assert.deepEqual((await search({ query: 'Stored answer before tool', limit: 1 })).items, []);
  assert.deepEqual((await search({ query: 'Alpha OpenCode histor_', limit: 1 })).items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.alpha]);
  const found: string[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
    const page: AgentHistorySearchPage = await search({ query: '%', archived: 'include', order: 'updated_asc', limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.items.map((hit) => hit.conversation.ref.conversationId));
    if (page.nextCursor === undefined) break;
    await assert.rejects(search({ query: 'Changed', archived: 'include', order: 'updated_asc', limit: 1, cursor: page.nextCursor }), code('invalid_cursor'));
    cursor = page.nextCursor;
  }
  assert.deepEqual(found, [fixture.ids.alpha, fixture.ids.child, fixture.ids.empty, fixture.ids.archived]);
});

test('OpenCode native management updates only the selected parent and deletes descendants across project scope', nativeOptions, async (t) => {
  const fixture = await createOpenCodeFixture(await resolveOpenCodeFixtureExecutable(), { childInOtherProject: true });
  t.after(() => fixture.cleanup());
  const history = await createOpenCodeHistory({ ...options(fixture), management: ['rename', 'archive', 'restore', 'delete'] });
  t.after(() => history.close());
  const { rename, archive, restore, delete: remove } = history;
  if (rename.status !== 'supported' || archive.status !== 'supported' || restore.status !== 'supported' || remove.status !== 'supported') assert.fail('Explicit management selection must be available.');
  const nativeSession = async (id: string) => {
    const result = await fixture.request(`/api/session/${id}`);
    assert.equal(result.status, 200);
    assert(result.body && typeof result.body === 'object' && 'data' in result.body && result.body.data && typeof result.body.data === 'object');
    return result.body.data;
  };
  const child = await nativeSession(fixture.ids.child);
  assert.equal('parentID' in child ? child.parentID : undefined, fixture.ids.alpha);
  assert.deepEqual('location' in child ? child.location : undefined, { directory: fixture.otherProjectPath });
  await assert.rejects(lookup(history)({ conversation: ref(history, fixture.ids.child) }), code('unsupported_scope'));
  const target = ref(history, fixture.ids.alpha);
  assert.equal((await rename.apply({ conversation: target, title: 'Native explicitly renamed title', acceptEffects: rename.descriptor.effects })).status, 'applied');
  const renamed = await nativeSession(fixture.ids.alpha);
  assert.equal('title' in renamed ? renamed.title : undefined, 'Native explicitly renamed title');
  assert.deepEqual(remove.descriptor.effects, { scope: 'provider_managed', descendants: 'descendants', active: 'requires_quiescent', atomicity: 'unknown' });
  assert.equal((await archive.apply({ conversation: target, acceptEffects: archive.descriptor.effects })).status, 'applied');
  assert.equal((await lookup(history)({ conversation: target })).archiveState, 'archived');
  const untouchedChild = await nativeSession(fixture.ids.child);
  assert('time' in untouchedChild && untouchedChild.time && typeof untouchedChild.time === 'object');
  assert.equal('archived' in untouchedChild.time ? untouchedChild.time.archived : undefined, undefined);
  assert.equal((await restore.apply({ conversation: target, acceptEffects: restore.descriptor.effects })).status, 'applied');
  assert.equal((await lookup(history)({ conversation: target })).archiveState, 'not_archived');
  assert.equal((await remove.apply({ conversation: target, acceptEffects: { ...remove.descriptor.effects, descendants: 'none' } })).status, 'not_applied');
  assert.equal((await fixture.request(`/api/session/${fixture.ids.alpha}`)).status, 200);
  assert.equal((await remove.apply({ conversation: target, acceptEffects: remove.descriptor.effects })).status, 'applied');
  assert.equal((await fixture.request(`/api/session/${fixture.ids.alpha}`)).status, 404);
  assert.equal((await fixture.request(`/api/session/${fixture.ids.child}`)).status, 404);
  assert.equal((await fixture.request(`/api/session/${fixture.ids.beta}`)).status, 200);
  const repeated = await remove.apply({ conversation: target, acceptEffects: remove.descriptor.effects });
  assert.equal(repeated.status, 'not_applied');
  if (repeated.status === 'not_applied') assert.equal(repeated.reason.code, 'not_found');
  await history.close();
  assert.equal((await fixture.request('/api/info')).status, 200);
});

async function catalogIds(history: AgentHistory, input: AgentHistoryListInput = {}): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 12; count += 1) {
    const page: AgentHistoryCatalogPage = await catalog(history)({ ...input, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    ids.push(...page.items.map((item) => item.ref.conversationId));
    if (page.nextCursor === undefined) return ids;
    cursor = page.nextCursor;
  }
  assert.fail('Finite native OpenCode catalog must finish within twelve public pages.');
}

async function readAll(history: AgentHistory, id: string) {
  const records: AgentHistoryRecord[] = [], pages: AgentHistoryTranscriptPage[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 20; count += 1) {
    const page: AgentHistoryTranscriptPage = await transcript(history)({ conversation: ref(history, id), limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    records.push(...page.items); pages.push(page);
    if (page.nextCursor === undefined) return { records, pages };
    cursor = page.nextCursor;
  }
  assert.fail('Finite native OpenCode transcript must finish within twenty public pages.');
}

test('OpenCode V2 native APIs preserve scoped catalog filters, mixed transcript order and borrowed server lifetime', nativeOptions, async (t) => {
  const executable = await resolveOpenCodeFixtureExecutable();
  assert.equal(await openCodeFileSha256(executable), OPENCODE_LINUX_X64_SHA256);
  const fixture = await createOpenCodeFixture(executable);
  t.after(() => fixture.cleanup());
  const peer = await createOpenCodeHttpPeer(async (request, response) => {
    const upstream = await fetch(`${fixture.endpoint}${request.url}`, { headers: fixture.headers });
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  t.after(() => peer.close());
  const first = await createOpenCodeHistory(options(fixture, fixture.projectPath, peer.endpoint));
  const second = await createOpenCodeHistory({ ...options(fixture, fixture.otherProjectPath, peer.endpoint), sourceId: 'opencode-other-project' });
  t.after(async () => { await first.close(); await second.close(); });

  assert.equal(first.source.resourceOwnership, 'borrowed');
  assert.deepEqual(await catalogIds(first, { archived: 'include', order: 'updated_asc' }),
    [fixture.ids.alpha, fixture.ids.child, fixture.ids.empty, fixture.ids.archived]);
  assert.deepEqual(await catalogIds(first, { archived: 'include', order: 'updated_desc' }),
    [fixture.ids.archived, fixture.ids.empty, fixture.ids.child, fixture.ids.alpha]);
  assert.deepEqual(await catalogIds(first, { archived: 'only' }), [fixture.ids.archived]);
  assert.deepEqual((await catalogIds(first, { archived: 'exclude' })).sort(), [fixture.ids.alpha, fixture.ids.child, fixture.ids.empty].sort());
  assert.equal((await lookup(first)({ conversation: ref(first, fixture.ids.archived) })).archiveState, 'archived');
  const alphaSummary = await lookup(first)({ conversation: ref(first, fixture.ids.alpha) });
  assert.equal(alphaSummary.archiveState, 'not_archived');
  assert.equal(alphaSummary.createdAt, '2026-01-01T12:00:00.000Z');
  assert.equal(alphaSummary.projectPath, fixture.projectPath);
  const childPage = await catalog(first)({ parent: ref(first, fixture.ids.alpha), limit: 1 });
  assert.deepEqual(childPage.items.map((item) => item.ref.conversationId), [fixture.ids.child]);
  assert.deepEqual(childPage.items[0].parent, ref(first, fixture.ids.alpha));
  assert.deepEqual(await catalogIds(second, { archived: 'include' }), [fixture.ids.beta]);
  assert.equal((await lookup(second)({ conversation: ref(second, fixture.ids.beta) })).title, 'Beta other-project history');
  await assert.rejects(catalog(first)({ projectPath: fixture.otherProjectPath }), code('unsupported_scope'));
  await assert.rejects(lookup(first)({ conversation: ref(first, fixture.ids.beta) }), code('unsupported_scope'));
  await assert.rejects(transcript(first)({ conversation: ref(first, fixture.ids.beta) }), code('unsupported_scope'));

  const firstPage = await catalog(first)({ limit: 1, archived: 'include', order: 'updated_asc' });
  if (firstPage.nextCursor === undefined) assert.fail('The native fixture has a second catalog page.');
  const beforeRejectedCursor = peer.requests.length;
  await assert.rejects(catalog(first)({ limit: 1, archived: 'only', order: 'updated_asc', cursor: firstPage.nextCursor }), code('invalid_cursor'));
  assert.equal(peer.requests.length, beforeRejectedCursor);

  const alpha = await readAll(first, fixture.ids.alpha);
  assert.deepEqual(alpha.records.map((record) => record.kind), ['message', 'message', 'tool_call', 'tool_result', 'message', 'message', 'compaction', 'message', 'message']);
  assert.deepEqual(alpha.records[0], { kind: 'message', role: 'user', content: [
    { kind: 'text', text: 'Stored OpenCode question' },
    { kind: 'attachment', attachmentKind: 'file', reference: { kind: 'uri', uri: 'data:text/plain;base64,aGlzdG9yeQ==' }, name: 'fixture.txt', mediaType: 'text/plain' },
  ], native: { itemId: 'msg_ms005_user' }, timestamp: '1970-01-01T00:00:01.000Z' });
  assert.deepEqual(alpha.records[1], { kind: 'message', role: 'assistant', content: [
    { kind: 'thinking', text: 'Stored OpenCode reasoning' }, { kind: 'text', text: 'Stored answer before tool' },
  ], native: { itemId: 'msg_ms005_assistant' }, timestamp: '1970-01-01T00:00:02.000Z' });
  assert.deepEqual(alpha.records[2], { kind: 'tool_call', callId: 'call_ms005_read', name: 'read',
    arguments: { path: '/synthetic/never-opened.txt' }, native: { itemId: 'msg_ms005_assistant' }, timestamp: '1970-01-01T00:00:02.000Z' });
  assert.deepEqual(alpha.records[3], { kind: 'tool_result', callId: 'call_ms005_read', outcome: 'succeeded',
    content: [{ kind: 'text', text: 'Stored native tool result' }], native: { itemId: 'msg_ms005_assistant' }, timestamp: '1970-01-01T00:00:02.000Z' });
  assert.deepEqual(alpha.records[4], { kind: 'message', role: 'assistant', content: [{ kind: 'text', text: 'Stored answer after tool' }],
    native: { itemId: 'msg_ms005_assistant' }, timestamp: '1970-01-01T00:00:02.000Z' });
  assert.deepEqual(alpha.records[5], { kind: 'message', role: 'system', content: [{ kind: 'text', text: 'Stored system context' }],
    native: { itemId: 'msg_ms005_system' }, timestamp: '1970-01-01T00:00:04.000Z' });
  assert.deepEqual(alpha.records[6], { kind: 'compaction', summary: 'Imported native compaction summary',
    native: { itemId: 'msg_ms005_compaction' }, timestamp: '1970-01-01T00:00:05.000Z' });
  assert.deepEqual(alpha.records.slice(-2).map((record) => record.kind === 'message' ? record.content : record),
    [[{ kind: 'text', text: 'Stored follow-up question' }], [{ kind: 'text', text: 'Stored final OpenCode answer' }]]);
  assert.equal(alpha.pages.every((page) => page.consistency === 'live' && page.coverage.view === 'retained_chain' && page.coverage.children === 'excluded'), true);
  assert.equal(alpha.pages.some((page) => page.coverage.omissions.includes('compacted')), true);
  assert.deepEqual((await readAll(first, fixture.ids.empty)).records, []);
  assert.equal((await lookup(first)({ conversation: ref(first, fixture.ids.empty) })).title, 'Empty OpenCode history');
  await assert.rejects(lookup(first)({ conversation: ref(first, fixture.ids.missing) }), code('not_found'));
  await assert.rejects(transcript(first)({ conversation: ref(first, fixture.ids.missing) }), code('not_found'));
  const users = await createOpenCodeHistory({ ...options(fixture), messageType: 'user' });
  try {
    assert.deepEqual((await readAll(users, fixture.ids.alpha)).records.map((record) => record.native?.itemId),
      ['msg_ms005_user', 'msg_ms005_final_user']);
  } finally { await users.close(); }
  await assert.rejects(createOpenCodeHistory({ ...options(fixture), server: { ...options(fixture).server,
    headers: { authorization: `Basic ${Buffer.from('opencode:wrong-password').toString('base64')}` } } }), code('access_denied'));

  const messageRequests = peer.requests.filter((request) => request.path === `/api/session/${fixture.ids.alpha}/message`);
  assert.equal(messageRequests.some((request) => request.query.has('cursor') && !request.query.has('order')), true);
  assert.equal(messageRequests.filter((request) => request.query.has('cursor')).every((request) => !request.query.has('order')), true);
  assert.equal(peer.requests.every((request) => request.method === 'GET' && (request.path === '/api/info'
    || request.path === '/api/session' || /^\/api\/session\/ses_ms005_[a-z]+(?:\/message)?$/u.test(request.path))), true);
  await first.close();
  assert.equal((await fixture.request(`/api/session/${fixture.ids.alpha}`)).status, 200);
  assert.equal((await lookup(second)({ conversation: ref(second, fixture.ids.beta) })).title, 'Beta other-project history');
  assert.equal(peer.pendingRequests, 0);
  await fixture.stopServer();
  await assert.rejects(lookup(second)({ conversation: ref(second, fixture.ids.beta) }), code('native_failure'));
});

test('OpenCode V2 native oversized single-message response fails within its raw budget and leaves the borrowed server usable', nativeOptions, async (t) => {
  const fixture = await createOpenCodeFixture(await resolveOpenCodeFixtureExecutable(), { oversizedMessageBytes: 1024 * 1024 + 65536 });
  t.after(() => fixture.cleanup());
  const history = await createOpenCodeHistory(options(fixture));
  t.after(() => history.close());
  await assert.rejects(transcript(history)({ conversation: ref(history, fixture.ids.oversized), limit: 1 }), code('limit_exhausted'));
  assert.equal((await lookup(history)({ conversation: ref(history, fixture.ids.alpha) })).title, 'Alpha OpenCode history');
  await history.close();
  assert.equal((await fixture.request(`/api/session/${fixture.ids.alpha}`)).status, 200);
});
