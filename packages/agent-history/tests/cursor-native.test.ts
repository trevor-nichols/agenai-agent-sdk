import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';
import { parseAgentProviderConversationId } from '@agen-ai/agent-protocol';
import { createCursorHistory } from '../dist/cursor.js';
import type { AgentHistory, AgentHistoryCatalogPage, AgentHistoryConversationRef, AgentHistoryPage,
  AgentHistoryRecord, AgentHistoryTranscriptPage, AgentHistoryTranscriptView } from '../src/index.js';
import { createCursorFixture, cursorFixtureDigests, cursorFixtureRows, writeCursorOversizedCatalog,
  type CursorFixture } from './helpers/cursor-fixture.js';

const nativeOptions = { timeout: 60000,
  skip: process.platform === 'linux' && process.arch === 'x64' ? false : 'Cursor native fixtures require the qualified Linux x64 prlimit and Node SQLite tuple.' };

function options(fixture: CursorFixture) {
  return { sourceId: basename(fixture.root), generation: 'fixture-generation',
    store: { kind: fixture.backend, path: fixture.storeRoot },
    scope: { kind: 'project' as const, projectPath: fixture.projectPath, worktrees: 'excluded' as const },
    resources: { kind: 'linux-prlimit' as const, executable: '/usr/bin/prlimit', temporaryRoot: fixture.temporaryRoot } };
}
function ref(history: AgentHistory, id: string): AgentHistoryConversationRef {
  return { source: { providerKey: history.source.providerKey, sourceId: history.source.sourceId, generation: history.source.generation },
    conversationId: parseAgentProviderConversationId(id) };
}
function catalog(history: AgentHistory) {
  if (history.catalog.status !== 'supported') assert.fail('Cursor SDK local catalog must be supported.');
  return history.catalog.list;
}
function lookup(history: AgentHistory) {
  if (history.lookup.status !== 'supported') assert.fail('Cursor SDK local lookup must be supported.');
  return history.lookup.get;
}
function transcript(history: AgentHistory) {
  if (history.transcript.status !== 'supported') assert.fail('Cursor SDK local transcript must be supported.');
  return history.transcript.read;
}
function views(history: AgentHistory) {
  if (history.views.status !== 'supported') assert.fail('Cursor terminal stored-event run discovery must be supported.');
  return history.views.list;
}
function code(expected: string) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}

async function catalogIds(history: AgentHistory): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 12; count += 1) {
    const page: AgentHistoryCatalogPage = await catalog(history)({ limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    ids.push(...page.items.map((item) => item.ref.conversationId));
    if (page.nextCursor === undefined) return ids;
    cursor = page.nextCursor;
  }
  assert.fail('The finite Cursor native fixture catalog must finish within twelve public pages.');
}

async function readAll(history: AgentHistory, id: string, view: AgentHistoryTranscriptView = { kind: 'main' }) {
  const records: AgentHistoryRecord[] = [], pages: AgentHistoryTranscriptPage[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 20; count += 1) {
    const page: AgentHistoryTranscriptPage = await transcript(history)({ conversation: ref(history, id), view, limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    records.push(...page.items); pages.push(page);
    if (page.nextCursor === undefined) return { records, pages };
    cursor = page.nextCursor;
  }
  assert.fail('The finite Cursor native fixture transcript must finish within twenty public pages.');
}

async function runIds(history: AgentHistory, id: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 12; count += 1) {
    const page: AgentHistoryPage<{ view: AgentHistoryTranscriptView }> = await views(history)({ conversation: ref(history, id),
      kind: 'run', limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    assert.equal(page.coverage.omissions.includes('provider_omission'), true);
    for (const item of page.items) {
      if (item.view.kind !== 'run') assert.fail('Run discovery must retain the native run view kind.');
      ids.push(item.view.id);
    }
    if (page.nextCursor === undefined) return ids;
    cursor = page.nextCursor;
  }
  assert.fail('The finite Cursor native fixture run views must finish within twelve public pages.');
}

for (const backend of ['jsonl', 'sqlite'] as const) {
  test(`Cursor ${backend} native stores preserve checkpoint content, project scope and distinct terminal run views`, nativeOptions, async (t) => {
    const fixture = await createCursorFixture({ backend });
    t.after(() => fixture.cleanup());
    const beforeRows = await cursorFixtureRows(fixture), beforeFiles = await cursorFixtureDigests(fixture.storeRoot);
    const history = await createCursorHistory(options(fixture));
    t.after(() => history.close());
    assert.deepEqual(await catalogIds(history), [fixture.ids.alpha, fixture.ids.beta, fixture.ids.empty]);
    const summary = await lookup(history)({ conversation: ref(history, fixture.ids.alpha) });
    assert.equal(summary.title, 'STORE-A Alpha');
    assert.equal(summary.projectPath, fixture.projectPath);
    assert.equal(summary.archiveState, 'not_archived');
    await assert.rejects(catalog(history)({ projectPath: fixture.otherProjectPath }), code('unsupported_scope'));
    await assert.rejects(lookup(history)({ conversation: ref(history, fixture.ids.foreign) }), code('unsupported_scope'));
    await assert.rejects(transcript(history)({ conversation: ref(history, fixture.ids.foreign), limit: 1 }), code('unsupported_scope'));

    const main = await readAll(history, fixture.ids.alpha);
    assert.deepEqual(main.records.map((record) => record.kind), ['message', 'message', 'tool_call', 'message', 'message', 'message', 'message', 'message', 'message']);
    assert.deepEqual(main.records.map((record) => record.kind === 'message' ? { role: record.role, content: record.content }
      : record.kind === 'tool_call' ? { name: record.name, arguments: record.arguments } : record), [
      { role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha checkpoint user 0' }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A Alpha checkpoint assistant 0' }] },
      { name: 'read', arguments: { path: '/synthetic/never-opened.txt' } },
      { role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha checkpoint user 1' }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A Alpha checkpoint assistant 1' }] },
      { role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha checkpoint user 2' }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A Alpha checkpoint assistant 2' }] },
      { role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha checkpoint user 3' }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A Alpha checkpoint assistant 3' }] },
    ]);
    assert.deepEqual(main.records.filter((record) => record.kind === 'message' && record.role === 'user').map((record) => record.native),
      [0, 1, 2, 3].map((index) => ({ itemId: `${fixture.ids.alpha}-user-${index}` })));
    assert.deepEqual(main.records.filter((record) => record.kind !== 'message' || record.role !== 'user').map((record) => record.native),
      [undefined, undefined, undefined, undefined, undefined]);
    assert.deepEqual(main.records.map((record) => record.timestamp), Array.from({ length: 9 }, () => undefined));
    const tool = main.records.find((record) => record.kind === 'tool_call');
    if (tool?.kind !== 'tool_call') assert.fail('The native checkpoint includes one read tool call.');
    assert.equal(tool.callId, undefined);
    assert.equal(JSON.stringify(main.records).includes('ORPHAN HISTORY'), false);
    assert.equal(main.pages.every((page) => page.consistency === 'live' && page.coverage.view === 'current_checkpoint'), true);
    assert.deepEqual(main.pages[0].coverage, { view: 'current_checkpoint', children: 'excluded',
      omissions: ['native_retention', 'subagents_excluded', 'provider_omission'] });
    assert.deepEqual(await runIds(history, fixture.ids.alpha), [fixture.runIds.first, fixture.runIds.second, fixture.runIds.checkpointOnly]);
    const firstRun = await readAll(history, fixture.ids.alpha, { kind: 'run', id: fixture.runIds.first });
    assert.deepEqual(firstRun.records.map((record) => record.kind === 'message' ? { role: record.role, content: record.content } : record), [
      { role: 'user', content: [{ kind: 'text', text: 'STORE-A run 0 user' }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A run 0 assistant' }] },
    ]);
    assert.deepEqual(firstRun.records.map((record) => record.native), [undefined, undefined]);
    assert.deepEqual(firstRun.records.map((record) => record.timestamp), [undefined, undefined]);
    assert.equal(firstRun.pages.every((page) => page.coverage.view === 'stored_updates' && page.coverage.omissions.includes('provider_omission')), true);
    assert.deepEqual((await readAll(history, fixture.ids.alpha, { kind: 'run', id: fixture.runIds.checkpointOnly })).records, []);
    await assert.rejects(transcript(history)({ conversation: ref(history, fixture.ids.alpha), view: { kind: 'run', id: fixture.runIds.running } }), code('unsupported_scope'));
    for (const id of [fixture.runIds.foreign, fixture.runIds.missing]) {
      await assert.rejects(transcript(history)({ conversation: ref(history, fixture.ids.alpha), view: { kind: 'run', id } }), code('not_found'));
    }
    assert.equal((await lookup(history)({ conversation: ref(history, fixture.ids.empty) })).title, 'STORE-A Empty');
    assert.deepEqual((await readAll(history, fixture.ids.empty)).records, []);
    await assert.rejects(lookup(history)({ conversation: ref(history, fixture.ids.missing) }), code('not_found'));
    await assert.rejects(transcript(history)({ conversation: ref(history, fixture.ids.missing) }), code('not_found'));
    await history.close();
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
    assert.deepEqual(await cursorFixtureRows(fixture), beforeRows);
    if (backend === 'jsonl') assert.deepEqual(await cursorFixtureDigests(fixture.storeRoot), beforeFiles);
  });
}

test('Cursor simultaneous JSONL and SQLite sources keep native store and project configuration independent', nativeOptions, async (t) => {
  const firstFixture = await createCursorFixture({ backend: 'jsonl', label: 'STORE-A' });
  const secondFixture = await createCursorFixture({ backend: 'sqlite', label: 'STORE-B' });
  t.after(async () => { await firstFixture.cleanup(); await secondFixture.cleanup(); });
  const [first, second] = await Promise.all([createCursorHistory(options(firstFixture)), createCursorHistory(options(secondFixture))]);
  const sources = [{ history: first, fixture: firstFixture }, { history: second, fixture: secondFixture }];
  t.after(async () => { await Promise.all(sources.map(({ history }) => history.close())); });
  const summaries = await Promise.all(sources.map(({ history, fixture }) => lookup(history)({ conversation: ref(history, fixture.ids.alpha) })));
  assert.deepEqual(summaries.map((summary) => summary.title), ['STORE-A Alpha', 'STORE-B Alpha']);
  const pages = await Promise.all(sources.map(({ history, fixture }) => transcript(history)({ conversation: ref(history, fixture.ids.alpha), limit: 1 })));
  assert.deepEqual(pages.map((page) => page.items[0]?.kind === 'message' ? page.items[0].content : page.items),
    [[{ kind: 'text', text: 'STORE-A Alpha checkpoint user 0' }], [{ kind: 'text', text: 'STORE-B Alpha checkpoint user 0' }]]);
});

test('Cursor continuation rejects a replaced native checkpoint instead of treating SDK offset UUIDs as stable message identities', nativeOptions, async (t) => {
  for (const backend of ['jsonl', 'sqlite'] as const) {
    const fixture = await createCursorFixture({ backend });
    t.after(() => fixture.cleanup());
    const history = await createCursorHistory(options(fixture));
    t.after(() => history.close());
    const first = await transcript(history)({ conversation: ref(history, fixture.ids.alpha), limit: 1 });
    assert.deepEqual(first.items.map((record) => record.kind === 'message' ? record.content : record), [[{ kind: 'text', text: 'STORE-A Alpha checkpoint user 0' }]]);
    if (first.nextCursor === undefined) assert.fail('The checkpoint fixture has more than one normalized record.');
    await fixture.replaceCheckpoint(fixture.ids.alpha, { label: 'REPLACED' });
    await assert.rejects(transcript(history)({ conversation: ref(history, fixture.ids.alpha), limit: 1, cursor: first.nextCursor }), code('invalid_cursor'));
    const current = await transcript(history)({ conversation: ref(history, fixture.ids.alpha), limit: 1 });
    assert.deepEqual(current.items.map((record) => record.kind === 'message' ? record.content : record), [[{ kind: 'text', text: 'REPLACED checkpoint user 0' }]]);
    assert.deepEqual(current.items[0]?.native, { itemId: `${fixture.ids.alpha}-user-0` });
  }
});

test('Cursor empty JSONL roots remain empty during native catalog and missing lookup reads', nativeOptions, async (t) => {
  const fixture = await createCursorFixture({ backend: 'jsonl', seed: false });
  t.after(() => fixture.cleanup());
  assert.deepEqual(await cursorFixtureDigests(fixture.storeRoot), []);
  const history = await createCursorHistory(options(fixture));
  t.after(() => history.close());
  assert.deepEqual((await catalog(history)({ limit: 1 })).items, []);
  await assert.rejects(lookup(history)({ conversation: ref(history, fixture.ids.missing) }), code('not_found'));
  await history.close();
  assert.deepEqual(await cursorFixtureDigests(fixture.storeRoot), []);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Cursor preserves native checkpoint omission while rejecting malformed metadata and oversized normalized content', nativeOptions, async (t) => {
  const fixture = await createCursorFixture({ backend: 'jsonl' });
  t.after(() => fixture.cleanup());
  const history = await createCursorHistory(options(fixture));
  t.after(() => history.close());
  await fixture.replaceCheckpoint(fixture.ids.alpha, { malformed: true });
  const omitted = await transcript(history)({ conversation: ref(history, fixture.ids.alpha), limit: 1 });
  assert.deepEqual(omitted.items, []);
  assert.equal(omitted.coverage.omissions.includes('provider_omission'), true);
  assert.equal((await lookup(history)({ conversation: ref(history, fixture.ids.alpha) })).title, 'STORE-A Alpha');
  await fixture.replaceCheckpoint(fixture.ids.alpha, { assistantBytes: 300000 });
  const first = await transcript(history)({ conversation: ref(history, fixture.ids.alpha), limit: 1 });
  assert.deepEqual(first.items.map((record) => record.kind === 'message' ? record.content : record), [[{ kind: 'text', text: 'STORE-A changed checkpoint user 0' }]]);
  if (first.nextCursor === undefined) assert.fail('The fitting user message must retain continuation to oversized assistant content.');
  await assert.rejects(transcript(history)({ conversation: ref(history, fixture.ids.alpha), limit: 1, cursor: first.nextCursor }), code('limit_exhausted'));
  await fixture.replaceAgentName(fixture.ids.alpha, { invalid: 'native metadata' });
  await assert.rejects(lookup(history)({ conversation: ref(history, fixture.ids.alpha) }), code('native_failure'));
  assert.equal((await lookup(history)({ conversation: ref(history, fixture.ids.beta) })).title, 'STORE-A Beta');
});

test('Cursor bounds oversized native JSONL work, reaps the failed worker and accepts restored valid native input', nativeOptions, async (t) => {
  const fixture = await createCursorFixture({ backend: 'jsonl' });
  t.after(() => fixture.cleanup());
  const agentsPath = join(fixture.storeRoot, 'agents.ndjson'), original = await readFile(agentsPath);
  const paddingBytes = 268 * 1024 * 1024;
  await writeCursorOversizedCatalog(fixture.storeRoot, fixture.projectPath, paddingBytes);
  assert.equal((await stat(agentsPath)).size > paddingBytes, true);
  const history = await createCursorHistory(options(fixture));
  t.after(() => history.close());
  const scratchBefore = (await readdir(fixture.temporaryRoot, { recursive: true })).sort();
  await assert.rejects(catalog(history)({ limit: 1 }), code('native_failure'));
  assert.deepEqual((await readdir(fixture.temporaryRoot, { recursive: true })).sort(), scratchBefore);
  await writeFile(agentsPath, original);
  assert.equal((await lookup(history)({ conversation: ref(history, fixture.ids.beta) })).title, 'STORE-A Beta');
  await history.close();
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

async function childPids(): Promise<number[]> {
  return (await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).split(/\s+/u).filter(Boolean).map(Number);
}

async function enteredWorker(previous: ReadonlySet<number>): Promise<number> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    for (const pid of await childPids()) {
      if (previous.has(pid)) continue;
      let command: string;
      try { command = await readFile(`/proc/${pid}/cmdline`, 'utf8'); }
      catch (error) { if (code('ENOENT')(error)) continue; throw error; }
      const args = command.split('\0');
      if (args[0] === process.execPath && args.includes('--jitless') && args.includes('--max-old-space-size=128')) return pid;
    }
  }
  assert.fail('The actual Cursor resource worker must enter before cancellation.');
}

test('Cursor cancellation and close join entered native workers and empty their process groups', nativeOptions, async (t) => {
  const fixture = await createCursorFixture({ backend: 'sqlite' });
  t.after(() => fixture.cleanup());
  for (const interruption of ['cancel', 'close'] as const) {
    const history = await createCursorHistory(options(fixture));
    t.after(() => history.close());
    const controller = new AbortController(), previous = new Set(await childPids());
    const reading = transcript(history)({ conversation: ref(history, fixture.ids.alpha), limit: 1 }, { signal: controller.signal })
      .then((value) => ({ kind: 'value' as const, value }), (error: unknown) => ({ kind: 'error' as const, error }));
    const pid = await enteredWorker(previous);
    process.kill(pid, 0); process.kill(-pid, 0);
    const limits = await readFile(`/proc/${pid}/limits`, 'utf8');
    assert.match(limits, /Max address space\s+4294967296\s+4294967296/u);
    assert.match(limits, /Max cpu time\s+12\s+12/u);
    let closing: Promise<void> | undefined;
    if (interruption === 'cancel') controller.abort(); else closing = history.close();
    const result = await reading;
    if (result.kind !== 'error') assert.fail('An interrupted Cursor worker must reject its entered public read.');
    assert.equal(code(interruption === 'cancel' ? 'cancelled' : 'closed')(result.error), true);
    await (closing ?? history.close());
    assert.throws(() => process.kill(pid, 0), code('ESRCH'));
    assert.throws(() => process.kill(-pid, 0), code('ESRCH'));
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});
