import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createGrokHistory, createGrokHistoryProcess } from '../dist/grok.js';
import type { GrokHistoryConnection } from '../src/grok.js';
import { parseAgentHistoryConversationRef } from '../dist/index.js';
import type { AgentHistory, AgentHistorySearchPage } from '../src/index.js';
import { createGrokFixture, createGrokMutationLaunchFailure, createGrokResponseLossLauncher, grokFixtureDigests, openGrokFixtureConnection,
  waitForGrokWithheldReceipt, type GrokFixture } from './helpers/grok-fixture.js';

const nativeOptions = { timeout: 60_000,
  skip: process.platform === 'linux' && process.arch === 'x64' ? false : 'Grok management fixtures require qualified Linux x64 prlimit and Bubblewrap.' };
function options(fixture: GrokFixture) {
  return { sourceId: fixture.label, generation: 'ms008', scope: { kind: 'project' as const, projectPath: fixture.projectPath, worktrees: 'excluded' as const },
    executable: fixture.executable, nativeHome: fixture.nativeHome, resources: { kind: 'linux-prlimit-bubblewrap' as const,
      resourceLauncher: '/usr/bin/prlimit', sandboxLauncher: '/usr/bin/bwrap', temporaryRoot: fixture.temporaryRoot } };
}
function ref(history: AgentHistory, id: string) {
  return parseAgentHistoryConversationRef({ source: { providerKey: history.source.providerKey, sourceId: history.source.sourceId,
    generation: history.source.generation }, conversationId: id });
}
function readers(history: AgentHistory) {
  assert(history.metadataSearch.status === 'supported' && history.contentSearch.status === 'supported' && history.lookup.status === 'supported');
  return { metadata: history.metadataSearch.search, content: history.contentSearch.search, lookup: history.lookup.get };
}
function managers(history: AgentHistory) {
  assert(history.rename.status === 'supported' && history.delete.status === 'supported');
  return { rename: history.rename.apply, delete: history.delete.apply,
    renameEffects: history.rename.descriptor.effects, deleteEffects: history.delete.descriptor.effects };
}
function code(expected: string) {
  return (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === expected;
}

test('Grok native metadata and ranked content search distinguish fields, paginate a fresh index and preserve source bytes', nativeOptions, async (t) => {
  const fixture = await createGrokFixture(); t.after(() => fixture.cleanup());
  const before = await grokFixtureDigests(fixture.nativeHome);
  const history = await createGrokHistoryProcess(options(fixture)); t.after(() => history.close());
  const read = readers(history);
  assert.deepEqual((await read.metadata({ query: 'ALPHA', limit: 1 })).items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.alpha]);
  assert.deepEqual((await read.metadata({ query: 'message', limit: 1 })).items, []);
  const first = await read.content({ query: 'MESSAGE', limit: 1 });
  assert.equal(first.items.length, 1); assert(first.nextCursor);
  assert.equal(first.items[0]?.conversation.ref.conversationId, fixture.ids.alpha);
  assert.deepEqual(first.items[0]?.matchedFields, ['transcript']);
  assert.equal(typeof first.items[0]?.score, 'number'); assert.match(first.items[0]?.snippet ?? '', /\[message\]/iu);
  const second = await read.content({ query: 'MESSAGE', limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.beta]);
  assert.equal(second.nextCursor, undefined); assert.equal(second.totalEstimate, 2);
  assert(second.coverage.omissions.includes('provider_omission')); assert(second.coverage.omissions.includes('native_retention'));
  assert.equal(second.coverage.children, 'excluded');
  assert.deepEqual((await read.content({ query: 'no_such_fixture_word' })).items, []);
  assert.deepEqual((await read.content({ query: 'replacement' })).items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.beta]);
  await assert.rejects(read.content({ query: 'message', cursor: first.nextCursor }), code('invalid_cursor'));
  await assert.rejects(read.content({ query: 'message', projectPath: fixture.otherProjectPath }), code('unsupported_scope'));
  assert.equal(history.rename.status, 'unsupported'); assert.equal(history.delete.status, 'unsupported');
  await history.close(); assert.deepEqual(await grokFixtureDigests(fixture.nativeHome), before);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Grok owned management opts into local quiescent effects, validates before dispatch and preserves an independently saved child', nativeOptions, async (t) => {
  const fixture = await createGrokFixture(); t.after(() => fixture.cleanup());
  await assert.rejects(createGrokHistoryProcess({ ...options(fixture), management: ['rename'] }), code('invalid_input'));
  const history = await createGrokHistoryProcess({ ...options(fixture), management: ['rename', 'delete'], localManagement: { kind: 'caller_quiescent' } });
  t.after(() => history.close()); const manage = managers(history), alpha = ref(history, fixture.ids.alpha);
  assert.deepEqual(manage.renameEffects, { scope: 'local', descendants: 'none', active: 'requires_quiescent', atomicity: 'unknown' });
  const rejected = await manage.rename({ conversation: alpha, title: 'Not accepted', acceptEffects: { ...manage.renameEffects, descendants: 'unknown' } });
  assert.equal(rejected.status, 'not_applied');
  const tooLong = await manage.rename({ conversation: alpha, title: 'x'.repeat(101), acceptEffects: manage.renameEffects });
  assert.equal(tooLong.status, 'not_applied'); assert.equal(tooLong.reason.code, 'invalid_input');
  const foreign = await manage.delete({ conversation: ref(history, fixture.ids.foreign), acceptEffects: manage.deleteEffects });
  assert.equal(foreign.status, 'not_applied'); assert.equal(foreign.reason.code, 'unsupported_scope');
  const renamed = await manage.rename({ conversation: alpha, title: 'Saved local rename', acceptEffects: manage.renameEffects });
  assert.equal(renamed.status, 'applied');
  assert.equal((await readers(history).lookup({ conversation: alpha })).title, 'Saved local rename');
  const deleted = await manage.delete({ conversation: alpha, acceptEffects: manage.deleteEffects }); assert.equal(deleted.status, 'applied');
  assert.equal((await manage.delete({ conversation: alpha, acceptEffects: manage.deleteEffects })).status, 'applied');
  const native = await openGrokFixtureConnection(fixture); t.after(() => native.close());
  await assert.rejects(native.request('_x.ai/session/state', { sessionId: fixture.ids.alpha, cwd: fixture.projectPath }), (error: unknown) =>
    error !== null && typeof error === 'object' && 'code' in error && error.code === -32602);
  const child = await native.request('_x.ai/session/state', { sessionId: fixture.ids.child, cwd: fixture.projectPath });
  assert(child !== null && typeof child === 'object' && !Array.isArray(child));
  assert.deepEqual(child.summary !== null && typeof child.summary === 'object' && !Array.isArray(child.summary) ? child.summary.info : undefined,
    { id: fixture.ids.child, cwd: fixture.projectPath });
  const absentRename = await manage.rename({ conversation: alpha, title: 'Missing', acceptEffects: manage.renameEffects });
  assert.equal(absentRename.status, 'not_applied'); assert.equal(absentRename.reason.code, 'not_found');
  await native.close(); await history.close(); assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Grok native response loss retains unknown outcome, fences duplicate mutation and preserves independent reads', nativeOptions, async (t) => {
  const fixture = await createGrokFixture(); t.after(() => fixture.cleanup());
  const launcher = await createGrokResponseLossLauncher(fixture);
  const base = options(fixture);
  const history = await createGrokHistoryProcess({ ...base, resources: { ...base.resources, resourceLauncher: launcher.executable },
    management: ['rename'], localManagement: { kind: 'caller_quiescent' } });
  t.after(() => history.close());
  assert(history.rename.status === 'supported');
  const input = { conversation: ref(history, fixture.ids.alpha), title: 'Applied but receipt lost', acceptEffects: history.rename.descriptor.effects };
  const controller = new AbortController(), pending = history.rename.apply(input, { signal: controller.signal, deadlineMs: 20_000 });
  try { await waitForGrokWithheldReceipt(launcher.trace); }
  finally { controller.abort(); }
  const result = await pending;
  assert.equal(result.status, 'outcome_unknown');
  let restored = false;
  for (let attempts = 0; attempts < 100; attempts += 1) {
    try { assert.equal((await readers(history).lookup({ conversation: input.conversation })).title, input.title); restored = true; break; }
    catch (error) { if (!code('busy')(error)) throw error; await delay(10); }
  }
  assert(restored, 'The original entered native operation must settle and allow reconciliation reads.');
  const repeated = await history.rename.apply(input); assert.equal(repeated.status, 'not_applied');
  assert.equal(repeated.reason.code, 'unsupported_scope');
  const receipts = (await readFile(launcher.trace, 'utf8')).trim().split('\n').map((line: string) => JSON.parse(line));
  assert.deepEqual(receipts, [{ method: '_x.ai/session/rename', result: { success: true } }]);
  await history.close(); assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Grok rejects a failed owned mutation launch before mutator dispatch without fencing later requests', nativeOptions, async (t) => {
  const fixture = await createGrokFixture(); t.after(() => fixture.cleanup());
  const launcher = await createGrokMutationLaunchFailure(fixture), base = options(fixture);
  const before = await grokFixtureDigests(fixture.nativeHome);
  const history = await createGrokHistoryProcess({ ...base, resources: { ...base.resources, resourceLauncher: launcher.executable },
    management: ['rename'], localManagement: { kind: 'caller_quiescent' } });
  t.after(() => history.close()); assert(history.rename.status === 'supported');
  const conversation = ref(history, fixture.ids.alpha), input = { conversation, title: 'Never dispatched', acceptEffects: history.rename.descriptor.effects };
  const first = await history.rename.apply(input); assert.equal(first.status, 'not_applied'); assert.equal(first.reason.code, 'native_failure');
  const second = await history.rename.apply(input); assert.equal(second.status, 'not_applied'); assert.equal(second.reason.code, 'native_failure');
  assert.equal((await readers(history).lookup({ conversation })).title, 'STORE-A Alpha');
  assert.equal(await readFile(launcher.trace, 'utf8'), 'native-not-launched\nnative-not-launched\n');
  await history.close(); assert.deepEqual(await grokFixtureDigests(fixture.nativeHome), before);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Grok native FTS bootstrap retains title metadata while omitting content above its 30 MiB native input ceiling', nativeOptions, async (t) => {
  const fixture = await createGrokFixture({ oversizedBytes: 32 * 1024 * 1024 }); t.after(() => fixture.cleanup());
  const before = await grokFixtureDigests(fixture.nativeHome), history = await createGrokHistoryProcess(options(fixture));
  t.after(() => history.close()); const read = readers(history);
  const updates = before.find(([name]) => name.includes(fixture.ids.oversized) && name.endsWith('/updates.jsonl'));
  assert(updates); assert((await stat(join(fixture.nativeHome, updates[0]))).size > 30 * 1024 * 1024);
  assert.equal((await read.lookup({ conversation: ref(history, fixture.ids.oversized) })).title, 'STORE-A Oversized');
  assert.deepEqual((await read.metadata({ query: 'Oversized' })).items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.oversized]);
  assert.equal((await read.content({ query: 'message', limit: 1 })).items.length, 1);
  const metadataOnly = await read.content({ query: 'Oversized' });
  assert.deepEqual(metadataOnly.items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.oversized]);
  assert.deepEqual(metadataOnly.items[0]?.matchedFields, ['title']); assert.equal(metadataOnly.items[0]?.snippet, '');
  const skipped = await read.content({ query: 'oversizedbodyneedle' }); assert.deepEqual(skipped.items, []);
  assert(skipped.coverage.omissions.includes('provider_omission')); assert.equal(skipped.nextCursor, undefined);
  await history.close(); assert.deepEqual(await grokFixtureDigests(fixture.nativeHome), before);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

function borrowedSearch(search: NonNullable<GrokHistoryConnection['sessionSearch']>): GrokHistoryConnection {
  return { protocolProfile: 'schema-v1.23.0', runtimeVersion: '1.0.62', resources: { kind: 'caller_owned', maxInboundFrameBytes: 1_048_576 },
    initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } }, _meta: { grokShell: true, agentVersion: '1.0.62' } },
    listSessions: async () => ({ sessions: [] }), sessionState: async () => assert.fail('Search must not use state lookup.'),
    sessionUpdates: async () => assert.fail('Search must not scan transcripts.'), sessionSearch: search };
}
const borrowedOptions = { sourceId: 'bounded-search-peer', generation: 'one', scope: { kind: 'project' as const, projectPath: '/owned-fixture', worktrees: 'excluded' as const } };

test('Grok borrowed native bootstrap cannot become completed empty history and borrowed management remains unqualified', async () => {
  let calls = 0;
  const history = createGrokHistory({ ...borrowedOptions, management: ['rename', 'delete'], connection: borrowedSearch(async () => {
    calls += 1; return { result: { results: [], nextOffset: null, totalEstimate: 0, bootstrapping: true } };
  }) });
  try { assert(history.contentSearch.status === 'supported'); await assert.rejects(history.contentSearch.search({ query: 'needle' }), code('limit_exhausted'));
    assert.equal(calls, 7); assert.equal(history.rename.status, 'unsupported'); assert.equal(history.delete.status, 'unsupported');
  } finally { await history.close(); }
});

test('Grok native search marks classification and offset ceilings without dispatching an invalid offset', async () => {
  const classified = createGrokHistory({ ...borrowedOptions, connection: borrowedSearch(async () => ({
    result: { results: [], nextOffset: null, totalEstimate: null, bootstrapping: false },
  })) });
  try {
    assert(classified.contentSearch.status === 'supported');
    const capped = await classified.contentSearch.search({ query: 'needle' });
    assert.deepEqual(capped.items, []); assert.equal(capped.nextCursor, undefined); assert.equal(capped.totalEstimate, undefined);
    assert(capped.coverage.omissions.includes('resource_limit')); assert(capped.coverage.omissions.includes('provider_omission'));
  } finally { await classified.close(); }
  const offsets: number[] = [];
  const history = createGrokHistory({ ...borrowedOptions, connection: borrowedSearch(async (input) => {
    offsets.push(input.offset);
    return { result: { results: [{ sessionId: `${input.offset.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`, cwd: '/owned-fixture', summary: `Native hit ${input.offset}`,
      updatedAt: '2026-10-21T00:00:00Z', score: 1, matchedFields: ['content'], snippet: 'needle' }],
    nextOffset: input.offset + 1, totalEstimate: null, bootstrapping: false } };
  }) });
  try {
    assert(history.contentSearch.status === 'supported'); let cursor: string | undefined, count = 0, last: AgentHistorySearchPage | undefined;
    for (let page = 0; page < 200; page += 1) {
      const before = offsets.length;
      last = await history.contentSearch.search({ query: 'needle', limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      assert(offsets.length - before <= 7); count += last.items.length;
      cursor = last.nextCursor; if (cursor === undefined) break;
    }
    assert.equal(count, 1001); assert.equal(cursor, undefined); assert.equal(last?.totalEstimate, undefined);
    assert(last?.coverage.omissions.includes('resource_limit')); assert.equal(Math.max(...offsets), 1000);
  } finally { await history.close(); }
});

test('Grok metadata search preserves fitting hit prefixes and continuation across output byte budgets', async () => {
  const rows = ['70000001-1111-4111-8111-111111111111', '70000002-1111-4111-8111-111111111111'];
  for (let pageBytes = 6000; pageBytes <= 8000; pageBytes += 16) {
    const connection = borrowedSearch(async () => assert.fail('Metadata search must use the native catalog query.'));
    const history = createGrokHistory({ ...borrowedOptions, limits: { pageBytes }, connection: { ...connection,
      listSessions: async (input) => {
        assert.equal(input._meta['x.ai/query'], 'needle');
        const second = input.cursor === 'second';
        return { sessions: [{ sessionId: rows[second ? 1 : 0], cwd: '/owned-fixture', title: `${second ? 'B' : 'A'}${'t'.repeat(1799)}`,
          _meta: { 'x.ai/session': { kind: 'build' } } }], ...(second ? {} : { nextCursor: 'second' }) };
      } } });
    try {
      assert(history.metadataSearch.status === 'supported');
      const first = await history.metadataSearch.search({ query: 'needle', limit: 2 });
      assert(first.items.length > 0);
      const next = first.nextCursor === undefined ? []
        : (await history.metadataSearch.search({ query: 'needle', limit: 2, cursor: first.nextCursor })).items;
      assert.deepEqual([...first.items, ...next].map((hit) => hit.conversation.ref.conversationId), rows);
    } finally { await history.close(); }
  }
});
