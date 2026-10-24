import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import {
  parseAgentHistoryConversationRef,
  type AgentHistory, type AgentHistoryCatalogPage, type AgentHistoryConversationRef,
  type AgentHistoryConversationSummary, type AgentHistoryRecord, type AgentHistoryTranscriptPage,
} from '@agen-ai/agent-history';
import { createCodexHistoryProcess } from '@agen-ai/agent-history/codex';
import { proveBrowseExample } from './browse-example.js';
import {
  CODEX_FIXTURE_PROVENANCE, CODEX_LINUX_X64_SHA256, CODEX_NATIVE_VERSION,
  codexFileSha256, createCodexFixture, resolveCodexFixtureExecutable, seedCodexRollouts,
} from './codex-fixture.js';
import { inspectCodexFixture, prepareCodexIndexedFixture, prepareCodexMetadataFixture } from './codex-fixture-server.js';

const executable = await resolveCodexFixtureExecutable();
assert.equal(await codexFileSha256(executable), CODEX_LINUX_X64_SHA256);
const fixture = await createCodexFixture();
const histories: AgentHistory[] = [];
const options = {
  sourceId: 'packed-native-codex', generation: 'fixture-generation', executable, configHome: fixture.configHome,
  scope: { kind: 'all_projects' as const },
  resources: { kind: 'linux-prlimit-bubblewrap' as const, resourceLauncher: '/usr/bin/prlimit',
    sandboxLauncher: '/usr/bin/bwrap', temporaryRoot: fixture.temporaryRoot },
};

function ports(history: AgentHistory) {
  const catalog = history.catalog, lookup = history.lookup, transcript = history.transcript;
  if (catalog.status !== 'supported' || lookup.status !== 'supported' || transcript.status !== 'supported') {
    throw new Error('The exact native Codex history ports are unavailable');
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
    const page: AgentHistoryCatalogPage = await port.list({ limit: 2, order: 'created_asc',
      ...(cursor === undefined ? {} : { cursor }) });
    assert(page.items.length <= 2);
    assert.equal(page.consistency, 'live');
    assert.equal(page.coverage.view, 'catalog');
    assert(page.coverage.omissions.includes('provider_omission'));
    items.push(...page.items);
    if (page.nextCursor === undefined) return items;
    cursor = page.nextCursor;
  }
  throw new Error('Native Codex catalog did not finish within its fixture bound');
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
    items.push(...page.items);
    if (page.nextCursor === undefined) return items;
    cursor = page.nextCursor;
  }
  throw new Error('Native Codex transcript did not finish within its fixture bound');
}

function text(records: readonly AgentHistoryRecord[]): string[] {
  return records.flatMap((record) => record.kind === 'message'
    ? record.content.flatMap((content) => content.kind === 'text' ? [content.text] : []) : []);
}

try {
  const strict = await createCodexHistoryProcess({ ...options, catalogPolicy: 'state_db_only' });
  histories.push(strict);
  assert.deepEqual(await catalog(strict), []);
  const rollouts = await seedCodexRollouts(fixture, { childInOtherProject: true });
  const legacyHashes = await Promise.all(rollouts.map((rollout) => codexFileSha256(rollout.path)));
  assert.deepEqual(await catalog(strict), []);
  const normal = await createCodexHistoryProcess({ ...options, catalogPolicy: 'scan_and_repair' });
  histories.push(normal);
  const cold = await ports(normal).catalog.list({ limit: 2, order: 'created_asc' });
  assert.deepEqual(cold.items.map((item) => item.ref.conversationId), [fixture.ids.cli]);
  assert.equal(cold.nextCursor, undefined);
  assert(cold.coverage.omissions.includes('provider_omission'));
  assert.deepEqual((await catalog(strict)).map((item) => item.ref.conversationId), [fixture.ids.cli]);
  // Fixture-only metadata repair establishes the separate legacy catalog paging case.
  // Production preserves the native cold-prefix result and never performs this warm-up.
  await prepareCodexMetadataFixture(fixture, executable);
  const listed = await catalog(normal);
  assert.deepEqual(listed.map((item) => item.title), [
    'History Alpha CLI', 'History Beta VSCode', 'History Gamma Exec', 'History Delta AppServer', 'History Epsilon Child',
  ]);
  assert.deepEqual((await catalog(strict)).map((item) => item.ref.conversationId), listed.map((item) => item.ref.conversationId));
  assert.equal(normal.source.storageEffects.kind, 'possible');
  const child = listed.find((item) => item.ref.conversationId === fixture.ids.child);
  assert.equal(child?.parent?.conversationId, fixture.ids.cli);
  assert.equal((await ports(normal).lookup.get({ conversation: ref(normal, fixture.ids.cli) })).title, 'History Alpha CLI');
  if (normal.metadataSearch.status !== 'supported') throw new Error('Native Codex title search is unavailable');
  const found = await normal.metadataSearch.search({ query: 'Alpha', limit: 1 });
  assert.deepEqual(found.items.map((hit) => hit.conversation.ref.conversationId), [fixture.ids.cli]);
  assert.deepEqual((await normal.metadataSearch.search({ query: 'alpha', limit: 1 })).items, []);
  assert.deepEqual((await normal.metadataSearch.search({ query: 'body-token-OnlyInContent', limit: 1 })).items, []);
  const legacy = await transcript(normal, fixture.ids.cli);
  const expectedTexts = ['History Alpha CLI', 'Fixture cli assistant turn 1 body-token-OnlyInContent',
    'Fixture cli user turn 2', 'Fixture cli assistant turn 2 body-token-OnlyInContent',
    'Fixture cli user turn 3', 'Fixture cli assistant turn 3 body-token-OnlyInContent'];
  assert.deepEqual(text(legacy), expectedTexts);
  assert.deepEqual(legacy.map((record) => record.native?.itemId), ['item-1', 'item-2', 'item-3', 'item-4', 'item-5', 'item-6']);
  assert(legacy.every((record) => record.native?.turnId !== undefined));
  const variants = await transcript(normal, fixture.ids.vscode);
  assert.deepEqual(variants.map((record) => record.kind), ['message', 'message', 'message', 'message', 'tool_result', 'compaction']);
  const image = variants.flatMap((record) => record.kind === 'message' ? record.content : []).find((content) => content.kind === 'attachment');
  assert.deepEqual(image, { kind: 'attachment', attachmentKind: 'image', reference: { kind: 'uri', uri: 'https://fixture.invalid/image.png' } });
  const toolResult = variants.find((record) => record.kind === 'tool_result');
  assert.deepEqual(toolResult && { itemId: toolResult.native?.itemId, content: toolResult.content },
    { itemId: 'fixture-tool', content: [{ kind: 'text', text: 'Synthetic stored tool output' }] });
  assert.deepEqual(await transcript(normal, fixture.ids.empty), []);
  await assert.rejects(ports(normal).lookup.get({ conversation: ref(normal, fixture.ids.missing) }), { code: 'not_found' });
  const browseExample = await proveBrowseExample(normal, fixture.ids.cli,
    { catalogCount: 5, transcript: { status: 'read', records: 6, view: 'retained_chain' } });
  await Promise.all(histories.map((history) => history.close()));
  assert.deepEqual(await Promise.all(rollouts.map((rollout) => codexFileSha256(rollout.path))), legacyHashes);
  await prepareCodexIndexedFixture(fixture, executable);
  const firstRollout = rollouts[0];
  assert(firstRollout);
  assert.notEqual(await codexFileSha256(firstRollout.path), legacyHashes[0]);
  const indexed = await createCodexHistoryProcess({ ...options, generation: 'indexed-fixture-generation', catalogPolicy: 'state_db_only' });
  histories.push(indexed);
  const indexedRecords = await transcript(indexed, fixture.ids.cli);
  assert.deepEqual(text(indexedRecords), expectedTexts);
  assert.deepEqual(indexedRecords.map((record) => record.native?.itemId), ['item-1', 'item-2', 'item-3', 'item-4', 'item-5', 'item-6']);
  assert(indexedRecords.every((record) => record.native?.turnId !== undefined));
  const managed = await createCodexHistoryProcess({ ...options, catalogPolicy: 'state_db_only',
    scope: { kind: 'project', projectPath: fixture.projectPath, worktrees: 'excluded' },
    management: ['rename', 'archive', 'restore', 'delete'] });
  histories.push(managed);
  const { rename, archive, restore, delete: remove } = managed;
  if (rename.status !== 'supported' || archive.status !== 'supported' || restore.status !== 'supported' || remove.status !== 'supported') {
    throw new Error('Explicit Codex management selection is unavailable');
  }
  const target = ref(managed, fixture.ids.cli);
  await assert.rejects(ports(managed).lookup.get({ conversation: ref(managed, fixture.ids.child) }), { code: 'unsupported_scope' });
  const renamed = await rename.apply({ conversation: target, title: 'Packed explicitly renamed title', acceptEffects: rename.descriptor.effects });
  assert.equal(renamed.status, 'applied');
  await inspectCodexFixture(fixture, executable, async (request) => {
    const value = await request('thread/read', { threadId: fixture.ids.cli, includeTurns: false });
    assert(value && typeof value === 'object' && 'thread' in value && value.thread && typeof value.thread === 'object');
    assert.equal('name' in value.thread ? value.thread.name : undefined, 'Packed explicitly renamed title');
  });
  const archivedIds = () => inspectCodexFixture(fixture, executable, async (request) => {
    const result = await request('thread/list', { limit: 100, archived: true, modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent'], useStateDbOnly: true });
    assert(result && typeof result === 'object' && 'data' in result && Array.isArray(result.data));
    return result.data.map((row: unknown) => { assert(row && typeof row === 'object' && 'id' in row && typeof row.id === 'string'); return row.id; }).sort();
  });
  const archived = await archive.apply({ conversation: target, acceptEffects: archive.descriptor.effects });
  assert.equal(archived.status, 'applied');
  assert.deepEqual(await archivedIds(), [fixture.ids.cli, fixture.ids.child].sort());
  const restored = await restore.apply({ conversation: target, acceptEffects: restore.descriptor.effects });
  assert.equal(restored.status, 'applied');
  assert.deepEqual(await archivedIds(), [fixture.ids.child]);
  const deleted = await remove.apply({ conversation: target, acceptEffects: remove.descriptor.effects });
  assert.equal(deleted.status, 'applied');
  await inspectCodexFixture(fixture, executable, async (request) => {
    for (const threadId of [fixture.ids.cli, fixture.ids.child]) {
      await assert.rejects(request('thread/read', { threadId, includeTurns: false }), { code: -32600 });
    }
    const survivor = await request('thread/read', { threadId: fixture.ids.vscode, includeTurns: false });
    assert(survivor && typeof survivor === 'object' && 'thread' in survivor && survivor.thread && typeof survivor.thread === 'object');
    assert.equal('id' in survivor.thread ? survivor.thread.id : undefined, fixture.ids.vscode);
  });
  await Promise.all(histories.map((history) => history.close()));
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  process.stdout.write(`${JSON.stringify({ proof: 'packed-codex-native-history', evidence: 'native-reader-synthetic-store',
    version: CODEX_NATIVE_VERSION, executableSha256: CODEX_LINUX_X64_SHA256, fixtureProvenance: CODEX_FIXTURE_PROVENANCE,
    coldCatalogCount: cold.items.length, coldCatalogContinuation: false,
    metadataSetup: 'explicit-fixture-only-native-metadata-repair',
    catalogCount: listed.length, strictBeforeRepair: 0, strictAfterRepair: listed.length,
    legacyRecords: legacy.length, indexedRecords: indexedRecords.length, variantRecords: variants.length,
    emptyRecords: 0, missing: 'not_found', workerRootsAfterClose: 0, legacyReadRolloutsUnchanged: true,
    titleSearchMatches: found.items.length, rename: renamed.status, archive: archived.status, restore: restored.status, delete: deleted.status,
    archiveCascade: true, restoreParentOnly: true, deleteCascade: true,
    indexedSetup: 'explicit-fixture-only-native-migration', browseExample })}\n`);
} finally {
  await Promise.all(histories.map((history) => history.close()));
  await fixture.cleanup();
}
