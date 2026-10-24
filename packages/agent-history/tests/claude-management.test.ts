import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createClaudeHistory } from '../dist/claude.js';
import { parseAgentHistoryConversationRef, type AgentHistory, type AgentHistoryMutationOperation } from '../dist/index.js';
import { claudeSessionFile, createClaudeFixture, forkClaudeFixture, type ClaudeFixture } from './helpers/claude-fixture.js';
import { mutationLauncher } from './helpers/claude-cursor-launcher.js';

const native = { skip: process.platform !== 'linux', timeout: 30000 };
function options(fixture: ClaudeFixture, management: readonly AgentHistoryMutationOperation[] = [], executable = '/usr/bin/prlimit') {
  return { sourceId: 'claude-management', generation: 'one', configHome: fixture.configHome,
    scope: { kind: 'project' as const, projectPath: fixture.projectPath, worktrees: 'excluded' as const }, management,
    resources: { kind: 'linux-prlimit' as const, executable, temporaryRoot: fixture.temporaryRoot } };
}
function ref(history: AgentHistory, id: string) {
  return parseAgentHistoryConversationRef({ source: { providerKey: history.source.providerKey,
    sourceId: history.source.sourceId, generation: history.source.generation }, conversationId: id });
}

test('Claude opt-in rename/delete use native effects, delete subagents, and preserve the native fork and foreign project', native, async () => {
  const fixture = await createClaudeFixture();
  const history = await createClaudeHistory(options(fixture, ['rename', 'delete']));
  const disabled = await createClaudeHistory(options(fixture));
  try {
    assert.equal(disabled.rename.status, 'unsupported'); assert.equal(disabled.delete.status, 'unsupported');
    const rename = history.rename, remove = history.delete;
    if (rename.status !== 'supported' || remove.status !== 'supported') assert.fail('Opt-in native Claude management is required.');
    assert.deepEqual(remove.descriptor.effects, { scope: 'local', descendants: 'subagents', active: 'requires_quiescent', atomicity: 'non_atomic' });
    const conversation = ref(history, fixture.ids.alpha), file = claudeSessionFile(fixture, fixture.ids.alpha);
    const before = await readFile(file, 'utf8');
    const denied = await rename.apply({ conversation, title: 'Denied title', acceptEffects: { ...rename.descriptor.effects, scope: 'remote' } });
    assert.equal(denied.status, 'not_applied'); assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual(await rename.apply({ conversation, title: 'Native renamed title', acceptEffects: rename.descriptor.effects }), { status: 'applied', ref: conversation });
    assert.equal(history.lookup.status, 'supported');
    if (history.lookup.status !== 'supported') assert.fail('Native lookup unavailable.');
    assert.equal((await history.lookup.get({ conversation })).title, 'Native renamed title');
    const fork = await forkClaudeFixture(fixture, fixture.ids.alpha);
    const folder = join(dirname(file), fixture.ids.alpha, 'subagents');
    await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'agent-child.jsonl'), '{"type":"user","isSidechain":true}\n');
    const foreign = claudeSessionFile(fixture, fixture.ids.otherProject, fixture.otherProjectPath), foreignBefore = await readFile(foreign, 'utf8');
    assert.deepEqual(await remove.apply({ conversation, acceptEffects: remove.descriptor.effects }), { status: 'applied', ref: conversation });
    await assert.rejects(stat(file), { code: 'ENOENT' }); await assert.rejects(stat(folder), { code: 'ENOENT' });
    assert.equal((await history.lookup.get({ conversation: ref(history, fork) })).title, 'Native surviving fork');
    assert.equal(await readFile(foreign, 'utf8'), foreignBefore);
    const missing = await remove.apply({ conversation, acceptEffects: remove.descriptor.effects });
    assert.equal(missing.status, 'not_applied'); if (missing.status !== 'not_applied') assert.fail('Missing delete must remain preflight failure.');
    assert.equal(missing.reason.code, 'not_found');
    await assert.rejects(history.lookup.get({ conversation }), { code: 'not_found' });
  } finally { await Promise.all([history.close(), disabled.close()]); await fixture.cleanup(); }
});

test('Claude actual pipe response loss appends exactly one native rename and fences later mutation', native, async () => {
  const fixture = await createClaudeFixture(), launcher = await mutationLauncher(fixture.root, 'drop_receipt');
  const history = await createClaudeHistory(options(fixture, ['rename', 'delete'], launcher.executable));
  try {
    if (history.rename.status !== 'supported' || history.delete.status !== 'supported') assert.fail('Native mutation ports unavailable.');
    const conversation = ref(history, fixture.ids.alpha);
    const result = await history.rename.apply({ conversation, title: 'Lost response rename', acceptEffects: history.rename.descriptor.effects });
    assert.equal(result.status, 'outcome_unknown');
    const rows: unknown[] = (await readFile(claudeSessionFile(fixture, fixture.ids.alpha), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => row !== null && typeof row === 'object' && 'customTitle' in row && row.customTitle === 'Lost response rename').length, 1);
    assert.equal((await launcher.events()).filter((event) => event === 'permit').length, 1);
    const later = await history.delete.apply({ conversation, acceptEffects: history.delete.descriptor.effects });
    assert.equal(later.status, 'not_applied');
    assert.equal((await launcher.events()).filter((event) => event === 'permit').length, 1);
    await history.close(); assert.deepEqual(await readdir(fixture.temporaryRoot), []);
  } finally { await history.close(); await fixture.cleanup(); }
});

test('Claude cancellation and close before dispatch permit preserve native bytes and known not_applied', native, async () => {
  for (const action of ['cancel', 'close'] as const) {
    const fixture = await createClaudeFixture(), launcher = await mutationLauncher(fixture.root, 'pause_ready');
    const history = await createClaudeHistory(options(fixture, ['rename'], launcher.executable));
    try {
      if (history.rename.status !== 'supported') assert.fail('Native rename unavailable.');
      const before = await readFile(claudeSessionFile(fixture, fixture.ids.alpha), 'utf8'), controller = new AbortController();
      const pending = history.rename.apply({ conversation: ref(history, fixture.ids.alpha), title: 'Must not enter', acceptEffects: history.rename.descriptor.effects }, { signal: controller.signal });
      await launcher.waitReady();
      if (action === 'cancel') controller.abort(); else await history.close();
      const result = await pending;
      assert.equal(result.status, 'not_applied');
      await history.close();
      assert.equal(await readFile(claudeSessionFile(fixture, fixture.ids.alpha), 'utf8'), before);
      assert.deepEqual(await launcher.events(), ['ready']); assert.deepEqual(await readdir(fixture.temporaryRoot), []);
    } finally { await history.close(); await fixture.cleanup(); }
  }
});
