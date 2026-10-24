import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { basename } from 'node:path';
import { createGrokHistory, createGrokHistoryProcess, grokHistoryExtensions, type GrokHistoryConnection } from '@agen-ai/agent-history/grok';
import { parseAgentHistoryConversationRef, type AgentHistory, type AgentHistoryCatalogPage,
  type AgentHistoryRecord, type AgentHistoryTranscriptPage } from '@agen-ai/agent-history';
import { createGrokFixture, createGrokResponseLossLauncher, grokFixtureDigests, openGrokFixtureConnection,
  waitForGrokWithheldReceipt, type GrokFixture, type GrokFixtureConnection } from './grok-fixture.js';
import { proveBrowseExample } from './browse-example.js';

function common(fixture: GrokFixture) {
  return { sourceId: basename(fixture.root), generation: 'packed-fixture',
    scope: { kind: 'project' as const, projectPath: fixture.projectPath, worktrees: 'excluded' as const } };
}
function processOptions(fixture: GrokFixture) {
  return { ...common(fixture), executable: fixture.executable, nativeHome: fixture.nativeHome,
    resources: { kind: 'linux-prlimit-bubblewrap' as const, resourceLauncher: '/usr/bin/prlimit',
      sandboxLauncher: '/usr/bin/bwrap', temporaryRoot: fixture.temporaryRoot } };
}
function connection(native: GrokFixtureConnection): GrokHistoryConnection {
  return { protocolProfile: 'schema-v1.23.0', runtimeVersion: '1.0.62', initialization: native.initialization,
    resources: { kind: 'caller_owned', maxInboundFrameBytes: 1_048_576 },
    listSessions: (params, options) => native.request('session/list', { ...params }, options),
    sessionState: (params, options) => native.request('_x.ai/session/state', { ...params }, options),
    sessionUpdates: (params, options) => native.request('_x.ai/session/updates', { ...params }, options) };
}
function ref(history: AgentHistory, conversationId: string) {
  return parseAgentHistoryConversationRef({ source: { providerKey: history.source.providerKey,
    sourceId: history.source.sourceId, generation: history.source.generation }, conversationId });
}
function ports(history: AgentHistory) {
  if (history.catalog.status !== 'supported' || history.lookup.status !== 'supported' || history.transcript.status !== 'supported') {
    throw new Error('Packed Grok native history ports unavailable');
  }
  return { catalog: history.catalog.list, lookup: history.lookup.get, transcript: history.transcript.read };
}
function code(expected: string | number) {
  return (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === expected;
}
async function read(history: AgentHistory, id: string) {
  const records: AgentHistoryRecord[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 20; index += 1) {
    const page: AgentHistoryTranscriptPage = await ports(history).transcript({ conversation: ref(history, id), limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    assert.equal(page.coverage.view, 'stored_updates');
    assert.equal(page.coverage.children, 'excluded');
    assert(page.coverage.omissions.includes('native_retention'));
    assert(page.coverage.omissions.includes('subagents_excluded'));
    assert(page.coverage.omissions.includes('provider_omission'));
    records.push(...page.items);
    if (page.nextCursor === undefined) return records;
    cursor = page.nextCursor;
  }
  throw new Error('Packed Grok native fixture transcript did not terminate within its bound');
}

export async function proveGrokHistory() {
  const first = await createGrokFixture({ label: 'STORE-A' });
  let second: GrokFixture | undefined;
  let historyA: AgentHistory | undefined, historyB: AgentHistory | undefined;
  let borrowed: AgentHistory | undefined, native: GrokFixtureConnection | undefined;
  try {
    second = await createGrokFixture({ label: 'STORE-B' });
    historyA = await createGrokHistoryProcess(processOptions(first));
    historyB = await createGrokHistoryProcess(processOptions(second));
    const beforeSearch = await grokFixtureDigests(first.nativeHome);
    assert(historyA.metadataSearch.status === 'supported' && historyA.contentSearch.status === 'supported');
    const metadata = await historyA.metadataSearch.search({ query: 'ALPHA', limit: 1 });
    assert.deepEqual(metadata.items.map((hit) => hit.conversation.ref.conversationId), [first.ids.alpha]);
    assert.deepEqual((await historyA.metadataSearch.search({ query: 'message' })).items, []);
    const searchFirst = await historyA.contentSearch.search({ query: 'MESSAGE', limit: 1 });
    assert(searchFirst.nextCursor); assert.equal(searchFirst.items.length, 1);
    const searchNext = await historyA.contentSearch.search({ query: 'MESSAGE', limit: 1, cursor: searchFirst.nextCursor });
    assert.deepEqual([...searchFirst.items, ...searchNext.items].map((hit) => hit.conversation.ref.conversationId), [first.ids.alpha, first.ids.beta]);
    assert.deepEqual(searchFirst.items[0]?.matchedFields, ['transcript']); assert.equal(typeof searchFirst.items[0]?.score, 'number');
    assert.match(searchFirst.items[0]?.snippet ?? '', /\[message\]/iu);
    assert.equal(searchNext.nextCursor, undefined); assert.equal(searchNext.totalEstimate, 2);
    assert(searchNext.coverage.omissions.includes('provider_omission'));
    assert.deepEqual(await grokFixtureDigests(first.nativeHome), beforeSearch);
    assert.equal(historyA.rename.status, 'unsupported'); assert.equal(historyA.delete.status, 'unsupported');
    const catalogIds: string[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 8; index += 1) {
      const page: AgentHistoryCatalogPage = await ports(historyA).catalog({ limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      catalogIds.push(...page.items.map((item) => item.ref.conversationId));
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    assert.equal(cursor, undefined);
    assert.deepEqual(catalogIds, [first.ids.empty, first.ids.beta, first.ids.alpha]);
    const alpha = await read(historyA, first.ids.alpha), beta = await read(historyA, first.ids.beta);
    assert.deepEqual(alpha.map((record) => record.kind === 'message' ? record.content : record), [
      [{ kind: 'text', text: 'STORE-A Alpha message 0' }], [{ kind: 'text', text: 'STORE-A Alpha adjacent chunk' }],
      [{ kind: 'text', text: 'STORE-A Alpha message 1' }], [{ kind: 'text', text: 'STORE-A Alpha message 2' }],
      [{ kind: 'text', text: 'STORE-A Alpha message 3' }], [{ kind: 'text', text: 'STORE-A Alpha message 4' }],
      [{ kind: 'text', text: 'STORE-A Alpha message 5' }],
    ]);
    assert.deepEqual(alpha.map((record) => record.native), [{ itemId: `${first.ids.alpha}-1` }, ...Array.from({ length: 6 }, () => undefined)]);
    assert.deepEqual(beta.map((record) => record.kind === 'message' ? record.content : record), [
      [{ kind: 'text', text: 'STORE-A Beta message 0' }], [{ kind: 'text', text: 'STORE-A Beta message 1' }],
      [{ kind: 'text', text: 'STORE-A Beta replacement' }], [{ kind: 'text', text: 'STORE-A Beta replacement answer' }],
    ]);
    const empty = await read(historyA, first.ids.empty);
    assert.deepEqual(empty, []);
    assert.equal((await ports(historyA).lookup({ conversation: ref(historyA, first.ids.empty) })).title, 'STORE-A Empty');
    await assert.rejects(ports(historyA).lookup({ conversation: ref(historyA, first.ids.missing) }), code('not_found'));
    await assert.rejects(ports(historyA).lookup({ conversation: ref(historyA, first.ids.foreign) }), code('unsupported_scope'));
    assert.equal((await ports(historyB).lookup({ conversation: ref(historyB, second.ids.alpha) })).title, 'STORE-B Alpha');
    const secondPage = await ports(historyB).transcript({ conversation: ref(historyB, second.ids.alpha), limit: 1 });
    assert.deepEqual(secondPage.items.map((record) => record.kind === 'message' ? record.content : record), [[{ kind: 'text', text: 'STORE-B Alpha message 0' }]]);

    native = await openGrokFixtureConnection(first, grokHistoryExtensions());
    await assert.rejects(native.request('_x.ai/session/load_history', { sessionId: first.ids.alpha, cwd: first.projectPath },
      { lifetime: 'until_settled' }), code(-32601));
    borrowed = createGrokHistory({ ...common(first), connection: connection(native) });
    assert.equal((await read(borrowed, first.ids.alpha)).length, 7);
    await borrowed.close(); process.kill(native.pid, 0);
    const state = await native.request('_x.ai/session/state', { sessionId: first.ids.alpha, cwd: first.projectPath });
    const summary = state !== null && typeof state === 'object' && !Array.isArray(state) ? state.summary : undefined;
    assert.equal(summary !== null && typeof summary === 'object' && !Array.isArray(summary) ? summary.session_summary : undefined, 'STORE-A Alpha');
    const executionMethods = native.methods.filter((method) => !['initialize', 'session/list', '_x.ai/session/state',
      '_x.ai/session/updates', '_x.ai/session/load_history'].includes(method));
    assert.deepEqual(executionMethods, []);
    assert.equal(native.methods.filter((method) => method === '_x.ai/session/load_history').length, 1);
    const browseExample = await proveBrowseExample(historyA, first.ids.alpha,
      { catalogCount: 3, transcript: { status: 'read', records: 7, view: 'stored_updates' } });
    await native.close(); await historyA.close(); await historyB.close();
    historyA = await createGrokHistoryProcess({ ...processOptions(first), management: ['rename', 'delete'], localManagement: { kind: 'caller_quiescent' } });
    assert(historyA.rename.status === 'supported' && historyA.delete.status === 'supported');
    const alphaRef = ref(historyA, first.ids.alpha), effects = historyA.rename.descriptor.effects;
    assert.deepEqual(effects, { scope: 'local', descendants: 'none', active: 'requires_quiescent', atomicity: 'unknown' });
    const rejected = await historyA.rename.apply({ conversation: alphaRef, title: 'Not accepted', acceptEffects: { ...effects, scope: 'remote' } });
    assert.equal(rejected.status, 'not_applied');
    assert.equal((await historyA.rename.apply({ conversation: alphaRef, title: 'Packed local rename', acceptEffects: effects })).status, 'applied');
    assert.equal((await ports(historyA).lookup({ conversation: alphaRef })).title, 'Packed local rename');
    assert.equal((await historyA.delete.apply({ conversation: alphaRef, acceptEffects: historyA.delete.descriptor.effects })).status, 'applied');
    assert.equal((await historyA.delete.apply({ conversation: alphaRef, acceptEffects: historyA.delete.descriptor.effects })).status, 'applied');
    await assert.rejects(ports(historyA).lookup({ conversation: alphaRef }), code('not_found'));
    assert.equal((await ports(historyA).lookup({ conversation: ref(historyA, first.ids.child) })).parent?.conversationId, first.ids.alpha);
    await historyA.close();
    const proxy = await createGrokResponseLossLauncher(first), base = processOptions(first);
    historyA = await createGrokHistoryProcess({ ...base, resources: { ...base.resources, resourceLauncher: proxy.executable },
      management: ['rename'], localManagement: { kind: 'caller_quiescent' } });
    assert(historyA.rename.status === 'supported');
    const lostInput = { conversation: ref(historyA, first.ids.beta), title: 'Packed receipt lost', acceptEffects: historyA.rename.descriptor.effects };
    const controller = new AbortController(), pending = historyA.rename.apply(lostInput, { signal: controller.signal, deadlineMs: 20_000 });
    try { await waitForGrokWithheldReceipt(proxy.trace); }
    finally { controller.abort(); }
    const lost = await pending; assert.equal(lost.status, 'outcome_unknown');
    let reconciled = false;
    for (let index = 0; index < 100; index += 1) {
      try { assert.equal((await ports(historyA).lookup({ conversation: lostInput.conversation })).title, lostInput.title); reconciled = true; break; }
      catch (error) { if (!code('busy')(error)) throw error; await delay(10); }
    }
    assert(reconciled);
    const fenced = await historyA.rename.apply(lostInput); assert.equal(fenced.status, 'not_applied'); assert.equal(fenced.reason.code, 'unsupported_scope');
    const withheldReceipts = (await readFile(proxy.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(withheldReceipts, [{ method: '_x.ai/session/rename', result: { success: true } }]);
    await historyA.close();
    assert.deepEqual(await readdir(first.temporaryRoot), []); assert.deepEqual(await readdir(second.temporaryRoot), []);
    return { runtimeVersion: '1.0.62', catalogIds, alphaRecords: alpha.length, betaRecords: beta.length, emptyRecords: empty.length,
      missing: 'not_found', otherProject: 'unsupported_scope', sourceIsolation: true, workerRootsAfterClose: 0,
      loadHistoryCode: -32601, executionMethods, metadataSearch: 'native-case-insensitive', contentSearch: 'native-fts-user-prompts',
      nativeSearchHits: 2, sourceBytesPreservedBySearch: true, localRename: 'applied', localDelete: 'applied',
      missingDelete: 'applied', childRetained: true, lostNativeReceipt: lost.status, duplicateMutationFenced: true,
      withheldNativeReceipts: withheldReceipts.length, browseExample };
  } finally {
    await borrowed?.close(); await native?.close(); await historyA?.close(); await historyB?.close();
    await first.cleanup(); await second?.cleanup();
  }
}
