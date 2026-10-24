import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';
import { createGrokHistory, createGrokHistoryProcess, grokHistoryExtensions, type GrokHistoryConnection } from '../dist/grok.js';
import { parseAgentHistoryConversationRef } from '../dist/index.js';
import type { AgentHistory, AgentHistoryCatalogPage, AgentHistoryRecord, AgentHistoryTranscriptPage } from '../src/index.js';
import { createGrokFixture, grokFixtureDigests, GROK_FIXTURE_IMAGE_BASE64, openGrokFixtureConnection, poisonGrokFixtureConfiguration,
  type GrokFixture, type GrokFixtureConnection } from './helpers/grok-fixture.js';

const nativeOptions = { timeout: 60_000,
  skip: process.platform === 'linux' && process.arch === 'x64' ? false : 'Grok native fixtures require qualified Linux x64 prlimit and Bubblewrap.' };
function common(fixture: GrokFixture) {
  return { sourceId: basename(fixture.root), generation: 'fixture-generation',
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
    assert.fail('The exact qualified local Grok catalog, metadata and stored-update reads must be available.');
  }
  return { catalog: history.catalog.list, lookup: history.lookup.get, transcript: history.transcript.read };
}
function code(expected: string | number) {
  return (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === expected;
}
async function catalogIds(history: AgentHistory): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 12; count += 1) {
    const page: AgentHistoryCatalogPage = await ports(history).catalog({ limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    ids.push(...page.items.map((item) => item.ref.conversationId));
    if (page.nextCursor === undefined) return ids;
    cursor = page.nextCursor;
  }
  assert.fail('The finite native Grok catalog must finish within twelve public pages.');
}
async function readAll(history: AgentHistory, id: string): Promise<AgentHistoryRecord[]> {
  const records: AgentHistoryRecord[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 20; count += 1) {
    const page: AgentHistoryTranscriptPage = await ports(history).transcript({ conversation: ref(history, id), limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    assert.equal(page.consistency, 'live');
    assert.deepEqual(page.coverage, { view: 'stored_updates', children: 'excluded',
      omissions: ['native_retention', 'subagents_excluded', 'provider_omission'] });
    records.push(...page.items);
    if (page.nextCursor === undefined) return records;
    cursor = page.nextCursor;
  }
  assert.fail('The finite native Grok transcript must finish within twenty public pages.');
}
function messages(records: readonly AgentHistoryRecord[]) {
  return records.map((record) => record.kind === 'message' ? { role: record.role, content: record.content } : record);
}

test('Grok native scoped catalog and surviving update pages preserve chunks, rewind, timestamps and actual event identities', nativeOptions, async (t) => {
  const fixture = await createGrokFixture();
  t.after(() => fixture.cleanup());
  const before = await grokFixtureDigests(fixture.nativeHome);
  const history = await createGrokHistoryProcess(processOptions(fixture));
  t.after(() => history.close());
  assert.deepEqual(await catalogIds(history), [fixture.ids.empty, fixture.ids.beta, fixture.ids.alpha]);
  const summary = await ports(history).lookup({ conversation: ref(history, fixture.ids.alpha) });
  assert.equal(summary.title, 'STORE-A Alpha');
  assert.equal(summary.projectPath, fixture.projectPath);
  assert.equal(summary.archiveState, 'unknown');
  const child = await ports(history).lookup({ conversation: ref(history, fixture.ids.child) });
  assert.deepEqual(child.parent, ref(history, fixture.ids.alpha));
  const alpha = await readAll(history, fixture.ids.alpha);
  assert.deepEqual(messages(alpha), [
    { role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha message 0' }] },
    { role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha adjacent chunk' }] },
    { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A Alpha message 1' }] },
    { role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha message 2' }] },
    { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A Alpha message 3' }] },
    { role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha message 4' }] },
    { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A Alpha message 5' }] },
  ]);
  assert.deepEqual(alpha.map((record) => record.native), [{ itemId: `${fixture.ids.alpha}-1` }, ...Array.from({ length: 6 }, () => undefined)]);
  assert.deepEqual(alpha.map((record) => record.timestamp === undefined ? undefined : new Date(record.timestamp).toISOString()),
    ['2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:01.000Z',
      '2026-10-21T00:00:02.000Z', '2026-10-21T00:00:03.000Z', '2026-10-21T00:00:04.000Z', '2026-10-21T00:00:05.000Z']);
  assert.deepEqual(messages(await readAll(history, fixture.ids.beta)), [
    { role: 'user', content: [{ kind: 'text', text: 'STORE-A Beta message 0' }] },
    { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A Beta message 1' }] },
    { role: 'user', content: [{ kind: 'text', text: 'STORE-A Beta replacement' }] },
    { role: 'assistant', content: [{ kind: 'text', text: 'STORE-A Beta replacement answer' }] },
  ]);
  assert.equal((await ports(history).lookup({ conversation: ref(history, fixture.ids.empty) })).title, 'STORE-A Empty');
  assert.deepEqual(await readAll(history, fixture.ids.empty), []);
  await assert.rejects(ports(history).lookup({ conversation: ref(history, fixture.ids.missing) }), code('not_found'));
  await assert.rejects(ports(history).transcript({ conversation: ref(history, fixture.ids.missing) }), code('not_found'));
  await assert.rejects(ports(history).lookup({ conversation: ref(history, fixture.ids.foreign) }), code('unsupported_scope'));
  await assert.rejects(ports(history).transcript({ conversation: ref(history, fixture.ids.foreign) }), code('unsupported_scope'));
  await assert.rejects(ports(history).catalog({ projectPath: fixture.otherProjectPath }), code('unsupported_scope'));
  await assert.rejects(ports(history).catalog({ archived: 'only' }), code('unsupported_scope'));
  await history.close();
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  assert.deepEqual(await grokFixtureDigests(fixture.nativeHome), before);
});

test('Grok history uses registered real ACP update methods and leaves a borrowed initialized native process alive after close', nativeOptions, async (t) => {
  const fixture = await createGrokFixture();
  t.after(() => fixture.cleanup());
  const native = await openGrokFixtureConnection(fixture, grokHistoryExtensions());
  t.after(() => native.close());
  await assert.rejects(native.request('_x.ai/session/load_history', { sessionId: fixture.ids.alpha, cwd: fixture.projectPath }), code(-32601));
  const history = createGrokHistory({ ...common(fixture), connection: connection(native) });
  t.after(() => history.close());
  assert.equal((await readAll(history, fixture.ids.alpha)).length, 7);
  await history.close();
  process.kill(native.pid, 0);
  const state = await native.request('_x.ai/session/state', { sessionId: fixture.ids.alpha, cwd: fixture.projectPath });
  const summary = state !== null && typeof state === 'object' && !Array.isArray(state) ? state.summary : undefined;
  assert.equal(summary !== null && typeof summary === 'object' && !Array.isArray(summary) ? summary.session_summary : undefined, 'STORE-A Alpha');
  assert.deepEqual(native.methods.filter((method) => !['initialize', 'session/list', '_x.ai/session/state',
    '_x.ai/session/updates', '_x.ai/session/load_history'].includes(method)), []);
  assert.equal(native.methods.filter((method) => method === '_x.ai/session/load_history').length, 1);
  await native.close();
  assert.throws(() => process.kill(native.pid, 0), code('ESRCH'));
  assert.throws(() => process.kill(-native.pid, 0), code('ESRCH'));
});

test('Grok owned sources keep equal native session IDs in distinct homes and project roots independent', nativeOptions, async (t) => {
  const first = await createGrokFixture({ label: 'STORE-A' });
  t.after(() => first.cleanup());
  const second = await createGrokFixture({ label: 'STORE-B' });
  t.after(() => second.cleanup());
  const [historyA, historyB] = await Promise.all([createGrokHistoryProcess(processOptions(first)), createGrokHistoryProcess(processOptions(second))]);
  t.after(async () => { await Promise.all([historyA.close(), historyB.close()]); });
  const sources = [{ history: historyA, fixture: first }, { history: historyB, fixture: second }];
  const summaries = await Promise.all(sources.map(({ history, fixture }) => ports(history).lookup({ conversation: ref(history, fixture.ids.alpha) })));
  assert.deepEqual(summaries.map((summary) => summary.title), ['STORE-A Alpha', 'STORE-B Alpha']);
  const pages = await Promise.all(sources.map(({ history, fixture }) => ports(history).transcript({ conversation: ref(history, fixture.ids.alpha), limit: 1 })));
  assert.deepEqual(pages.map((page) => messages(page.items)), [
    [{ role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha message 0' }] }],
    [{ role: 'user', content: [{ kind: 'text', text: 'STORE-B Alpha message 0' }] }],
  ]);
});

test('Grok owned reads survive poisoned recognized home and project configuration while preserving original source bytes', nativeOptions, async (t) => {
  const fixture = await createGrokFixture();
  t.after(() => fixture.cleanup());
  const control = await poisonGrokFixtureConfiguration(fixture);
  const catalog = control.mcpCatalog;
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) assert.fail('The native MCP catalog is an object.');
  const result = catalog.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) assert.fail('The native MCP catalog has a result object.');
  const servers = result.servers;
  if (!Array.isArray(servers)) assert.fail('The native MCP catalog lists configured servers.');
  assert.deepEqual(new Set(servers), new Set([
    { name: 'history-canary', source: 'local', type: 'stdio', command: '/usr/bin/touch', args: [control.marker] },
    { name: 'project-history-canary', source: 'local', type: 'stdio', command: '/usr/bin/touch', args: [control.marker] },
  ]));
  const homeBefore = await grokFixtureDigests(fixture.nativeHome), projectBefore = await grokFixtureDigests(fixture.projectPath);
  const history = await createGrokHistoryProcess(processOptions(fixture));
  t.after(() => history.close());
  assert.equal((await ports(history).lookup({ conversation: ref(history, fixture.ids.alpha) })).title, 'STORE-A Alpha');
  const page = await ports(history).transcript({ conversation: ref(history, fixture.ids.alpha), limit: 1 });
  assert.deepEqual(messages(page.items), [{ role: 'user', content: [{ kind: 'text', text: 'STORE-A Alpha message 0' }] }]);
  await history.close();
  await assert.rejects(stat(control.marker), code('ENOENT'));
  assert.deepEqual(await grokFixtureDigests(fixture.nativeHome), homeBefore);
  assert.deepEqual(await grokFixtureDigests(fixture.projectPath), projectBefore);
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Grok native response and normalized-record limits reject oversized stored updates and permit later healthy reads', nativeOptions, async (t) => {
  for (const bytes of [300_000, 1_114_112]) {
    const fixture = await createGrokFixture({ oversizedBytes: bytes });
    t.after(() => fixture.cleanup());
    const history = await createGrokHistoryProcess(processOptions(fixture));
    t.after(() => history.close());
    const scratchBefore = (await readdir(fixture.temporaryRoot, { recursive: true })).sort();
    await assert.rejects(ports(history).transcript({ conversation: ref(history, fixture.ids.oversized), limit: 1 }), code('limit_exhausted'));
    assert.deepEqual((await readdir(fixture.temporaryRoot, { recursive: true })).sort(), scratchBefore);
    assert.equal((await ports(history).lookup({ conversation: ref(history, fixture.ids.beta) })).title, 'STORE-A Beta');
    await history.close();
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});

test('Grok preserves native-imported tool and image envelopes as inert records with explicit unsupported-content omissions', nativeOptions, async (t) => {
  const fixture = await createGrokFixture({ mixed: true });
  t.after(() => fixture.cleanup());
  const history = await createGrokHistoryProcess(processOptions(fixture));
  t.after(() => history.close());
  const records: AgentHistoryRecord[] = [];
  const omissions = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < 12; index += 1) {
    const page: AgentHistoryTranscriptPage = await ports(history).transcript({ conversation: ref(history, fixture.ids.mixed), limit: 1,
      ...(cursor === undefined ? {} : { cursor }) });
    records.push(...page.items); page.coverage.omissions.forEach((omission) => omissions.add(omission));
    cursor = page.nextCursor;
    if (cursor === undefined) break;
  }
  assert.equal(cursor, undefined);
  assert.deepEqual(records.map((record) => record.kind), ['message', 'message', 'tool_call', 'tool_result', 'message', 'notice', 'notice']);
  const [picture, thought, call, result, oversizedPicture, unknown, longTitle] = records;
  assert.deepEqual(picture?.kind === 'message' ? picture.content : picture, [{ kind: 'attachment', attachmentKind: 'image',
    reference: { kind: 'uri', uri: `data:image/png;base64,${GROK_FIXTURE_IMAGE_BASE64}` }, mediaType: 'image/png' }]);
  assert.deepEqual(thought?.kind === 'message' ? thought.content : thought, [{ kind: 'thinking', text: 'Synthetic retained thought' }]);
  if (call?.kind !== 'tool_call' || result?.kind !== 'tool_result') assert.fail('Imported native tool updates must retain call/result records.');
  assert.equal(call.name, 'Stored tool display title');
  assert.equal(call.callId, 'stored-tool-call-1');
  assert.deepEqual(call.arguments, { path: '/synthetic/never-executed.txt' });
  assert.equal(result.callId, 'stored-tool-call-1');
  assert.equal(result.outcome, 'succeeded');
  assert.deepEqual(result.content, [{ kind: 'text', text: 'Synthetic retained tool output' }]);
  if (oversizedPicture?.kind !== 'message' || oversizedPicture.content[0]?.kind !== 'omission') assert.fail('An unrepresentable inline image must remain an explicit omission.');
  assert.equal(oversizedPicture.content[0].reason, 'unsupported_content');
  assert.equal(unknown?.kind === 'notice' ? unknown.code : undefined, 'grok.unsupported_record_kind');
  assert.equal(longTitle?.kind === 'notice' ? longTitle.code : undefined, 'grok.unsupported_record_kind');
  assert.equal(omissions.has('unsupported_content'), true);
  assert.equal(omissions.has('unsupported_record_kind'), true);
});

test('Grok refuses a replaced native sessions directory instead of changing the selected source under an existing handle', nativeOptions, async (t) => {
  const fixture = await createGrokFixture();
  t.after(() => fixture.cleanup());
  const history = await createGrokHistoryProcess(processOptions(fixture));
  t.after(() => history.close());
  const sessions = join(fixture.nativeHome, 'sessions');
  await rename(sessions, join(fixture.root, 'original-sessions'));
  await mkdir(sessions, { mode: 0o700 });
  const scratchBefore = (await readdir(fixture.temporaryRoot, { recursive: true })).sort();
  await assert.rejects(ports(history).lookup({ conversation: ref(history, fixture.ids.alpha) }), code('unsupported_scope'));
  assert.deepEqual((await readdir(fixture.temporaryRoot, { recursive: true })).sort(), scratchBefore);
  assert.deepEqual(await readdir(sessions), []);
  await history.close();
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

async function childPids(): Promise<number[]> {
  return (await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).split(/\s+/u).filter(Boolean).map(Number);
}
async function enteredProcess(previous: ReadonlySet<number>): Promise<number> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    for (const pid of await childPids()) {
      if (previous.has(pid)) continue;
      let command: string;
      try { command = await readFile(`/proc/${pid}/cmdline`, 'utf8'); }
      catch (error) { if (code('ENOENT')(error)) continue; throw error; }
      const args = command.split('\0');
      if (args[0] === '/usr/bin/bwrap' && args.includes('--unshare-net') && args.includes('agent') && args.includes('stdio')) return pid;
    }
  }
  assert.fail('The actual resource-bounded Grok process must enter before cancellation.');
}

test('Grok cancellation and close reap resource-limited native process groups even when startup is stopped', nativeOptions, async (t) => {
  const fixture = await createGrokFixture();
  t.after(() => fixture.cleanup());
  for (const interruption of ['cancel', 'close'] as const) {
    const history = await createGrokHistoryProcess(processOptions(fixture));
    t.after(() => history.close());
    const previous = new Set(await childPids()), controller = new AbortController();
    const reading = ports(history).transcript({ conversation: ref(history, fixture.ids.alpha), limit: 1 }, { signal: controller.signal })
      .then((value) => ({ kind: 'value' as const, value }), (error: unknown) => ({ kind: 'error' as const, error }));
    const pid = await enteredProcess(previous);
    process.kill(-pid, 'SIGSTOP');
    const limits = await readFile(`/proc/${pid}/limits`, 'utf8');
    assert.match(limits, /Max address space\s+4294967296\s+4294967296/u);
    assert.match(limits, /Max cpu time\s+20\s+20/u);
    let closing: Promise<void> | undefined;
    if (interruption === 'cancel') controller.abort(); else closing = history.close();
    const result = await reading;
    if (result.kind !== 'error') assert.fail('An interrupted native Grok startup must reject its entered public read.');
    assert.equal(code(interruption === 'cancel' ? 'cancelled' : 'closed')(result.error), true);
    await (closing ?? history.close());
    assert.throws(() => process.kill(pid, 0), code('ESRCH'));
    assert.throws(() => process.kill(-pid, 0), code('ESRCH'));
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});
