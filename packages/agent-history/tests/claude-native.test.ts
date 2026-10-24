import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import test from 'node:test';
import { parseAgentProviderConversationId } from '@agen-ai/agent-protocol';
import { createClaudeHistory } from '../dist/claude.js';
import type { AgentHistory, AgentHistoryConversationRef, AgentHistoryRecord } from '../src/index.js';
import { claudeMessage, claudeSessionFile, createClaudeFixture, seedClaudeLargeSession, seedClaudeSession, type ClaudeFixture } from './helpers/claude-fixture.js';

const nativeOptions = {
  skip: process.platform === 'linux' ? false : 'Claude native fixture tests require the qualified Linux prlimit worker.',
  timeout: 30000,
};

function options(fixture: ClaudeFixture) {
  return {
    sourceId: basename(fixture.root), generation: 'fixture-generation', configHome: fixture.configHome,
    scope: { kind: 'project' as const, projectPath: fixture.projectPath, worktrees: 'excluded' as const },
    resources: { kind: 'linux-prlimit' as const, executable: '/usr/bin/prlimit', temporaryRoot: fixture.temporaryRoot },
  };
}

function conversation(history: AgentHistory, id: string): AgentHistoryConversationRef {
  return {
    source: { providerKey: history.source.providerKey, sourceId: history.source.sourceId, generation: history.source.generation },
    conversationId: parseAgentProviderConversationId(id),
  };
}

function catalog(history: AgentHistory) {
  if (history.catalog.status !== 'supported') assert.fail('The Claude native catalog must be supported.');
  return history.catalog.list;
}

function lookup(history: AgentHistory) {
  if (history.lookup.status !== 'supported') assert.fail('The Claude native lookup must be supported.');
  return history.lookup.get;
}

function transcript(history: AgentHistory) {
  if (history.transcript.status !== 'supported') assert.fail('The Claude main transcript must be supported.');
  return history.transcript.read;
}

async function catalogIds(history: AgentHistory): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 20; count += 1) {
    const page = await catalog(history)({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...page.items.map((item) => item.ref.conversationId));
    if (page.nextCursor === undefined) return ids;
    cursor = page.nextCursor;
  }
  assert.fail('The bounded synthetic fixture must not require twenty catalog pages.');
}

async function transcriptRecords(history: AgentHistory, ref: AgentHistoryConversationRef): Promise<AgentHistoryRecord[]> {
  const records: AgentHistoryRecord[] = [];
  let cursor: string | undefined;
  for (let count = 0; count < 20; count += 1) {
    const page = await transcript(history)({ conversation: ref, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length <= 1, true);
    records.push(...page.items);
    if (page.nextCursor === undefined) return records;
    cursor = page.nextCursor;
  }
  assert.fail('The bounded synthetic fixture must not require twenty transcript pages.');
}

function code(expected: string) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}

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
      if (args.includes('--jitless') && args.includes('--max-old-space-size=128')) return pid;
    }
  }
  assert.fail('The actual Claude worker must enter its owned process group before cancellation.');
}

test('Claude native catalog and one-record transcript pages preserve mixed text and tool order', nativeOptions, async (t) => {
  const fixture = await createClaudeFixture();
  t.after(() => fixture.cleanup());
  const history = await createClaudeHistory(options(fixture));
  t.after(() => history.close());
  const first = await catalog(history)({ limit: 1 });
  assert.equal(first.items[0].title, 'HOME-A Alpha');
  assert.equal(first.items[0].ref.conversationId, fixture.ids.alpha);
  assert.equal(history.source.kind, 'claude-native');
  if (first.nextCursor === undefined) assert.fail('The first native catalog page must expose its continuation.');
  const second = await catalog(history)({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].title, 'HOME-A Beta');
  const records = await transcriptRecords(history, conversation(history, fixture.ids.alpha));
  assert.deepEqual(records.map((record) => record.kind), ['message', 'message', 'tool_call', 'message', 'tool_result', 'message', 'message']);
  assert.deepEqual(records.map((record) => {
    if (record.kind === 'message') return { role: record.role, content: record.content };
    if (record.kind === 'tool_call') return { callId: record.callId, name: record.name, arguments: record.arguments };
    if (record.kind === 'tool_result') return { callId: record.callId, outcome: record.outcome, content: record.content };
    return record;
  }), [
    { role: 'user', content: [{ kind: 'text', text: 'HOME-A user first' }] },
    { role: 'assistant', content: [{ kind: 'text', text: 'HOME-A assistant before tool' }] },
    { callId: 'toolu_fixture_read', name: 'Read', arguments: { file_path: '/synthetic/input.txt' } },
    { role: 'assistant', content: [{ kind: 'text', text: 'HOME-A assistant after tool' }] },
    { callId: 'toolu_fixture_read', outcome: 'succeeded', content: [{ kind: 'text', text: 'HOME-A tool result' }] },
    { role: 'user', content: [{ kind: 'text', text: 'HOME-A user after tool' }] },
    { role: 'assistant', content: [{ kind: 'text', text: 'HOME-A assistant final' }] },
  ]);
  assert.deepEqual(records.map((record) => record.native?.historyAnchor), ['alpha-u1', 'alpha-a1', 'alpha-a1', 'alpha-a1', 'alpha-u2', 'alpha-u2', 'alpha-a2']);
  await history.close();
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Claude existing titled empty history is distinct from unavailable and missing sessions', nativeOptions, async (t) => {
  const fixture = await createClaudeFixture();
  t.after(() => fixture.cleanup());
  const history = await createClaudeHistory(options(fixture));
  t.after(() => history.close());
  const empty = conversation(history, fixture.ids.empty);
  const info = await lookup(history)({ conversation: empty });
  assert.equal(info.title, 'HOME-A Empty');
  const page = await transcript(history)({ conversation: empty, limit: 1 });
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, undefined);
  for (const id of [fixture.ids.unavailable, fixture.ids.missing]) {
    await assert.rejects(lookup(history)({ conversation: conversation(history, id) }), code('not_found'));
    await assert.rejects(transcript(history)({ conversation: conversation(history, id), limit: 1 }), code('not_found'));
  }
  assert.equal((await lookup(history)({ conversation: conversation(history, fixture.ids.alpha) })).title, 'HOME-A Alpha');
});

test('Claude rejects portable non-UUID conversation references while retaining valid native history access', nativeOptions, async (t) => {
  const fixture = await createClaudeFixture();
  t.after(() => fixture.cleanup());
  const history = await createClaudeHistory(options(fixture));
  t.after(() => history.close());
  const baseline = await readdir(fixture.temporaryRoot);
  for (const id of ['../outside-project', 'portable-non-uuid']) {
    const ref = conversation(history, id);
    await assert.rejects(lookup(history)({ conversation: ref }), code('invalid_input'));
    await assert.rejects(transcript(history)({ conversation: ref, limit: 1 }), code('invalid_input'));
  }
  assert.deepEqual(await readdir(fixture.temporaryRoot), baseline);
  assert.equal((await lookup(history)({ conversation: conversation(history, fixture.ids.alpha) })).title, 'HOME-A Alpha');
});

test('concurrent Claude config homes preserve independent catalog and transcript content', nativeOptions, async (t) => {
  const fixtures = await Promise.all([createClaudeFixture({ label: 'HOME-A' }), createClaudeFixture({ label: 'HOME-B' })]);
  t.after(async () => { await Promise.all(fixtures.map((fixture) => fixture.cleanup())); });
  const histories = await Promise.all(fixtures.map((fixture) => createClaudeHistory(options(fixture))));
  t.after(async () => { await Promise.all(histories.map((history) => history.close())); });
  const catalogs = await Promise.all(histories.map((history) => catalog(history)({ limit: 1 })));
  assert.deepEqual(catalogs.map((page) => page.items[0].title), ['HOME-A Alpha', 'HOME-B Alpha']);
  const messages = await Promise.all(histories.map((history, index) => transcript(history)({ conversation: conversation(history, fixtures[index].ids.alpha), limit: 1 })));
  assert.deepEqual(messages.map((page) => page.items[0]), [
    { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'HOME-A user first' }], native: { historyAnchor: 'alpha-u1' }, timestamp: '2026-10-21T12:00:00.000Z' },
    { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'HOME-B user first' }], native: { historyAnchor: 'alpha-u1' }, timestamp: '2026-10-21T12:00:00.000Z' },
  ]);
});

test('Claude programmatic selection filters discovery without making direct native history unavailable', nativeOptions, async (t) => {
  const fixture = await createClaudeFixture();
  t.after(() => fixture.cleanup());
  const excluded = await createClaudeHistory({ ...options(fixture), includeProgrammatic: false });
  const included = await createClaudeHistory({ ...options(fixture), includeProgrammatic: true });
  t.after(async () => { await Promise.all([excluded.close(), included.close()]); });
  assert.deepEqual(await catalogIds(excluded), [fixture.ids.alpha, fixture.ids.beta, fixture.ids.compact, fixture.ids.empty]);
  assert.deepEqual(await catalogIds(included), [fixture.ids.alpha, fixture.ids.beta, fixture.ids.compact, fixture.ids.programmatic, fixture.ids.empty]);
  const programmatic = conversation(excluded, fixture.ids.programmatic);
  assert.equal((await lookup(excluded)({ conversation: programmatic })).title, 'HOME-A Programmatic');
  assert.deepEqual((await transcript(excluded)({ conversation: programmatic, limit: 1 })).items.map((record) => record.kind === 'message' ? record.content : record), [[{ kind: 'text', text: 'HOME-A SDK prompt' }]]);
});

test('Claude project worktree exclusion applies to direct lookup as well as discovery', nativeOptions, async (t) => {
  const fixture = await createClaudeFixture({ gitWorktree: true });
  t.after(() => fixture.cleanup());
  const excluded = await createClaudeHistory({ ...options(fixture), includeProgrammatic: false });
  const included = await createClaudeHistory({ ...options(fixture), includeProgrammatic: false,
    scope: { kind: 'project', projectPath: fixture.projectPath, worktrees: 'included' } });
  const allProjects = await createClaudeHistory({ ...options(fixture), includeProgrammatic: false, scope: { kind: 'all_projects' } });
  t.after(async () => { await Promise.all([excluded.close(), included.close(), allProjects.close()]); });
  assert.deepEqual(await catalogIds(excluded), [fixture.ids.alpha, fixture.ids.beta, fixture.ids.compact, fixture.ids.empty]);
  assert.deepEqual(await catalogIds(included), [fixture.ids.alpha, fixture.ids.beta, fixture.ids.compact, fixture.ids.empty, fixture.ids.worktree]);
  const worktree = conversation(excluded, fixture.ids.worktree);
  await assert.rejects(lookup(excluded)({ conversation: worktree }), code('unsupported_scope'));
  await assert.rejects(transcript(excluded)({ conversation: worktree, limit: 1 }), code('unsupported_scope'));
  assert.equal((await lookup(included)({ conversation: conversation(included, fixture.ids.worktree) })).title, 'HOME-A Worktree');
  assert.equal((await lookup(allProjects)({ conversation: conversation(allProjects, fixture.ids.otherProject) })).title, 'HOME-A Other project');
  assert.deepEqual(await catalogIds(allProjects), [fixture.ids.alpha, fixture.ids.beta, fixture.ids.compact, fixture.ids.empty, fixture.ids.otherProject, fixture.ids.worktree]);
});

test('Claude opaque system records describe surviving native coverage without inventing a compaction payload', nativeOptions, async (t) => {
  const fixture = await createClaudeFixture();
  t.after(() => fixture.cleanup());
  const history = await createClaudeHistory(options(fixture));
  t.after(() => history.close());
  const first = await transcript(history)({ conversation: conversation(history, fixture.ids.compact), limit: 1 });
  assert.deepEqual(first.coverage, { view: 'retained_chain', children: 'excluded', omissions: ['native_retention', 'subagents_excluded', 'unsupported_record_kind'] });
  assert.equal(first.consistency, 'live');
  const records = await transcriptRecords(history, conversation(history, fixture.ids.compact));
  assert.deepEqual(records.map((record) => record.kind), ['notice', 'message', 'message']);
  assert.deepEqual(records.map((record) => record.kind === 'message' ? record.content : record.kind === 'notice' ? record.code : record), [
    'claude.system_record', [{ kind: 'text', text: 'HOME-A retained user' }], [{ kind: 'text', text: 'HOME-A retained assistant' }],
  ]);
  assert.equal(JSON.stringify(records).includes('PRECOMPACTION'), false);
});

test('Claude normalized-page and native-ingress overflows preserve fitting records and leave other native reads usable', nativeOptions, async (t) => {
  for (const textBytes of [300000, 1100000]) {
    const fixture = await createClaudeFixture();
    t.after(() => fixture.cleanup());
    await seedClaudeSession(fixture, fixture.ids.oversized, [
      claudeMessage(fixture.ids.oversized, 'oversized-u', null, 'user', 'Owned oversized target'),
      claudeMessage(fixture.ids.oversized, 'oversized-a', 'oversized-u', 'assistant', [{ type: 'text', text: 'x'.repeat(textBytes) }]),
    ], { title: 'Owned oversized target' });
    const history = await createClaudeHistory(options(fixture));
    t.after(() => history.close());
    const first = await transcript(history)({ conversation: conversation(history, fixture.ids.oversized), limit: 1 });
    assert.deepEqual(first.items.map((record) => record.kind === 'message' ? record.content : record), [[{ kind: 'text', text: 'Owned oversized target' }]]);
    if (first.nextCursor === undefined) assert.fail('A fitting first record must retain the continuation to the oversized native record.');
    await assert.rejects(transcript(history)({ conversation: conversation(history, fixture.ids.oversized), limit: 1, cursor: first.nextCursor }), code('limit_exhausted'));
    assert.equal((await lookup(history)({ conversation: conversation(history, fixture.ids.beta) })).title, 'HOME-A Beta');
    await history.close();
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});

test('Claude resource-bounded worker failure on a streamed 268 MiB native record leaves the source usable', nativeOptions, async (t) => {
  const fixture = await createClaudeFixture();
  t.after(() => fixture.cleanup());
  const textBytes = 268 * 1024 * 1024;
  await seedClaudeLargeSession(fixture, fixture.ids.oversized, textBytes);
  assert.equal((await stat(claudeSessionFile(fixture, fixture.ids.oversized))).size > textBytes, true);
  const history = await createClaudeHistory(options(fixture));
  t.after(() => history.close());
  await assert.rejects(transcript(history)({ conversation: conversation(history, fixture.ids.oversized), limit: 1 }), code('native_failure'));
  assert.equal((await lookup(history)({ conversation: conversation(history, fixture.ids.beta) })).title, 'HOME-A Beta');
  await history.close();
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
});

test('Claude failed resource launch reports native failure and pre-aborted requests never open a worker', nativeOptions, async (t) => {
  const fixture = await createClaudeFixture();
  t.after(() => fixture.cleanup());
  const history = await createClaudeHistory({ ...options(fixture), resources: { ...options(fixture).resources, executable: '/usr/bin/false' } });
  t.after(() => history.close());
  const baseline = await readdir(fixture.temporaryRoot);
  await assert.rejects(catalog(history)({ limit: 1 }, { signal: AbortSignal.abort() }), code('cancelled'));
  assert.deepEqual(await readdir(fixture.temporaryRoot), baseline);
  await assert.rejects(catalog(history)({ limit: 1 }), code('native_failure'));
  await history.close();
  assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  assert.equal(history.rename.status, 'unsupported');
  assert.equal('apply' in history.rename, false);
  assert.equal(history.contentSearch.status, 'unsupported');
  assert.equal('search' in history.contentSearch, false);
});

test('Claude cancellation and close reap an entered native worker and its process group', nativeOptions, async (t) => {
  const fixture = await createClaudeFixture();
  t.after(() => fixture.cleanup());
  for (const interruption of ['cancel', 'close'] as const) {
    const history = await createClaudeHistory(options(fixture));
    t.after(() => history.close());
    const controller = new AbortController();
    const previous = new Set(await childPids());
    const reading = transcript(history)({ conversation: conversation(history, fixture.ids.alpha), limit: 1 }, { signal: controller.signal })
      .then((value) => ({ kind: 'value' as const, value }), (error: unknown) => ({ kind: 'error' as const, error }));
    const pid = await enteredWorker(previous);
    process.kill(pid, 0);
    process.kill(-pid, 0);
    let closing: Promise<void> | undefined;
    if (interruption === 'cancel') controller.abort();
    else closing = history.close();
    const result = await reading;
    assert.equal(result.kind, 'error');
    if (result.kind !== 'error') assert.fail('Interruption of the entered native worker must reject its public read.');
    assert.equal(code(interruption === 'cancel' ? 'cancelled' : 'closed')(result.error), true);
    await (closing ?? history.close());
    assert.throws(() => process.kill(pid, 0), code('ESRCH'));
    assert.throws(() => process.kill(-pid, 0), code('ESRCH'));
    assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  }
});
