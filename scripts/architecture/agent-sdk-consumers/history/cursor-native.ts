import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import {
  parseAgentHistoryConversationRef,
  type AgentHistory, type AgentHistoryCatalogPage, type AgentHistoryConversationRef,
  type AgentHistoryConversationSummary, type AgentHistoryRecord, type AgentHistoryTranscriptPage,
  type AgentHistoryTranscriptView,
} from '@agen-ai/agent-history';
import { createCursorHistory } from '@agen-ai/agent-history/cursor';
import { proveBrowseExample } from './browse-example.js';
import {
  createCursorFixture, cursorFixtureAgent, cursorFixtureDependencies, cursorFixtureDigests, cursorFixtureRows, type CursorFixture,
} from './cursor-fixture.js';

function ports(history: AgentHistory) {
  const catalog = history.catalog, lookup = history.lookup, transcript = history.transcript, views = history.views;
  if (catalog.status !== 'supported' || lookup.status !== 'supported'
    || transcript.status !== 'supported' || views.status !== 'supported') {
    throw new Error('The exact local Cursor history ports are unavailable');
  }
  return { catalog, lookup, transcript, views };
}

function ref(history: AgentHistory, conversationId: string): AgentHistoryConversationRef {
  return parseAgentHistoryConversationRef({ source: { providerKey: history.source.providerKey,
    sourceId: history.source.sourceId, generation: history.source.generation }, conversationId });
}

async function catalog(history: AgentHistory): Promise<readonly AgentHistoryConversationSummary[]> {
  const port = ports(history).catalog, items: AgentHistoryConversationSummary[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 12; index += 1) {
    const page: AgentHistoryCatalogPage = await port.list({ limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert(page.items.length <= 1);
    assert.equal(page.coverage.view, 'catalog');
    items.push(...page.items);
    if (page.nextCursor === undefined) return items;
    cursor = page.nextCursor;
  }
  throw new Error('Native Cursor catalog did not finish within its fixture bound');
}

async function transcript(history: AgentHistory, conversationId: string, view: AgentHistoryTranscriptView = { kind: 'main' }) {
  const port = ports(history).transcript, items: AgentHistoryRecord[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 20; index += 1) {
    const page: AgentHistoryTranscriptPage = await port.read({ conversation: ref(history, conversationId), view, limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    assert(page.items.length <= 1);
    assert.equal(page.consistency, 'live');
    assert.equal(page.coverage.view, view.kind === 'run' ? 'stored_updates' : 'current_checkpoint');
    assert.equal(page.coverage.children, 'excluded');
    assert(page.coverage.omissions.includes('native_retention'));
    assert(page.coverage.omissions.includes('subagents_excluded'));
    assert(page.coverage.omissions.includes('provider_omission'));
    items.push(...page.items);
    if (page.nextCursor === undefined) return items;
    cursor = page.nextCursor;
  }
  throw new Error('Native Cursor transcript did not finish within its fixture bound');
}

async function runViews(history: AgentHistory, conversationId: string) {
  const port = ports(history).views, items: AgentHistoryTranscriptView[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 12; index += 1) {
    const page = await port.list({ conversation: ref(history, conversationId), kind: 'run', limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    assert(page.items.length <= 1);
    assert(page.coverage.omissions.includes('provider_omission'));
    items.push(...page.items.map((item) => item.view));
    if (page.nextCursor === undefined) return items;
    cursor = page.nextCursor;
  }
  throw new Error('Native Cursor run discovery did not finish within its fixture bound');
}

function texts(records: readonly AgentHistoryRecord[]): readonly string[] {
  return records.flatMap((record) => record.kind === 'message'
    ? record.content.flatMap((content) => content.kind === 'text' ? [content.text] : []) : []);
}

const fixtures: CursorFixture[] = [], histories: AgentHistory[] = [];
try {
  for (const options of [
    { backend: 'jsonl', label: 'STORE-A' }, { backend: 'jsonl', label: 'STORE-B' }, { backend: 'sqlite', label: 'SQLITE' },
  ] as const) fixtures.push(await createCursorFixture(options));
  const bytesBefore = await Promise.all(fixtures.map((fixture) => cursorFixtureDigests(fixture.storeRoot)));
  const rowsBefore = await Promise.all(fixtures.map(cursorFixtureRows));
  for (const fixture of fixtures) histories.push(await createCursorHistory({
    sourceId: `packed-${fixture.label}`, generation: 'fixture-generation',
    store: { kind: fixture.backend, path: fixture.storeRoot },
    scope: { kind: 'project', projectPath: fixture.projectPath, worktrees: 'excluded' },
    resources: { kind: 'linux-prlimit', executable: '/usr/bin/prlimit', temporaryRoot: fixture.temporaryRoot },
  }));
  const results = await Promise.all(histories.map(async (history, index) => {
    const fixture = fixtures[index];
    assert(fixture);
    const { label, ids, runIds } = fixture;
    assert.equal(history.source.kind, 'cursor-local-sdk');
    assert.equal(history.source.resourceOwnership, 'owned');
    if (fixture.backend === 'jsonl') assert.deepEqual(history.source.storageEffects, { kind: 'none' });
    else assert.equal(history.source.storageEffects.kind, 'possible');
    const listed = await catalog(history);
    assert.deepEqual(listed.map((item) => item.title), [`${label} Alpha`, `${label} Beta`, `${label} Empty`]);
    assert.deepEqual(listed.map((item) => item.ref.conversationId), [ids.alpha, ids.beta, ids.empty]);
    assert.equal((await ports(history).lookup.get({ conversation: ref(history, ids.alpha) })).title, `${label} Alpha`);
    const records = await transcript(history, ids.alpha);
    assert.deepEqual(records.map((record) => record.kind), [
      'message', 'message', 'tool_call', 'message', 'message', 'message', 'message', 'message', 'message',
    ]);
    assert.deepEqual(texts(records), [0, 1, 2, 3].flatMap((turn) => [
      `${label} Alpha checkpoint user ${turn}`, `${label} Alpha checkpoint assistant ${turn}`,
    ]));
    assert.deepEqual(records.filter((record) => record.kind === 'message' && record.role === 'user')
      .map((record) => record.native?.itemId), [0, 1, 2, 3].map((turn) => `${ids.alpha}-user-${turn}`));
    assert(records.every((record) => record.native?.turnId === undefined));
    assert(records.filter((record) => record.kind !== 'message' || record.role !== 'user')
      .every((record) => record.native?.itemId === undefined));
    const call = records[2];
    assert(call?.kind === 'tool_call');
    assert.deepEqual({ name: call.name, arguments: call.arguments, callId: call.callId },
      { name: 'read', arguments: { path: '/synthetic/never-opened.txt' }, callId: undefined });
    assert.equal(call.native?.itemId, undefined);
    assert(!texts(records).some((text) => text.includes('ORPHAN HISTORY') || text.includes('checkpoint summary')));
    const views = await runViews(history, ids.alpha);
    assert.deepEqual(views, [runIds.first, runIds.second, runIds.checkpointOnly].map((id) => ({ kind: 'run', id })));
    for (const [run, id] of [runIds.first, runIds.second].entries()) {
      const runRecords = await transcript(history, ids.alpha, { kind: 'run', id });
      assert.deepEqual(texts(runRecords), [`${label} run ${run} user`, `${label} run ${run} assistant`]);
      assert.deepEqual(runRecords.map((record) => record.kind === 'message' ? record.role : record.kind), ['user', 'assistant']);
      assert(runRecords.every((record) => record.native?.turnId === undefined));
      assert(runRecords.every((record) => record.native?.itemId === undefined));
    }
    assert.deepEqual(await transcript(history, ids.alpha, { kind: 'run', id: runIds.checkpointOnly }), []);
    assert.equal((await ports(history).lookup.get({ conversation: ref(history, ids.empty) })).title, `${label} Empty`);
    assert.deepEqual(await transcript(history, ids.empty), []);
    await assert.rejects(ports(history).lookup.get({ conversation: ref(history, ids.missing) }), { code: 'not_found' });
    await assert.rejects(ports(history).transcript.read({ conversation: ref(history, ids.missing) }), { code: 'not_found' });
    await assert.rejects(ports(history).lookup.get({ conversation: ref(history, ids.foreign) }), { code: 'unsupported_scope' });
    assert.equal(history.metadataSearch.status, 'unsupported');
    assert.equal(history.contentSearch.status, 'unsupported');
    assert.equal(history.rename.status, 'unsupported');
    assert.equal(history.archive.status, 'unsupported');
    assert.equal(history.restore.status, 'unsupported');
    assert.equal(history.delete.status, 'unsupported');
    const browseExample = await proveBrowseExample(history, ids.alpha,
      { catalogCount: 3, transcript: { status: 'read', records: 9, view: 'current_checkpoint' } });
    return { backend: fixture.backend, label, catalogCount: listed.length, checkpointRecords: records.length,
      terminalRunViews: views.length, storedRunRecords: 2, checkpointOnlyRunRecords: 0, browseExample };
  }));
  await Promise.all(histories.map((history) => history.close()));
  for (const fixture of fixtures) assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  assert.deepEqual(await Promise.all(fixtures.map(cursorFixtureRows)), rowsBefore);
  for (const [index, fixture] of fixtures.entries()) {
    if (fixture.backend === 'jsonl') assert.deepEqual(await cursorFixtureDigests(fixture.storeRoot), bytesBefore[index]);
  }
  const management = [];
  for (const fixture of [fixtures[0], fixtures[2]]) {
    assert(fixture);
    const managed = await createCursorHistory({ sourceId: `managed-${fixture.label}`, generation: 'one',
      store: { kind: fixture.backend, path: fixture.storeRoot },
      scope: { kind: 'project', projectPath: fixture.projectPath, worktrees: 'excluded' }, management: ['archive', 'restore', 'delete'],
      resources: { kind: 'linux-prlimit', executable: '/usr/bin/prlimit', temporaryRoot: fixture.temporaryRoot } });
    histories.push(managed);
    if (managed.archive.status !== 'supported' || managed.restore.status !== 'supported' || managed.delete.status !== 'supported') {
      throw new Error('Opt-in packed Cursor management is unavailable');
    }
    const beta = ref(managed, fixture.ids.beta), target = ref(managed, fixture.ids.alpha);
    assert.deepEqual(await managed.archive.apply({ conversation: beta, acceptEffects: managed.archive.descriptor.effects }), { status: 'applied', ref: beta });
    const archived = await cursorFixtureAgent(fixture, fixture.ids.beta);
    assert.equal(archived !== null && typeof archived === 'object' && 'status' in archived ? archived.status : undefined, 'archived');
    assert.deepEqual(await managed.restore.apply({ conversation: beta, acceptEffects: managed.restore.descriptor.effects }), { status: 'applied', ref: beta });
    const restored = await cursorFixtureAgent(fixture, fixture.ids.beta);
    assert.equal(restored !== null && typeof restored === 'object' && 'status' in restored ? restored.status : undefined, 'idle');
    const before = await cursorFixtureDependencies(fixture, fixture.ids.alpha, fixture.runIds.first), foreign = await cursorFixtureAgent(fixture, fixture.ids.foreign);
    assert.equal(before.runs.length, 4); assert.equal(before.events.length, 3); assert(before.checkpoints.length > 0);
    assert.deepEqual(await managed.delete.apply({ conversation: target, acceptEffects: managed.delete.descriptor.effects }), { status: 'applied', ref: target });
    assert.equal(await cursorFixtureAgent(fixture, fixture.ids.alpha), null);
    const after = await cursorFixtureDependencies(fixture, fixture.ids.alpha, fixture.runIds.first);
    assert.deepEqual(after, { runs: [], events: [], checkpoints: [] });
    assert.deepEqual(await cursorFixtureAgent(fixture, fixture.ids.foreign), foreign);
    await managed.close(); assert.deepEqual(await readdir(fixture.temporaryRoot), []);
    management.push({ backend: fixture.backend, archived: true, restored: true, deleted: true,
      dependentRuns: after.runs.length, dependentEvents: after.events.length, dependentCheckpoints: after.checkpoints.length, foreignAgentPreserved: true });
  }
  process.stdout.write(`${JSON.stringify({ proof: 'packed-cursor-native-history', evidence: 'native-reader-synthetic-store',
    stores: results, emptyRecords: 0, missing: 'not_found', foreignProject: 'unsupported_scope',
    workerRootsAfterClose: 0, readPhase: { jsonlStoreUnchanged: true, sqliteSemanticRowsUnchanged: true }, management })}\n`);
} finally {
  try { await Promise.all(histories.map((history) => history.close())); }
  finally { await Promise.all(fixtures.map((fixture) => fixture.cleanup())); }
}
