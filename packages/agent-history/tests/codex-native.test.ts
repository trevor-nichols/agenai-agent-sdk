import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';
import { parseAgentProviderConversationId } from '@agen-ai/agent-protocol';
import { createCodexHistoryProcess } from '../dist/codex.js';
import type { AgentHistory, AgentHistoryConversationRef, AgentHistoryRecord, AgentHistorySearchPage, AgentHistoryTranscriptPage } from '../src/index.js';
import {
  CODEX_LINUX_X64_SHA256, codexFileSha256, createCodexFixture, resolveCodexFixtureExecutable,
  seedCodexRollouts, type CodexNativeFixture,
} from './helpers/codex-fixture.js';
import { inspectCodexFixture, prepareCodexIndexedFixture, prepareCodexMetadataFixture } from './helpers/codex-fixture-server.js';

const nativeOptions = { timeout: 30000,
  skip: process.platform === 'linux' && process.arch === 'x64' ? false : 'Codex native fixtures require the qualified Linux x86_64 prlimit/Bubblewrap tuple.' };

async function options(fixture: CodexNativeFixture) {
  return { sourceId: basename(fixture.root), generation: 'fixture-generation',
    executable: await resolveCodexFixtureExecutable(), configHome: fixture.configHome,
    scope: { kind: 'all_projects' as const }, catalogPolicy: 'scan_and_repair' as const,
    resources: { kind: 'linux-prlimit-bubblewrap' as const, resourceLauncher: '/usr/bin/prlimit',
      sandboxLauncher: '/usr/bin/bwrap', temporaryRoot: fixture.temporaryRoot } };
}

function ref(history: AgentHistory, id: string): AgentHistoryConversationRef {
  return { source: { providerKey: history.source.providerKey, sourceId: history.source.sourceId, generation: history.source.generation },
    conversationId: parseAgentProviderConversationId(id) };
}
function catalog(history: AgentHistory) {
  if (history.catalog.status !== 'supported') assert.fail('Codex native catalog must be supported.');
  return history.catalog.list;
}
function lookup(history: AgentHistory) {
  if (history.lookup.status !== 'supported') assert.fail('Codex native lookup must be supported.');
  return history.lookup.get;
}
function transcript(history: AgentHistory) {
  if (history.transcript.status !== 'supported') assert.fail('Codex native main transcript must be supported.');
  return history.transcript.read;
}
function code(expected: string | number) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}

test('Codex native title search preserves case-sensitive literal semantics and never searches saved message bodies', nativeOptions, async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => fixture.cleanup());
  const config = await options(fixture);
  await seedCodexRollouts(fixture);
  await prepareCodexMetadataFixture(fixture, config.executable);
  const history = await createCodexHistoryProcess(config);
  t.after(() => history.close());
  if (history.metadataSearch.status !== 'supported') assert.fail('Native title search must be available.');
  const search = history.metadataSearch.search;
  assert.deepEqual((await search({ query: 'Alpha', limit: 1 })).items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.cli]);
  assert.deepEqual((await search({ query: 'alpha', limit: 1 })).items, []);
  assert.deepEqual((await search({ query: '%', limit: 1 })).items, []);
  assert.deepEqual((await search({ query: 'body-token-OnlyInContent', limit: 1 })).items, []);
  const found: string[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
    const page: AgentHistorySearchPage = await search({ query: 'History', limit: 1, order: 'created_asc', ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.items.map((hit) => hit.conversation.ref.conversationId));
    assert.equal(page.coverage.omissions.includes('provider_omission'), true);
    if (page.nextCursor === undefined) break;
    await assert.rejects(search({ query: 'Changed', limit: 1, order: 'created_asc', cursor: page.nextCursor }), code('invalid_cursor'));
    cursor = page.nextCursor;
  }
  assert.deepEqual(found, [fixture.ids.cli, fixture.ids.vscode, fixture.ids.exec, fixture.ids.appServer, fixture.ids.child]);
});

test('Codex native management confirms rename and cross-project archive/delete cascades while restore affects only the parent', nativeOptions, async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => fixture.cleanup());
  const config = await options(fixture);
  await seedCodexRollouts(fixture, { childInOtherProject: true });
  await prepareCodexMetadataFixture(fixture, config.executable);
  const history = await createCodexHistoryProcess({ ...config, management: ['rename', 'archive', 'restore', 'delete'],
    scope: { kind: 'project', projectPath: fixture.projectPath, worktrees: 'excluded' } });
  t.after(() => history.close());
  const { rename, archive, restore, delete: remove } = history;
  if (rename.status !== 'supported' || archive.status !== 'supported' || restore.status !== 'supported' || remove.status !== 'supported') assert.fail('Explicit management selection must be available.');
  const target = ref(history, fixture.ids.cli);
  await assert.rejects(lookup(history)({ conversation: ref(history, fixture.ids.child) }), code('unsupported_scope'));
  const archivedIds = () => inspectCodexFixture(fixture, config.executable, async (request) => {
    const value = await request('thread/list', { limit: 100, archived: true, modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent'], useStateDbOnly: true });
    assert(value && typeof value === 'object' && 'data' in value && Array.isArray(value.data));
    return value.data.map((row: unknown) => { assert(row && typeof row === 'object' && 'id' in row && typeof row.id === 'string'); return row.id; }).sort();
  });
  assert.equal((await rename.apply({ conversation: target, title: 'Native explicitly renamed title', acceptEffects: rename.descriptor.effects })).status, 'applied');
  await inspectCodexFixture(fixture, config.executable, async (request) => {
    const value = await request('thread/read', { threadId: fixture.ids.cli, includeTurns: false });
    assert(value && typeof value === 'object' && 'thread' in value && value.thread && typeof value.thread === 'object');
    assert.equal('name' in value.thread ? value.thread.name : undefined, 'Native explicitly renamed title');
  });
  assert.deepEqual(archive.descriptor.effects, { scope: 'local', descendants: 'descendants', active: 'requires_quiescent', atomicity: 'unknown' });
  assert.equal((await archive.apply({ conversation: target, acceptEffects: { ...archive.descriptor.effects, descendants: 'none' } })).status, 'not_applied');
  assert.deepEqual(await archivedIds(), []);
  assert.equal((await archive.apply({ conversation: target, acceptEffects: archive.descriptor.effects })).status, 'applied');
  assert.deepEqual(await archivedIds(), [fixture.ids.cli, fixture.ids.child].sort());
  assert.equal((await restore.apply({ conversation: target, acceptEffects: restore.descriptor.effects })).status, 'applied');
  assert.deepEqual(await archivedIds(), [fixture.ids.child]);
  assert.equal((await remove.apply({ conversation: target, acceptEffects: remove.descriptor.effects })).status, 'applied');
  await inspectCodexFixture(fixture, config.executable, async (request) => {
    for (const threadId of [fixture.ids.cli, fixture.ids.child]) await assert.rejects(request('thread/read', { threadId, includeTurns: false }), code(-32600), `Deleted native thread ${threadId} must be absent.`);
    const survivor = await request('thread/read', { threadId: fixture.ids.vscode, includeTurns: false });
    assert(survivor && typeof survivor === 'object' && 'thread' in survivor && survivor.thread && typeof survivor.thread === 'object');
    assert.equal('id' in survivor.thread ? survivor.thread.id : undefined, fixture.ids.vscode);
  });
  const repeated = await remove.apply({ conversation: target, acceptEffects: remove.descriptor.effects });
  assert.equal(repeated.status, 'not_applied');
  if (repeated.status === 'not_applied') assert.equal(repeated.reason.code, 'not_found');
  await history.close();
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

async function catalogIds(history: AgentHistory): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 12; count += 1) {
    const page = await catalog(history)({ limit: 2, order: 'created_asc', ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...page.items.map((item) => item.ref.conversationId));
    if (page.nextCursor === undefined) return ids;
    cursor = page.nextCursor;
  }
  assert.fail('The finite Codex fixture catalog must complete within twelve public pages.');
}

async function readAll(history: AgentHistory, id: string): Promise<{ records: AgentHistoryRecord[]; pages: AgentHistoryTranscriptPage[] }> {
  const records: AgentHistoryRecord[] = [], pages: AgentHistoryTranscriptPage[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 20; count += 1) {
    const page = await transcript(history)({ conversation: ref(history, id), limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    assert.equal(page.coverage.view, 'retained_chain');
    assert.equal(page.coverage.children, 'excluded');
    records.push(...page.items); pages.push(page);
    if (page.nextCursor === undefined) return { records, pages };
    cursor = page.nextCursor;
  }
  assert.fail('The finite Codex native transcript must complete within twenty public pages.');
}

function cliContent(records: readonly AgentHistoryRecord[]) {
  return records.map((record) => record.kind === 'message' ? record.content : record);
}
const expectedCli = [
  [{ kind: 'text', text: 'History Alpha CLI' }], [{ kind: 'text', text: 'Fixture cli assistant turn 1 body-token-OnlyInContent' }],
  [{ kind: 'text', text: 'Fixture cli user turn 2' }], [{ kind: 'text', text: 'Fixture cli assistant turn 2 body-token-OnlyInContent' }],
  [{ kind: 'text', text: 'Fixture cli user turn 3' }], [{ kind: 'text', text: 'Fixture cli assistant turn 3 body-token-OnlyInContent' }],
];

test('Codex metadata-indexed legacy fixtures preserve ordered pages and explicit source/project selection', nativeOptions, async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => fixture.cleanup());
  const config = await options(fixture);
  assert.equal(await codexFileSha256(config.executable), CODEX_LINUX_X64_SHA256);
  const history = await createCodexHistoryProcess(config);
  t.after(() => history.close());
  assert.deepEqual((await catalog(history)({ limit: 1 })).items, []);
  const rollouts = await seedCodexRollouts(fixture);
  const before = await Promise.all(rollouts.map((rollout) => codexFileSha256(rollout.path)));
  await prepareCodexMetadataFixture(fixture, config.executable);
  assert.deepEqual(await catalogIds(history), [fixture.ids.cli, fixture.ids.vscode, fixture.ids.exec, fixture.ids.appServer, fixture.ids.child]);
  assert.deepEqual((await catalog(history)({ limit: 2, sourceKinds: ['exec'] })).items.map((item) => item.ref.conversationId), [fixture.ids.exec]);
  assert.deepEqual((await catalog(history)({ limit: 2, projectPath: fixture.otherProjectPath })).items.map((item) => item.ref.conversationId), [fixture.ids.exec]);
  const catalogChild = await catalog(history)({ limit: 1, sourceKinds: ['subAgentThreadSpawn'] });
  assert.equal(catalogChild.items[0].ref.conversationId, fixture.ids.child);
  assert.deepEqual(catalogChild.items[0].parent, ref(history, fixture.ids.cli));
  const cli = await readAll(history, fixture.ids.cli);
  assert.deepEqual(cliContent(cli.records), expectedCli);
  assert.deepEqual(cli.records.map((record) => record.native), [
    { turnId: 'rollout-2', itemId: 'item-1' }, { turnId: 'rollout-2', itemId: 'item-2' },
    { turnId: 'rollout-5', itemId: 'item-3' }, { turnId: 'rollout-5', itemId: 'item-4' },
    { turnId: 'rollout-8', itemId: 'item-5' }, { turnId: 'rollout-8', itemId: 'item-6' },
  ]);
  const child = await lookup(history)({ conversation: ref(history, fixture.ids.child) });
  assert.deepEqual(child.parent, ref(history, fixture.ids.cli));
  const project = await createCodexHistoryProcess({ ...config,
    scope: { kind: 'project', projectPath: fixture.projectPath, worktrees: 'excluded' } });
  t.after(() => project.close());
  assert.deepEqual(await catalogIds(project), [fixture.ids.cli, fixture.ids.vscode, fixture.ids.appServer, fixture.ids.child]);
  await assert.rejects(lookup(project)({ conversation: ref(project, fixture.ids.exec) }), code('unsupported_scope'));
  await assert.rejects(transcript(project)({ conversation: ref(project, fixture.ids.exec), limit: 1 }), code('unsupported_scope'));
  assert.deepEqual(await Promise.all(rollouts.map((rollout) => codexFileSha256(rollout.path))), before);
  await Promise.all([history.close(), project.close()]);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Codex pre-indexed native item traversal preserves mixed stored content and compaction coverage', nativeOptions, async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => fixture.cleanup());
  const config = await options(fixture), rollouts = await seedCodexRollouts(fixture);
  const before = await codexFileSha256(rollouts[0].path);
  await prepareCodexIndexedFixture(fixture, config.executable);
  assert.notEqual(await codexFileSha256(rollouts[0].path), before);
  const history = await createCodexHistoryProcess(config);
  t.after(() => history.close());
  assert.deepEqual(cliContent((await readAll(history, fixture.ids.cli)).records), expectedCli);
  const mixed = await readAll(history, fixture.ids.vscode);
  assert.deepEqual(mixed.records.map((record) => record.kind), ['message', 'message', 'message', 'message', 'tool_result', 'compaction']);
  assert.deepEqual(mixed.records[0].kind === 'message' ? mixed.records[0].content : mixed.records[0], [
    { kind: 'text', text: 'History Beta VSCode' },
    { kind: 'attachment', attachmentKind: 'image', reference: { kind: 'uri', uri: 'https://fixture.invalid/image.png' } },
  ]);
  assert.deepEqual(mixed.records[4], { kind: 'tool_result', outcome: 'unknown', content: [{ kind: 'text', text: 'Synthetic stored tool output' }],
    native: { turnId: 'fixture-vscode-turn-2', itemId: 'fixture-tool' }, timestamp: '1970-01-01T00:00:00.001Z' });
  assert.equal(mixed.pages.some((page) => page.coverage.omissions.includes('compacted')), true);
  assert.equal(mixed.pages.every((page) => page.coverage.omissions.includes('native_retention') && page.coverage.omissions.includes('subagents_excluded')), true);
  await history.close();
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Codex native readable empty rollout differs from missing history and is absent from discovery', nativeOptions, async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => fixture.cleanup());
  await seedCodexRollouts(fixture);
  const history = await createCodexHistoryProcess(await options(fixture));
  t.after(() => history.close());
  assert.equal((await lookup(history)({ conversation: ref(history, fixture.ids.empty) })).ref.conversationId, fixture.ids.empty);
  const empty = await transcript(history)({ conversation: ref(history, fixture.ids.empty), limit: 1 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, undefined);
  assert.equal((await catalogIds(history)).includes(fixture.ids.empty), false);
  await assert.rejects(lookup(history)({ conversation: ref(history, fixture.ids.missing) }), code('not_found'));
  await assert.rejects(transcript(history)({ conversation: ref(history, fixture.ids.missing), limit: 1 }), code('not_found'));
  assert.equal((await lookup(history)({ conversation: ref(history, fixture.ids.cli) })).title, 'History Alpha CLI');
});

test('Codex owned framing rejects an oversized native legacy turn and preserves later saved-history reads', nativeOptions, async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => fixture.cleanup());
  await seedCodexRollouts(fixture, { oversizedAssistantBytes: 3 * 1024 * 1024 });
  const history = await createCodexHistoryProcess(await options(fixture));
  t.after(() => history.close());
  await assert.rejects(transcript(history)({ conversation: ref(history, fixture.ids.cli), limit: 1 }), code('limit_exhausted'));
  assert.equal((await lookup(history)({ conversation: ref(history, fixture.ids.vscode) })).title, 'History Beta VSCode');
  await history.close();
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

async function indexedThreadCount(fixture: CodexNativeFixture): Promise<number> {
  const files = (await readdir(fixture.configHome)).filter((file) => /^state_\d+\.sqlite$/u.test(file));
  assert.equal(files.length, 1);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(fixture.configHome, files[0]), { readOnly: true, timeout: 1000 });
  try {
    const row = database.prepare('SELECT count(*) AS count FROM threads').get();
    assert.equal(typeof row?.count, 'number');
    return Number(row?.count);
  } finally { database.close(); }
}

test('Codex cold catalog exposes native prefix repair and DB-only discovery leaves unindexed rollouts omitted', nativeOptions, async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => fixture.cleanup());
  const config = await options(fixture);
  const strict = await createCodexHistoryProcess({ ...config, catalogPolicy: 'state_db_only' });
  t.after(() => strict.close());
  assert.deepEqual((await catalog(strict)({ limit: 2 })).items, []);
  await seedCodexRollouts(fixture);
  assert.equal(await indexedThreadCount(fixture), 0);
  assert.deepEqual((await catalog(strict)({ limit: 2 })).items, []);
  assert.equal(await indexedThreadCount(fixture), 0);
  const repairing = await createCodexHistoryProcess(config);
  t.after(() => repairing.close());
  const cold = await catalog(repairing)({ limit: 1, order: 'created_asc' });
  assert.deepEqual(cold.items.map((item) => item.ref.conversationId), [fixture.ids.cli]);
  assert.equal(cold.nextCursor, undefined);
  assert.deepEqual(cold.coverage, { view: 'catalog', children: 'unknown', omissions: ['provider_omission'] });
  assert.equal(await indexedThreadCount(fixture), 1);
  assert.deepEqual((await catalog(strict)({ limit: 2 })).items.map((item) => item.ref.conversationId), [fixture.ids.cli]);
  assert.equal(await indexedThreadCount(fixture), 1);
  assert.equal(strict.source.storageEffects.kind, 'possible');
  assert.equal(strict.source.storageEffects.kind === 'possible' && strict.source.storageEffects.effects.includes('initializes_store'), true);
  assert.equal(strict.source.storageEffects.kind === 'possible' && strict.source.storageEffects.effects.includes('updates_index'), false);
  assert.equal(repairing.source.storageEffects.kind === 'possible' && repairing.source.storageEffects.effects.includes('updates_index'), true);
  await Promise.all([strict.close(), repairing.close()]);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

async function enteredWorker(previous: ReadonlySet<number>): Promise<number> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const pids = (await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).split(/\s+/u).filter(Boolean).map(Number);
    for (const pid of pids) {
      if (previous.has(pid)) continue;
      let command: string;
      try { command = await readFile(`/proc/${pid}/cmdline`, 'utf8'); }
      catch (error) { if (code('ENOENT')(error)) continue; throw error; }
      if (command.split('\0').includes('app-server')) return pid;
    }
  }
  assert.fail('The actual Codex app-server worker must enter its owned group before interruption.');
}

test('Codex cancellation and close reap the entered owned app-server process group', nativeOptions, async (t) => {
  const fixture = await createCodexFixture();
  t.after(() => fixture.cleanup());
  await seedCodexRollouts(fixture);
  const config = await options(fixture);
  for (const interruption of ['cancel', 'close'] as const) {
    const history = await createCodexHistoryProcess(config);
    t.after(() => history.close());
    const controller = new AbortController();
    const previous = new Set((await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).split(/\s+/u).filter(Boolean).map(Number));
    const reading = transcript(history)({ conversation: ref(history, fixture.ids.cli), limit: 1 }, { signal: controller.signal })
      .then((value) => ({ kind: 'value' as const, value }), (error: unknown) => ({ kind: 'error' as const, error }));
    const pid = await enteredWorker(previous);
    process.kill(pid, 0); process.kill(-pid, 0);
    let closing: Promise<void> | undefined;
    if (interruption === 'cancel') controller.abort();
    else closing = history.close();
    const result = await reading;
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') assert.fail('Interruption must reject the entered native read.');
    assert.equal(code(interruption === 'cancel' ? 'cancelled' : 'closed')(result.error), true);
    await (closing ?? history.close());
    assert.throws(() => process.kill(pid, 0), code('ESRCH'));
    assert.throws(() => process.kill(-pid, 0), code('ESRCH'));
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});
