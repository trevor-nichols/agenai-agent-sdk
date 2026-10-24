import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { parseAgentIsoDateTime, parseAgentProviderConversationId, parseAgentProviderKey } from '@agen-ai/agent-protocol';
import {
  AgentHistoryCleanupError, AgentHistoryError, AgentHistoryValidationError, createAgentHistory,
  type AgentHistoryCatalogDescriptor, type AgentHistoryCatalogFilter, type AgentHistoryCatalogPage, type AgentHistoryConversationRef,
  type AgentHistoryConversationSummary, type AgentHistoryDriver, type AgentHistoryDriverMethod,
  type AgentHistoryErrorCode, type AgentHistoryListInput, type AgentHistoryMutationEffects, type AgentHistoryMutationResult,
  type AgentHistoryPage, type AgentHistoryPort, type AgentHistoryReadInput, type AgentHistoryRecord,
  type AgentHistorySource, type AgentHistoryStorageEffect, type AgentHistoryTranscriptPage, type AgentHistoryViewSummary,
} from '../src/index.js';

const observedAt = parseAgentIsoDateTime('2026-10-21T12:00:00Z');
const effects: AgentHistoryMutationEffects = {
  scope: 'local', descendants: 'none', active: 'requires_quiescent', atomicity: 'atomic',
};

function source(overrides: Partial<AgentHistorySource> = {}): AgentHistorySource {
  return {
    providerKey: parseAgentProviderKey('fixture-history'), sourceId: 'owned-store', generation: 'generation-one',
    kind: 'fixture-store', scope: { kind: 'all_projects' }, storageEffects: { kind: 'none' },
    resourceOwnership: 'borrowed', ...overrides,
  };
}

function ref(value: AgentHistorySource, id = 'conversation-alpha'): AgentHistoryConversationRef {
  return {
    source: { providerKey: value.providerKey, sourceId: value.sourceId, generation: value.generation },
    conversationId: parseAgentProviderConversationId(id),
  };
}

function summary(value: AgentHistorySource, id = 'conversation-alpha', title = 'Alpha conversation'): AgentHistoryConversationSummary {
  return { ref: ref(value, id), title, archiveState: 'not_archived' };
}

function page<Item>(items: readonly Item[], nextCursor?: string): AgentHistoryPage<Item> {
  return {
    items, observedAt, consistency: 'live',
    coverage: { view: 'catalog', children: 'excluded', omissions: [] },
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function unsupported() {
  return { status: 'unsupported' as const, reason: { code: 'native_unavailable' as const, message: 'Fixture native operation is unavailable.' } };
}

function driver(overrides: Partial<AgentHistoryDriver> = {}): AgentHistoryDriver {
  return {
    views: unsupported(),
    catalog: unsupported(), lookup: unsupported(), transcript: unsupported(), metadataSearch: unsupported(),
    contentSearch: unsupported(), rename: unsupported(), archive: unsupported(), restore: unsupported(),
    delete: unsupported(), ...overrides,
  };
}

function catalog(
  list: AgentHistoryDriverMethod<AgentHistoryListInput, AgentHistoryCatalogPage>,
  descriptor: Partial<AgentHistoryCatalogDescriptor> = {},
): AgentHistoryDriver['catalog'] {
  return { status: 'supported', descriptor: { filters: [], orders: ['native'], pagination: 'cursor', ...descriptor }, list };
}

function transcript(read: AgentHistoryDriverMethod<AgentHistoryReadInput, AgentHistoryTranscriptPage>): AgentHistoryDriver['transcript'] {
  return { status: 'supported', descriptor: { views: ['main', 'subagent'], pagination: 'cursor' }, read };
}

function supported<Descriptor, Methods>(port: AgentHistoryPort<Descriptor, Methods>): Readonly<{ status: 'supported'; descriptor: Descriptor }> & Readonly<Methods> {
  if (port.status !== 'supported') assert.fail('The fixture operation must be publicly supported.');
  return port;
}

function continuation(value: { readonly nextCursor?: string }): string {
  if (value.nextCursor === undefined) assert.fail('The first native page must expose a scoped continuation.');
  return value.nextCursor;
}

function code(expected: AgentHistoryErrorCode) {
  return (error: unknown) => error instanceof AgentHistoryError && error.code === expected;
}

test('source configuration is captured immutably and unsupported operations expose no callable method', async () => {
  const initialEffects: [AgentHistoryStorageEffect] = ['updates_index'];
  const supplied = {
    ...source(),
    scope: { kind: 'project' as const, projectPath: '/owned/project', worktrees: 'excluded' as const },
    storageEffects: { kind: 'possible' as const, effects: initialEffects },
  };
  const unavailableLookup = { ...unsupported(), get: async () => summary(supplied) };
  const history = createAgentHistory({ source: supplied, driver: driver({
    lookup: unavailableLookup,
  }) });
  supplied.sourceId = 'reconfigured-store';
  supplied.scope.projectPath = '/different/project';
  supplied.storageEffects.effects[0] = 'updates_auxiliary_files';
  assert.deepEqual(history.source, {
    providerKey: 'fixture-history', sourceId: 'owned-store', generation: 'generation-one', kind: 'fixture-store',
    scope: { kind: 'project', projectPath: '/owned/project', worktrees: 'excluded' },
    storageEffects: { kind: 'possible', effects: ['updates_index'] }, resourceOwnership: 'borrowed',
  });
  assert.equal(Reflect.set(history.source, 'generation', 'corrupt'), false);
  assert.equal(Reflect.set(history.source.scope, 'projectPath', '/corrupt'), false);
  assert.equal(history.lookup.status, 'unsupported');
  assert.equal('get' in history.lookup, false);
  assert.equal('search' in history.contentSearch, false);
  await history.close();
});

test('native disposal is required for owned sources and forbidden for borrowed resources', async () => {
  let disposals = 0;
  const dispose = async () => { disposals += 1; };
  assert.throws(() => createAgentHistory({ source: source({ resourceOwnership: 'owned' }), driver: driver() }), code('invalid_input'));
  assert.throws(() => createAgentHistory({ source: source(), driver: driver({ dispose }) }), code('invalid_input'));
  const owned = createAgentHistory({ source: source({ resourceOwnership: 'owned' }), driver: driver({ dispose }) });
  const borrowed = createAgentHistory({ source: source(), driver: driver() });
  await borrowed.close();
  assert.equal(disposals, 0);
  await owned.close();
  await owned.close();
  assert.equal(disposals, 1);
});

test('catalog continuations preserve native paging and reject foreign source, generation and query before delegation', async () => {
  const configured = source();
  const nativeCursors: (string | null)[] = [];
  const history = createAgentHistory({ source: configured, driver: driver({ catalog: catalog(async (input) => {
    nativeCursors.push(input.cursor ?? null);
    return input.cursor === undefined
      ? page([summary(configured)], 'native-catalog-page-two')
      : page([summary(configured, 'conversation-beta', 'Beta conversation')]);
  }, { filters: ['archived'] }) }) });
  const list = supported(history.catalog).list;
  const first = await list({ limit: 1 });
  const cursor = continuation(first);
  const second = await list({ limit: 1, cursor });
  assert.deepEqual([first.items[0].title, second.items[0].title], ['Alpha conversation', 'Beta conversation']);
  assert.equal(second.nextCursor, undefined);
  assert.deepEqual(nativeCursors, [null, 'native-catalog-page-two']);
  await assert.rejects(list({ limit: 1, cursor, archived: 'only' }), code('invalid_cursor'));
  assert.deepEqual(nativeCursors, [null, 'native-catalog-page-two']);
  for (const identity of [{ sourceId: 'other-store' }, { generation: 'generation-two' }]) {
    const other = source(identity);
    let calls = 0;
    const foreign = createAgentHistory({ source: other, driver: driver({ catalog: catalog(async () => {
      calls += 1;
      return page([summary(other, 'conversation-foreign', 'Foreign conversation')]);
    }) }) });
    await assert.rejects(supported(foreign.catalog).list({ cursor, limit: 1 }), code('invalid_cursor'));
    assert.equal(calls, 0);
    const valid = await supported(foreign.catalog).list({ limit: 1 });
    assert.equal(valid.items[0].title, 'Foreign conversation');
    assert.equal(calls, 1);
    await foreign.close();
  }
  await history.close();
});

test('rewriting native cursor payload or reopening the same source cannot bypass continuation binding', async () => {
  const configured = source();
  const nativeCursors: (string | null)[] = [];
  const create = () => createAgentHistory({ source: configured, driver: driver({ catalog: catalog(async (input) => {
    nativeCursors.push(input.cursor ?? null);
    return input.cursor === undefined
      ? page([summary(configured)], 'native-protected-page-two')
      : page([summary(configured, 'conversation-beta', 'Beta conversation')]);
  }) }) });
  const history = create();
  const first = await supported(history.catalog).list({ limit: 1 });
  const original = continuation(first);
  const [payload, ...authentication] = original.split('.');
  const envelope: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope) || !('native' in envelope)) {
    assert.fail('The issued cursor must expose the native continuation to this adversarial payload case.');
  }
  const changedPayload = Buffer.from(JSON.stringify({ ...envelope, native: 'attacker-native-continuation' }), 'utf8').toString('base64url');
  const rewritten = [changedPayload, ...authentication].join('.');
  await assert.rejects(supported(history.catalog).list({ cursor: rewritten, limit: 1 }), code('invalid_cursor'));
  assert.deepEqual(nativeCursors, [null]);
  assert.equal((await supported(history.catalog).list({ cursor: original, limit: 1 })).items[0].title, 'Beta conversation');
  assert.deepEqual(nativeCursors, [null, 'native-protected-page-two']);
  await history.close();
  const reopened = create();
  await assert.rejects(supported(reopened.catalog).list({ cursor: original, limit: 1 }), code('invalid_cursor'));
  assert.deepEqual(nativeCursors, [null, 'native-protected-page-two']);
  assert.equal((await supported(reopened.catalog).list({ limit: 1 })).items[0].title, 'Alpha conversation');
  assert.deepEqual(nativeCursors, [null, 'native-protected-page-two', null]);
  await reopened.close();
});

test('transcript and search continuations cannot cross conversations, views, operations or search queries', async () => {
  const configured = source();
  let transcriptCalls = 0;
  let searchCalls = 0;
  const nativeRecord: AgentHistoryRecord = { kind: 'compaction', summary: 'Surviving native summary' };
  const history = createAgentHistory({ source: configured, driver: driver({
    catalog: catalog(async () => page([summary(configured)], 'catalog-native-cursor')),
    transcript: transcript(async (input) => {
      transcriptCalls += 1;
      return { ...page([nativeRecord], input.cursor === undefined ? 'transcript-native-cursor' : undefined),
        coverage: { view: 'stored_updates', children: 'excluded', omissions: ['compacted', 'native_retention'] } };
    }),
    metadataSearch: { status: 'supported', descriptor: {
      syntax: 'literal', caseSensitivity: 'insensitive', ranking: 'none', scope: 'title', filters: [], orders: ['native'],
    }, search: async () => {
      searchCalls += 1;
      return searchCalls === 1
        ? { ...page([{ conversation: summary(configured), score: 0.75, matchedFields: ['title' as const] }], 'search-native-cursor'), totalEstimate: 12 }
        : page([{ conversation: summary(configured) }], 'search-native-cursor');
    } },
  }) });
  const conversation = ref(configured);
  const read = supported(history.transcript).read;
  const first = await read({ conversation, limit: 1 });
  assert.deepEqual(first.items, [{ kind: 'compaction', summary: 'Surviving native summary' }]);
  assert.equal(first.consistency, 'live');
  assert.deepEqual(first.coverage, { view: 'stored_updates', children: 'excluded', omissions: ['compacted', 'native_retention'] });
  const cursor = continuation(first);
  await assert.rejects(read({ conversation: ref(configured, 'conversation-beta'), cursor, limit: 1 }), code('invalid_cursor'));
  await assert.rejects(read({ conversation, view: { kind: 'subagent', id: 'native-child' }, cursor, limit: 1 }), code('invalid_cursor'));
  const catalogCursor = continuation(await supported(history.catalog).list({ limit: 1 }));
  await assert.rejects(read({ conversation, cursor: catalogCursor, limit: 1 }), code('invalid_cursor'));
  assert.equal(transcriptCalls, 1);
  const last = await read({ conversation, cursor, limit: 1 });
  assert.equal(last.nextCursor, undefined);
  assert.equal(transcriptCalls, 2);
  const search = supported(history.metadataSearch).search;
  const searched = await search({ query: 'alpha', limit: 1 });
  assert.deepEqual(searched.items, [{ conversation: summary(configured), score: 0.75, matchedFields: ['title'] }]);
  assert.equal(searched.totalEstimate, 12);
  await assert.rejects(search({ query: 'beta', limit: 1, cursor: continuation(searched) }), code('invalid_cursor'));
  assert.equal(searchCalls, 1);
  const valid = await search({ query: 'beta', limit: 1 });
  assert.equal(valid.items[0].conversation.title, 'Alpha conversation');
  assert.equal(valid.totalEstimate, undefined);
  assert.equal(valid.items[0].score, undefined);
  assert.equal(valid.items[0].matchedFields, undefined);
  assert.equal(searchCalls, 2);
  await history.close();
});

test('unsupported filters, raw native options and foreign references fail without native reads', async () => {
  const configured = source();
  let calls = 0;
  const suppliedFilters: AgentHistoryCatalogFilter[] = [];
  const history = createAgentHistory({ source: configured, driver: driver({
    catalog: catalog(async () => { calls += 1; return page([summary(configured)]); }, { filters: suppliedFilters }),
    lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' }, get: async () => { calls += 1; return summary(configured); } },
  }) });
  suppliedFilters.push('archived');
  const list = supported(history.catalog).list;
  await assert.rejects(list({ archived: 'only' }), code('unsupported_scope'));
  await assert.rejects(list({ order: 'updated_desc' }), code('unsupported_scope'));
  const rawInput = { limit: 1, nativeFilter: { includeEveryAccount: true } };
  await assert.rejects(list(rawInput), (error: unknown) => error instanceof AgentHistoryValidationError);
  await assert.rejects(supported(history.lookup).get({ conversation: ref(source({ sourceId: 'foreign' })) }), code('wrong_source'));
  assert.equal(calls, 0);
  assert.equal((await list({ limit: 1 })).items[0].title, 'Alpha conversation');
  assert.equal((await supported(history.lookup).get({ conversation: ref(configured) })).ref.conversationId, 'conversation-alpha');
  assert.equal(calls, 2);
  await history.close();
});

test('public reads enforce source references, requested record count, output bytes and continuation progress', async () => {
  const configured = source();
  let response = page([summary(configured)]);
  let calls = 0;
  const history = createAgentHistory({ source: configured, limits: { pageSize: 1, pageBytes: 1024 }, driver: driver({
    catalog: catalog(async () => { calls += 1; return response; }),
  }) });
  const list = supported(history.catalog).list;
  assert.equal((await list({})).items[0].title, 'Alpha conversation');
  await assert.rejects(list({ limit: 2 }), code('limit_exhausted'));
  assert.equal(calls, 1);
  response = page([summary(source({ generation: 'wrong-generation' }))]);
  await assert.rejects(list({}), code('native_failure'));
  response = page([summary(configured), summary(configured, 'conversation-beta')]);
  await assert.rejects(list({}), code('limit_exhausted'));
  response = page([summary(configured, 'conversation-alpha', 'x'.repeat(1500))]);
  await assert.rejects(list({}), code('limit_exhausted'));
  response = page([summary(configured)], 'stuck-native-continuation');
  const first = await list({});
  await assert.rejects(list({ cursor: continuation(first) }), code('native_failure'));
  response = page([summary(configured, 'conversation-beta', 'Recovered conversation')]);
  assert.equal((await list({})).items[0].title, 'Recovered conversation');
  await history.close();
});

test('configured read capacity admits overlapping reads and rejects excess work before native entry', { timeout: 3000 }, async (t) => {
  const configured = source();
  const firstRelease = Promise.withResolvers<void>();
  const secondRelease = Promise.withResolvers<void>();
  const bothEntered = Promise.withResolvers<void>();
  let calls = 0;
  const history = createAgentHistory({ source: configured, limits: { concurrentReads: 2 }, driver: driver({
    catalog: catalog(async () => {
      calls += 1;
      const number = calls;
      if (number === 2) bothEntered.resolve();
      if (number === 1) await firstRelease.promise;
      if (number === 2) await secondRelease.promise;
      return page([summary(configured, `conversation-${number}`, `Conversation ${number}`)]);
    }),
  }) });
  t.after(async () => { firstRelease.resolve(); secondRelease.resolve(); await history.close(); });
  const list = supported(history.catalog).list;
  const first = list({});
  const second = list({});
  await bothEntered.promise;
  await assert.rejects(list({}), code('busy'));
  assert.equal(calls, 2);
  firstRelease.resolve();
  assert.equal((await first).items[0].title, 'Conversation 1');
  assert.equal((await list({})).items[0].title, 'Conversation 3');
  assert.equal(calls, 3);
  secondRelease.resolve();
  assert.equal((await second).items[0].title, 'Conversation 2');
});

test('pre-aborted and invalid-deadline reads do not enter native code', async () => {
  const configured = source();
  let calls = 0;
  const history = createAgentHistory({ source: configured, driver: driver({ catalog: catalog(async () => {
    calls += 1;
    return page([summary(configured)]);
  }) }) });
  const cancelled = AbortSignal.abort(new Error('Caller cancelled before entry'));
  const list = supported(history.catalog).list;
  await assert.rejects(list({}, { signal: cancelled }), code('cancelled'));
  await assert.rejects(list({}, { deadlineMs: 0 }), code('invalid_input'));
  assert.equal(calls, 0);
  assert.equal((await list({})).items[0].title, 'Alpha conversation');
  assert.equal(calls, 1);
  await history.close();
});

test('a read deadline aborts the native operation but retains capacity until it settles', { timeout: 3000 }, async (t) => {
  const configured = source();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let nativeAbort = false;
  const history = createAgentHistory({ source: configured, limits: { concurrentReads: 1 }, driver: driver({ catalog: catalog(async (_input, context) => {
    calls += 1;
    if (calls === 1) {
      context.signal.addEventListener('abort', () => { nativeAbort = true; }, { once: true });
      entered.resolve();
      await release.promise;
    }
    return page([summary(configured)]);
  }) }) });
  t.after(async () => { release.resolve(); await history.close(); });
  const list = supported(history.catalog).list;
  const timedOut = assert.rejects(list({}, { deadlineMs: 15 }), code('deadline_exceeded'));
  await entered.promise;
  await timedOut;
  assert.equal(nativeAbort, true);
  await assert.rejects(list({}), code('busy'));
  assert.equal(calls, 1);
  release.resolve();
  await nextTurn();
  assert.equal((await list({})).items[0].title, 'Alpha conversation');
  assert.equal(calls, 2);
});

test('close rejects admission, aborts entered reads before disposal and coalesces until native drain', { timeout: 3000 }, async (t) => {
  const configured = source({ resourceOwnership: 'owned' });
  const entered = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  const disposalStarted = Promise.withResolvers<void>();
  const releaseDisposal = Promise.withResolvers<void>();
  const events: string[] = [];
  let calls = 0;
  const history = createAgentHistory({ source: configured, driver: driver({
    catalog: catalog(async (_input, context) => {
      calls += 1;
      context.signal.addEventListener('abort', () => events.push('read-aborted'), { once: true });
      entered.resolve();
      await releaseRead.promise;
      events.push('read-settled');
      return page([summary(configured)]);
    }),
    dispose: async () => { events.push('dispose-started'); disposalStarted.resolve(); await releaseDisposal.promise; events.push('dispose-settled'); },
  }) });
  t.after(async () => { releaseRead.resolve(); releaseDisposal.resolve(); await history.close(); });
  const list = supported(history.catalog).list;
  const reading = assert.rejects(list({}), code('closed'));
  await entered.promise;
  const firstClose = history.close();
  const secondClose = history.close();
  assert.equal(firstClose, secondClose);
  await disposalStarted.promise;
  assert.deepEqual(events, ['read-aborted', 'dispose-started']);
  await assert.rejects(list({}), code('closed'));
  assert.equal(calls, 1);
  await reading;
  let closed = false;
  void firstClose.then(() => { closed = true; });
  releaseDisposal.resolve();
  await nextTurn();
  assert.equal(closed, false);
  assert.deepEqual(events, ['read-aborted', 'dispose-started', 'dispose-settled']);
  releaseRead.resolve();
  await firstClose;
  assert.equal(closed, true);
  assert.deepEqual(events, ['read-aborted', 'dispose-started', 'dispose-settled', 'read-settled']);
  await history.close();
  assert.equal(events.filter((event) => event === 'dispose-started').length, 1);
});

test('failed cleanup retains retry ownership and keeps source admission closed', async () => {
  const configured = source({ resourceOwnership: 'owned' });
  let disposals = 0;
  let reads = 0;
  const history = createAgentHistory({ source: configured, driver: driver({
    catalog: catalog(async () => { reads += 1; return page([summary(configured)]); }),
    dispose: async () => { disposals += 1; if (disposals === 1) throw new Error('native credential must not escape'); },
  }) });
  const failure = await history.close().then(() => assert.fail('Failed native disposal must reject close'), (error: unknown) => {
    if (!(error instanceof AgentHistoryCleanupError)) throw error;
    assert.equal(error.code, 'cleanup_failed');
    assert.equal(error.message.includes('native credential'), false);
    return error;
  });
  await assert.rejects(supported(history.catalog).list({}), code('closed'));
  assert.equal(reads, 0);
  await failure.retryCleanup();
  await history.close();
  assert.equal(disposals, 2);
});

test('cleanup deadline preserves the pending native disposal instead of starting a duplicate', { timeout: 3000 }, async (t) => {
  const release = Promise.withResolvers<void>();
  let disposals = 0;
  const history = createAgentHistory({ source: source({ resourceOwnership: 'owned' }), limits: { cleanupDeadlineMs: 20 }, driver: driver({
    dispose: async () => { disposals += 1; await release.promise; },
  }) });
  t.after(async () => { release.resolve(); await history.close(); });
  const failure = await history.close().then(() => assert.fail('A pending native disposal must exceed the cleanup deadline'), (error: unknown) => {
    if (!(error instanceof AgentHistoryCleanupError)) throw error;
    assert.equal(error.code, 'cleanup_failed');
    return error;
  });
  assert.equal(disposals, 1);
  const retry = failure.retryCleanup();
  const coalesced = history.close();
  assert.equal(retry, coalesced);
  release.resolve();
  await retry;
  assert.equal(disposals, 1);
});

test('management is disabled by default and enabling rename requires exact acceptance of native effects', async () => {
  const configured = source();
  let nativeTitle = 'Original conversation';
  let mutations = 0;
  const native = driver({
    lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' }, get: async () => summary(configured, 'conversation-alpha', nativeTitle) },
    rename: { status: 'supported', descriptor: { effects }, apply: async (input, context) => {
      context.markDispatched();
      mutations += 1;
      nativeTitle = input.title;
      return { status: 'applied', ref: input.conversation };
    } },
  });
  const disabled = createAgentHistory({ source: configured, driver: native });
  assert.equal(disabled.rename.status, 'unsupported');
  assert.equal('apply' in disabled.rename, false);
  assert.equal((await supported(disabled.lookup).get({ conversation: ref(configured) })).title, 'Original conversation');
  await disabled.close();
  const enabled = createAgentHistory({ source: configured, driver: native, management: ['rename'] });
  const rename = supported(enabled.rename).apply;
  const rejected = await rename({ conversation: ref(configured), title: 'Changed conversation', acceptEffects: { ...effects, scope: 'remote' } });
  assert.equal(rejected.status, 'not_applied');
  assert.deepEqual(rejected.ref, ref(configured));
  assert.equal(rejected.reason.code, 'effects_not_accepted');
  assert.equal(mutations, 0);
  const applied = await rename({ conversation: ref(configured), title: 'Changed conversation', acceptEffects: effects });
  assert.deepEqual(applied, { status: 'applied', ref: ref(configured) });
  assert.equal((await supported(enabled.lookup).get({ conversation: ref(configured) })).title, 'Changed conversation');
  assert.equal(mutations, 1);
  await enabled.close();
});

test('an applied mutation receipt survives a read-page budget too small to contain it', async () => {
  const configured = source();
  let removed = false;
  const history = createAgentHistory({ source: configured, limits: { pageBytes: 1 }, management: ['delete'], driver: driver({
    delete: { status: 'supported', descriptor: { effects }, apply: async (input, context) => {
      context.markDispatched();
      removed = true;
      return { status: 'applied', ref: input.conversation };
    } },
  }) });
  assert.deepEqual(await supported(history.delete).apply({ conversation: ref(configured), acceptEffects: effects }), { status: 'applied', ref: ref(configured) });
  assert.equal(removed, true);
  await history.close();
});

for (const interruption of ['cancel', 'deadline'] as const) {
  test(`an observed mutation receipt survives ${interruption} and failed cleanup while close retains the entered work`, { timeout: 3000 }, async (t) => {
    const configured = source({ resourceOwnership: 'owned' });
    const cleanup = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    let nativeTitle = 'Original conversation', disposals = 0;
    const history = createAgentHistory({ source: configured, management: ['rename'], driver: driver({
      lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' }, get: async () => summary(configured, 'conversation-alpha', nativeTitle) },
      rename: { status: 'supported', descriptor: { effects }, apply: async (input, context) => {
        context.markDispatched();
        nativeTitle = input.title;
        context.recordReceipt({ status: 'applied', ref: input.conversation });
        observed.resolve();
        await cleanup.promise;
        throw new AgentHistoryError('cleanup_failed', 'Native mutation settled but cleanup needs retry.');
      } },
      dispose: async () => {
        disposals += 1;
        if (disposals === 1) throw new Error('Native cleanup has not joined yet.');
        await cleanup.promise;
      },
    }) });
    t.after(async () => { cleanup.resolve(); await history.close(); });
    const controller = new AbortController();
    const pending = supported(history.rename).apply({ conversation: ref(configured), title: 'Confirmed title', acceptEffects: effects },
      { signal: controller.signal, deadlineMs: interruption === 'deadline' ? 20 : 1000 });
    await observed.promise;
    if (interruption === 'cancel') controller.abort();
    const result = await pending;
    assert.deepEqual(result, { status: 'applied', ref: ref(configured) });
    assert.equal(nativeTitle, 'Confirmed title');
    await assert.rejects(supported(history.lookup).get({ conversation: ref(configured) }), code('busy'));
    let failure: AgentHistoryCleanupError | undefined;
    await assert.rejects(history.close(), (error: unknown) => {
      assert(error instanceof AgentHistoryCleanupError);
      failure = error;
      return true;
    });
    assert(failure);
    const retry = failure.retryCleanup();
    let joined = false;
    void retry.then(() => { joined = true; });
    await nextTurn();
    assert.equal(joined, false);
    cleanup.resolve();
    await retry;
    assert.equal(disposals, 2);
    assert.deepEqual(result, { status: 'applied', ref: ref(configured) });
  });
}

test('a dispatched native receipt for the wrong conversation becomes uncertain and fences another mutation', async () => {
  for (const delivery of ['returned', 'recorded'] as const) {
    const configured = source();
    let mutations = 0;
    let nativeTitle = 'Original conversation';
    const history = createAgentHistory({ source: configured, management: ['rename'], driver: driver({
      lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' }, get: async () => summary(configured, 'conversation-alpha', nativeTitle) },
      rename: { status: 'supported', descriptor: { effects }, apply: async (input, context) => {
        context.markDispatched();
        mutations += 1;
        nativeTitle = input.title;
        const wrongReceipt = { status: 'applied' as const, ref: ref(configured, 'conversation-other') };
        if (delivery === 'recorded') context.recordReceipt(wrongReceipt);
        return wrongReceipt;
      } },
    }) });
    const rename = supported(history.rename).apply;
    const outcome = await rename({ conversation: ref(configured), title: 'Native mutation entered', acceptEffects: effects });
    assert.equal(outcome.status, 'outcome_unknown');
    assert.deepEqual(outcome.ref, ref(configured));
    assert.equal(outcome.reason.code, 'native_failure');
    const fenced = await rename({ conversation: ref(configured), title: 'Must remain fenced', acceptEffects: effects });
    assert.equal(fenced.status, 'not_applied');
    assert.equal(fenced.reason.code, 'unsupported_scope');
    assert.equal((await supported(history.lookup).get({ conversation: ref(configured) })).title, 'Native mutation entered');
    assert.equal(mutations, 1);
    await history.close();
  }
});

test('a dispatched native rejection never admits a second mutation during settlement', async (t) => {
  for (let yieldedMicrotasks = 0; yieldedMicrotasks <= 8; yieldedMicrotasks += 1) {
    const configured = source();
    const entered = Promise.withResolvers<void>();
    const native = Promise.withResolvers<AgentHistoryMutationResult>();
    let nativeTitle = 'Original conversation';
    let mutations = 0;
    const history = createAgentHistory({ source: configured, management: ['rename'], driver: driver({
      lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' }, get: async () => summary(configured, 'conversation-alpha', nativeTitle) },
      rename: { status: 'supported', descriptor: { effects }, apply: (input, context) => {
        context.markDispatched();
        mutations += 1;
        nativeTitle = input.title;
        if (mutations === 1) { entered.resolve(); return native.promise; }
        return Promise.resolve({ status: 'applied' as const, ref: input.conversation });
      } },
    }) });
    t.after(() => history.close());
    const rename = supported(history.rename).apply;
    const first = rename({ conversation: ref(configured), title: 'Entered native mutation', acceptEffects: effects });
    await entered.promise;
    native.reject(new Error('Native response lost after dispatch'));
    for (let index = 0; index < yieldedMicrotasks; index += 1) await Promise.resolve();
    const second = await rename({ conversation: ref(configured), title: 'Second mutation must not enter', acceptEffects: effects });
    assert.equal(second.status, 'not_applied', `A rejected dispatched mutation must retain admission authority after ${yieldedMicrotasks} microtask yields.`);
    assert.equal(['busy', 'unsupported_scope'].includes(second.reason.code), true);
    const outcome = await first;
    assert.equal(outcome.status, 'outcome_unknown');
    assert.equal(outcome.reason.code, 'native_failure');
    assert.equal(mutations, 1);
    assert.equal((await supported(history.lookup).get({ conversation: ref(configured) })).title, 'Entered native mutation');
    await history.close();
  }
});

for (const phase of ['before-dispatch', 'after-dispatch'] as const) {
  test(`${phase} native failure preserves mutation truth and fences only an uncertain source`, async () => {
    const configured = source();
    let nativeTitle = 'Original conversation';
    let mutations = 0;
    const history = createAgentHistory({ source: configured, management: ['rename'], driver: driver({
      lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' }, get: async () => summary(configured, 'conversation-alpha', nativeTitle) },
      rename: { status: 'supported', descriptor: { effects }, apply: async (input, context) => {
        mutations += 1;
        if (mutations === 1) {
          if (phase === 'after-dispatch') { context.markDispatched(); nativeTitle = 'Committed despite response loss'; }
          throw new Error('Sensitive native diagnostic');
        }
        context.markDispatched();
        nativeTitle = input.title;
        return { status: 'applied', ref: input.conversation };
      } },
    }) });
    const rename = supported(history.rename).apply;
    const first = await rename({ conversation: ref(configured), title: 'Requested conversation', acceptEffects: effects });
    assert.equal(first.status, phase === 'before-dispatch' ? 'not_applied' : 'outcome_unknown');
    assert.deepEqual(first.ref, ref(configured));
    assert.equal(first.reason.code, 'native_failure');
    assert.equal(first.reason.message.includes('Sensitive native diagnostic'), false);
    assert.equal((await supported(history.lookup).get({ conversation: ref(configured) })).title,
      phase === 'before-dispatch' ? 'Original conversation' : 'Committed despite response loss');
    const second = await rename({ conversation: ref(configured), title: 'Retried conversation', acceptEffects: effects });
    if (phase === 'before-dispatch') {
      assert.deepEqual(second, { status: 'applied', ref: ref(configured) });
      assert.equal(mutations, 2);
      assert.equal((await supported(history.lookup).get({ conversation: ref(configured) })).title, 'Retried conversation');
    } else {
      assert.equal(second.status, 'not_applied');
      assert.equal(second.reason.code, 'unsupported_scope');
      assert.equal(mutations, 1);
      assert.equal((await supported(history.lookup).get({ conversation: ref(configured) })).title, 'Committed despite response loss');
    }
    await history.close();
  });
}

test('a dispatched mutation timeout holds admission until native settlement and preserves its later effect', { timeout: 3000 }, async (t) => {
  const configured = source();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let nativeTitle = 'Original conversation';
  let mutations = 0;
  const history = createAgentHistory({ source: configured, management: ['rename'], driver: driver({
    lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' }, get: async () => summary(configured, 'conversation-alpha', nativeTitle) },
    rename: { status: 'supported', descriptor: { effects }, apply: async (input, context) => {
      context.markDispatched();
      mutations += 1;
      entered.resolve();
      await release.promise;
      nativeTitle = input.title;
      const receipt = { status: 'applied' as const, ref: input.conversation };
      context.recordReceipt(receipt);
      return receipt;
    } },
  }) });
  t.after(async () => { release.resolve(); await history.close(); });
  const rename = supported(history.rename).apply;
  const timedOut = rename({ conversation: ref(configured), title: 'Committed after timeout', acceptEffects: effects }, { deadlineMs: 15 });
  await entered.promise;
  const outcome = await timedOut;
  assert.equal(outcome.status, 'outcome_unknown');
  assert.deepEqual(outcome.ref, ref(configured));
  assert.equal(outcome.reason.code, 'deadline_exceeded');
  await assert.rejects(supported(history.lookup).get({ conversation: ref(configured) }), code('busy'));
  assert.equal(mutations, 1);
  release.resolve();
  await nextTurn();
  assert.equal((await supported(history.lookup).get({ conversation: ref(configured) })).title, 'Committed after timeout');
  const fenced = await rename({ conversation: ref(configured), title: 'Must not retry', acceptEffects: effects });
  assert.equal(fenced.status, 'not_applied');
  assert.equal(fenced.reason.code, 'unsupported_scope');
  assert.equal(mutations, 1);
});

test('named transcript discovery seals native continuations to the conversation, view kind and operation', async (t) => {
  const configured = source();
  const entered: Array<{ kind: string; cursor?: string }> = [];
  const history = createAgentHistory({ source: configured, driver: driver({
    transcript: { status: 'supported', descriptor: { views: ['main', 'run', 'subagent'], pagination: 'cursor' }, read: async () => page([]) },
    views: { status: 'supported', descriptor: { kinds: ['run', 'subagent'], pagination: 'cursor' }, list: async (input) => {
      entered.push({ kind: input.kind, cursor: input.cursor });
      return input.cursor === undefined
        ? page([{ view: { kind: input.kind, id: 'native-run-one' }, title: 'First stored run' }], 'native-next')
        : page([{ view: { kind: input.kind, id: 'native-run-two' } }]);
    } },
  }) });
  t.after(() => history.close());
  const input = { conversation: ref(configured), kind: 'run' as const, limit: 1 };
  const first = await supported(history.views).list(input);
  assert.deepEqual(first.items, [{ view: { kind: 'run', id: 'native-run-one' }, title: 'First stored run' }]);
  assert.equal(Object.isFrozen(first.items[0].view), true);
  const cursor = continuation(first);
  assert.notEqual(cursor, 'native-next');
  await assert.rejects(supported(history.views).list({ ...input, conversation: ref(configured, 'other'), cursor }), code('invalid_cursor'));
  await assert.rejects(supported(history.views).list({ ...input, kind: 'subagent', cursor }), code('invalid_cursor'));
  await assert.rejects(supported(history.transcript).read({ conversation: input.conversation, view: { kind: 'run', id: 'native-run-one' }, limit: 1, cursor }), code('invalid_cursor'));
  await assert.rejects(supported(history.views).list({ ...input, conversation: ref(source({ sourceId: 'other-store' })) }), code('wrong_source'));
  assert.equal(entered.length, 1);
  assert.deepEqual((await supported(history.views).list({ ...input, cursor })).items, [{ view: { kind: 'run', id: 'native-run-two' } }]);
  assert.deepEqual(entered, [{ kind: 'run', cursor: undefined }, { kind: 'run', cursor: 'native-next' }]);
});

test('named view discovery requires readable kinds and rejects contradictory or oversized native pages', async () => {
  const configured = source();
  const views: AgentHistoryDriver['views'] = { status: 'supported', descriptor: { kinds: ['run'], pagination: 'cursor' }, list: async () => page([]) };
  assert.throws(() => createAgentHistory({ source: configured, driver: driver({ views }) }), code('invalid_input'));
  assert.throws(() => createAgentHistory({ source: configured, driver: driver({ views, transcript: transcript(async () => page([])) }) }), code('invalid_input'));
  const cases: ReadonlyArray<{ items: readonly AgentHistoryViewSummary[]; expected: AgentHistoryErrorCode }> = [
    { items: [{ view: { kind: 'subagent' as const, id: 'wrong-kind' } }], expected: 'native_failure' as const },
    { items: [{ view: { kind: 'run' as const, id: 'same' } }, { view: { kind: 'run' as const, id: 'same' } }], expected: 'native_failure' as const },
    { items: [1, 2, 3].map((id) => ({ view: { kind: 'run' as const, id: String(id) } })), expected: 'limit_exhausted' as const },
  ];
  for (const fixture of cases) {
    const history = createAgentHistory({ source: configured, driver: driver({
      transcript: { status: 'supported', descriptor: { views: ['run'], pagination: 'cursor' }, read: async () => page([]) },
      views: { ...views, list: async () => page(fixture.items) },
    }) });
    try {
      await assert.rejects(supported(history.views).list({ conversation: ref(configured), kind: 'subagent' }), code('unsupported_scope'));
      await assert.rejects(supported(history.views).list({ conversation: ref(configured), kind: 'run', limit: 2 }), code(fixture.expected));
    } finally { await history.close(); }
  }
});

test('named view reads share admission and close waits for their entered native work', async () => {
  const configured = source();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let aborted = false;
  const history = createAgentHistory({ source: configured, limits: { concurrentReads: 1 }, driver: driver({
    catalog: catalog(async () => page([])),
    transcript: { status: 'supported', descriptor: { views: ['run'], pagination: 'cursor' }, read: async () => page([]) },
    views: { status: 'supported', descriptor: { kinds: ['run'], pagination: 'cursor' }, list: async (_input, context) => {
      context.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      entered.resolve();
      await finish.promise;
      return page([{ view: { kind: 'run', id: 'settled-run' } }]);
    } },
  }) });
  const reading = supported(history.views).list({ conversation: ref(configured), kind: 'run' });
  await entered.promise;
  await assert.rejects(supported(history.catalog).list({}), code('busy'));
  const rejectedRead = assert.rejects(reading, code('closed'));
  let closed = false;
  const closing = history.close().then(() => { closed = true; });
  await rejectedRead;
  assert.equal(aborted, true);
  assert.equal(closed, false);
  finish.resolve();
  await closing;
  await assert.rejects(supported(history.views).list({ conversation: ref(configured), kind: 'run' }), code('closed'));
});
