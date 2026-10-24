import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  parseAgentHistoryConversationRef,
  type AgentHistory, type AgentHistoryCatalogPage, type AgentHistoryConversationRef, type AgentHistoryConversationSummary,
  type AgentHistoryRecord, type AgentHistoryTranscriptPage,
} from '@agen-ai/agent-history';
import { createClaudeHistory } from '@agen-ai/agent-history/claude';
import { proveBrowseExample } from './browse-example.js';

const ids = {
  alpha: '20000001-1111-4111-8111-111111111111',
  beta: '20000002-1111-4111-8111-111111111111',
  compact: '20000003-1111-4111-8111-111111111111',
  empty: '20000004-1111-4111-8111-111111111111',
  missing: '20000005-1111-4111-8111-111111111111',
} as const;
const observedAt = '2026-10-21T12:00:00.000Z';
const fixtureRoot = resolve('native-fixtures');
const projectPath = join(fixtureRoot, 'project');

function message(sessionId: string, uuid: string, parentUuid: string | null, role: 'user' | 'assistant', content: unknown) {
  return { type: role, uuid, parentUuid, sessionId, timestamp: observedAt,
    version: '2.1.306', isSidechain: false, entrypoint: 'cli', cwd: projectPath,
    message: { role, content } };
}

async function seedHome(label: string) {
  const configHome = join(fixtureRoot, label, 'config');
  const temporaryRoot = join(fixtureRoot, label, 'workers');
  const folder = join(configHome, 'projects', projectPath.replace(/[^a-zA-Z0-9]/gu, '-'));
  assert(projectPath.length < 200, 'Native fixture project must fit the qualified folder encoding');
  await Promise.all([mkdir(folder, { recursive: true }), mkdir(temporaryRoot, { recursive: true })]);
  // Disposable native-format setup; production reads use only the shipped SDK worker.
  const sessions = [
    { id: ids.alpha, title: `${label} Alpha`, rows: [
      message(ids.alpha, 'alpha-u1', null, 'user', `${label} user first`),
      message(ids.alpha, 'alpha-a1', 'alpha-u1', 'assistant', [
        { type: 'text', text: `${label} assistant before tool` },
        { type: 'tool_use', id: 'toolu_packed_read', name: 'Read', input: { file_path: '/synthetic/input.txt' } },
        { type: 'text', text: `${label} assistant after tool` },
      ]),
      message(ids.alpha, 'alpha-u2', 'alpha-a1', 'user', [
        { type: 'tool_result', tool_use_id: 'toolu_packed_read', content: `${label} tool result` },
        { type: 'text', text: `${label} user after tool` },
      ]),
      message(ids.alpha, 'alpha-a2', 'alpha-u2', 'assistant', [{ type: 'text', text: `${label} assistant final` }]),
    ] },
    { id: ids.beta, title: `${label} Beta`, rows: [message(ids.beta, 'beta-u1', null, 'user', `${label} second conversation`)] },
    { id: ids.compact, title: `${label} Compacted`, rows: [
      message(ids.compact, 'compact-old-u', null, 'user', 'PRECOMPACTION USER OMITTED'),
      message(ids.compact, 'compact-old-a', 'compact-old-u', 'assistant', [{ type: 'text', text: 'PRECOMPACTION ANSWER OMITTED' }]),
      { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary', parentUuid: null,
        sessionId: ids.compact, timestamp: observedAt, compactMetadata: { trigger: 'manual', preTokens: 1000 } },
      message(ids.compact, 'compact-new-u', 'compact-boundary', 'user', `${label} retained user`),
      message(ids.compact, 'compact-new-a', 'compact-new-u', 'assistant', [{ type: 'text', text: `${label} retained assistant` }]),
    ] },
    { id: ids.empty, title: `${label} Empty`, rows: [] },
  ];
  for (const [index, session] of sessions.entries()) {
    const file = join(folder, `${session.id}.jsonl`);
    const rows = [...session.rows, { type: 'custom-title', sessionId: session.id, customTitle: session.title }];
    await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    const mtime = Date.parse(observedAt) / 1000 - index;
    await utimes(file, mtime, mtime);
  }
  return { label, configHome, temporaryRoot };
}

async function snapshot(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(folder: string, prefix: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name), relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(file, `${relative}/`);
      else {
        assert(entry.isFile());
        files.push(`${relative}:${createHash('sha256').update(await readFile(file)).digest('hex')}`);
      }
    }
  }
  await visit(root, '');
  return files.sort();
}

async function catalog(history: AgentHistory): Promise<readonly AgentHistoryConversationSummary[]> {
  const port = history.catalog;
  if (port.status !== 'supported') throw new Error('Native Claude catalog is unavailable');
  const items: AgentHistoryConversationSummary[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 12; index += 1) {
    const page: AgentHistoryCatalogPage = await port.list({ limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert(page.items.length <= 1);
    assert.equal(page.coverage.view, 'catalog');
    items.push(...page.items);
    if (page.nextCursor === undefined) return items;
    cursor = page.nextCursor;
  }
  throw new Error('Native catalog did not terminate within the fixture bound');
}

async function transcript(history: AgentHistory, conversation: AgentHistoryConversationRef) {
  const port = history.transcript;
  if (port.status !== 'supported') throw new Error('Native Claude transcript is unavailable');
  const items: AgentHistoryRecord[] = [], omissions = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < 20; index += 1) {
    const page: AgentHistoryTranscriptPage = await port.read({ conversation, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert(page.items.length <= 1);
    assert.equal(page.coverage.view, 'retained_chain');
    assert.equal(page.coverage.children, 'excluded');
    for (const omission of page.coverage.omissions) omissions.add(omission);
    items.push(...page.items);
    if (page.nextCursor === undefined) return { items, omissions: [...omissions].sort() };
    cursor = page.nextCursor;
  }
  throw new Error('Native transcript did not terminate within the fixture bound');
}

function texts(records: readonly AgentHistoryRecord[]): string[] {
  return records.flatMap((record) => record.kind === 'message'
    ? record.content.flatMap((part) => part.kind === 'text' ? [part.text] : []) : []);
}

await mkdir(projectPath, { recursive: true });
const fixtures = await Promise.all(['HOME-A', 'HOME-B'].map(seedHome));
const before = await Promise.all(fixtures.map((fixture) => snapshot(fixture.configHome)));
const ambientConfig = process.env.CLAUDE_CONFIG_DIR;
const histories: AgentHistory[] = [];
try {
  for (const fixture of fixtures) histories.push(await createClaudeHistory({
    sourceId: `packed-${fixture.label}`, generation: 'fixture-generation', configHome: fixture.configHome,
    scope: { kind: 'project', projectPath, worktrees: 'excluded' }, includeProgrammatic: false,
    resources: { kind: 'linux-prlimit', executable: '/usr/bin/prlimit', temporaryRoot: fixture.temporaryRoot },
  }));
  const results = await Promise.all(histories.map(async (history, index) => {
    const label = fixtures[index]?.label;
    assert(label);
    const listed = await catalog(history);
    assert.deepEqual(listed.map((item) => item.title).sort(), [`${label} Alpha`, `${label} Beta`, `${label} Compacted`, `${label} Empty`].sort());
    const alpha = listed.find((item) => item.ref.conversationId === ids.alpha);
    const compact = listed.find((item) => item.ref.conversationId === ids.compact);
    const empty = listed.find((item) => item.ref.conversationId === ids.empty);
    assert(alpha && compact && empty);
    const lookup = history.lookup;
    if (lookup.status !== 'supported') throw new Error('Native Claude lookup is unavailable');
    assert.equal((await lookup.get({ conversation: alpha.ref })).title, `${label} Alpha`);
    const alphaRead = await transcript(history, alpha.ref);
    assert.deepEqual(alphaRead.items.map((item) => item.kind), ['message', 'message', 'tool_call', 'message', 'tool_result', 'message', 'message']);
    assert.deepEqual(texts(alphaRead.items), [`${label} user first`, `${label} assistant before tool`, `${label} assistant after tool`, `${label} user after tool`, `${label} assistant final`]);
    const call = alphaRead.items.find((item) => item.kind === 'tool_call');
    const result = alphaRead.items.find((item) => item.kind === 'tool_result');
    assert.deepEqual(call && { callId: call.callId, name: call.name, arguments: call.arguments },
      { callId: 'toolu_packed_read', name: 'Read', arguments: { file_path: '/synthetic/input.txt' } });
    assert.deepEqual(result && { callId: result.callId, content: result.content },
      { callId: 'toolu_packed_read', content: [{ kind: 'text', text: `${label} tool result` }] });
    const compactRead = await transcript(history, compact.ref);
    assert.deepEqual(compactRead.items.map((item) => item.kind), ['notice', 'message', 'message']);
    assert.deepEqual(texts(compactRead.items), [`${label} retained user`, `${label} retained assistant`]);
    assert.deepEqual(compactRead.items[0] && { kind: compactRead.items[0].kind,
      ...('code' in compactRead.items[0] ? { code: compactRead.items[0].code } : {}) },
    { kind: 'notice', code: 'claude.system_record' });
    assert.deepEqual(compactRead.omissions, ['native_retention', 'subagents_excluded', 'unsupported_record_kind']);
    const emptyRead = await transcript(history, empty.ref);
    assert.deepEqual(emptyRead.items, []);
    const missing = parseAgentHistoryConversationRef({ source: {
      providerKey: history.source.providerKey, sourceId: history.source.sourceId, generation: history.source.generation,
    }, conversationId: ids.missing });
    await assert.rejects(lookup.get({ conversation: missing }), { code: 'not_found' });
    const read = history.transcript;
    if (read.status !== 'supported') throw new Error('Native Claude transcript is unavailable');
    await assert.rejects(read.read({ conversation: missing, limit: 1 }), { code: 'not_found' });
    const browseExample = await proveBrowseExample(history, ids.alpha,
      { catalogCount: 4, transcript: { status: 'read', records: 7, view: 'retained_chain' } });
    return { label, catalogCount: listed.length, alphaRecords: alphaRead.items.length, compactRecords: compactRead.items.length, browseExample };
  }));
  await Promise.all(histories.map((history) => history.close()));
  for (const fixture of fixtures) assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  assert.deepEqual(await Promise.all(fixtures.map((fixture) => snapshot(fixture.configHome))), before);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, ambientConfig);
  const managedFixture = fixtures[0];
  assert(managedFixture);
  const managed = await createClaudeHistory({ sourceId: 'packed-management', generation: 'one', configHome: managedFixture.configHome,
    scope: { kind: 'project', projectPath, worktrees: 'excluded' }, management: ['rename', 'delete'],
    resources: { kind: 'linux-prlimit', executable: '/usr/bin/prlimit', temporaryRoot: managedFixture.temporaryRoot } });
  histories.push(managed);
  if (managed.rename.status !== 'supported' || managed.delete.status !== 'supported') throw new Error('Opt-in packed Claude management is unavailable');
  const target = parseAgentHistoryConversationRef({ source: { providerKey: managed.source.providerKey,
    sourceId: managed.source.sourceId, generation: managed.source.generation }, conversationId: ids.beta });
  const folder = join(managedFixture.configHome, 'projects', projectPath.replace(/[^a-zA-Z0-9]/gu, '-'));
  const selectedFile = join(folder, `${ids.beta}.jsonl`), readerFile = join(folder, `${ids.alpha}.jsonl`), readerBefore = await readFile(readerFile, 'utf8');
  const foreignPath = join(fixtureRoot, 'foreign-project'), foreignFolder = join(managedFixture.configHome, 'projects', foreignPath.replace(/[^a-zA-Z0-9]/gu, '-'));
  await mkdir(foreignFolder, { recursive: true });
  const foreignFile = join(foreignFolder, `${ids.beta}.jsonl`), foreignBytes = `${JSON.stringify({ ...message(ids.beta, 'foreign-u1', null, 'user', 'Foreign native duplicate ID'), cwd: foreignPath })}\n`;
  await writeFile(foreignFile, foreignBytes, { flag: 'wx' });
  assert.deepEqual(await managed.rename.apply({ conversation: target, title: 'Packed renamed Beta', acceptEffects: managed.rename.descriptor.effects }), { status: 'applied', ref: target });
  const lines: unknown[] = (await readFile(selectedFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.filter((line) => line !== null && typeof line === 'object' && 'customTitle' in line && line.customTitle === 'Packed renamed Beta').length, 1);
  const subagents = join(folder, ids.beta, 'subagents');
  await mkdir(subagents, { recursive: true }); await writeFile(join(subagents, 'agent-child.jsonl'), '{"isSidechain":true}\n');
  assert.deepEqual(await managed.delete.apply({ conversation: target, acceptEffects: managed.delete.descriptor.effects }), { status: 'applied', ref: target });
  await assert.rejects(stat(selectedFile), { code: 'ENOENT' }); await assert.rejects(stat(subagents), { code: 'ENOENT' });
  assert.equal(await readFile(foreignFile, 'utf8'), foreignBytes); assert.equal(await readFile(readerFile, 'utf8'), readerBefore);
  await managed.close(); assert.deepEqual(await readdir(managedFixture.temporaryRoot), []);
  process.stdout.write(`${JSON.stringify({ proof: 'packed-claude-history', evidence: 'native-reader-synthetic-store',
    homes: results, missing: 'not_found', emptyRecords: 0, workerRootsAfterClose: 0, readerStoreUnchanged: true,
    management: { renamedTitle: 'Packed renamed Beta', deleteStatus: 'applied', subagentsRemoved: true,
      foreignProjectPreserved: true, readerAlphaPreserved: true } })}\n`);
} finally { await Promise.all(histories.map((history) => history.close())); }
