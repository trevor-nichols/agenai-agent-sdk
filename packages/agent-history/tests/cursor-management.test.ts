import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { createCursorHistory } from '../dist/cursor.js';
import { parseAgentHistoryConversationRef, type AgentHistory, type AgentHistoryMutationOperation } from '../dist/index.js';
import { createCursorFixture, cursorFixtureActiveRun, cursorFixtureAgent, cursorFixtureDependencies,
  cursorFixtureRows, type CursorFixture } from './helpers/cursor-fixture.js';
import { mutationLauncher } from './helpers/claude-cursor-launcher.js';

const native = { skip: process.platform !== 'linux', timeout: 30000 };
function options(fixture: CursorFixture, management: readonly AgentHistoryMutationOperation[] = [], executable = '/usr/bin/prlimit') {
  return { sourceId: 'cursor-management', generation: 'one', store: { kind: fixture.backend, path: fixture.storeRoot },
    scope: { kind: 'project' as const, projectPath: fixture.projectPath, worktrees: 'excluded' as const }, management,
    resources: { kind: 'linux-prlimit' as const, executable, temporaryRoot: fixture.temporaryRoot } };
}
function ref(history: AgentHistory, id: string) {
  return parseAgentHistoryConversationRef({ source: { providerKey: history.source.providerKey,
    sourceId: history.source.sourceId, generation: history.source.generation }, conversationId: id });
}

for (const backend of ['jsonl', 'sqlite'] as const) {
  test(`Cursor ${backend} native archive/restore/delete preserve foreign agents and delete selected run/event/checkpoint dependencies`, native, async () => {
    const fixture = await createCursorFixture({ backend });
    const history = await createCursorHistory(options(fixture, ['archive', 'restore', 'delete']));
    const disabled = await createCursorHistory(options(fixture));
    try {
      assert.equal(disabled.archive.status, 'unsupported'); assert.equal(disabled.restore.status, 'unsupported'); assert.equal(disabled.delete.status, 'unsupported');
      assert.equal(history.rename.status, 'unsupported'); assert.equal(history.metadataSearch.status, 'unsupported'); assert.equal(history.contentSearch.status, 'unsupported');
      if (history.archive.status !== 'supported' || history.restore.status !== 'supported' || history.delete.status !== 'supported') assert.fail('Native management unavailable.');
      const beta = ref(history, fixture.ids.beta), conversation = ref(history, fixture.ids.alpha);
      const before = await cursorFixtureAgent(fixture, fixture.ids.beta);
      assert.equal((await history.archive.apply({ conversation: beta, acceptEffects: { ...history.archive.descriptor.effects, scope: 'remote' } })).status, 'not_applied');
      assert.deepEqual(await cursorFixtureAgent(fixture, fixture.ids.beta), before);
      assert.deepEqual(await history.archive.apply({ conversation: beta, acceptEffects: history.archive.descriptor.effects }), { status: 'applied', ref: beta });
      const archived = await cursorFixtureAgent(fixture, fixture.ids.beta);
      assert.equal(archived !== null && typeof archived === 'object' && 'status' in archived ? archived.status : undefined, 'archived');
      assert.deepEqual(await history.restore.apply({ conversation: beta, acceptEffects: history.restore.descriptor.effects }), { status: 'applied', ref: beta });
      const restored = await cursorFixtureAgent(fixture, fixture.ids.beta);
      assert.equal(restored !== null && typeof restored === 'object' && 'status' in restored ? restored.status : undefined, 'idle');
      const foreign = await cursorFixtureAgent(fixture, fixture.ids.foreign), dependencies = await cursorFixtureDependencies(fixture, fixture.ids.alpha, fixture.runIds.first);
      assert.equal(dependencies.runs.length, 4); assert.equal(dependencies.events.length, 3); assert(dependencies.checkpoints.length > 0);
      const blocked = await history.delete.apply({ conversation: ref(history, fixture.ids.foreign), acceptEffects: history.delete.descriptor.effects });
      assert.equal(blocked.status, 'not_applied'); assert.deepEqual(await cursorFixtureAgent(fixture, fixture.ids.foreign), foreign);
      assert.deepEqual(await history.delete.apply({ conversation, acceptEffects: history.delete.descriptor.effects }), { status: 'applied', ref: conversation });
      assert.equal(await cursorFixtureAgent(fixture, fixture.ids.alpha), null);
      assert.deepEqual(await cursorFixtureDependencies(fixture, fixture.ids.alpha, fixture.runIds.first), { runs: [], events: [], checkpoints: [] });
      assert.deepEqual(await cursorFixtureAgent(fixture, fixture.ids.foreign), foreign);
      const survivors = await cursorFixtureRows(fixture);
      assert.equal(survivors.agents.length, 3); assert.equal(survivors.runs.length, 1);
      assert.equal((await history.delete.apply({ conversation, acceptEffects: history.delete.descriptor.effects })).status, 'not_applied');
    } finally { await Promise.all([history.close(), disabled.close()]); await fixture.cleanup(); }
  });

  test(`Cursor ${backend} native active metadata rejects management before permit and response loss fences deletion`, native, async () => {
    const fixture = await createCursorFixture({ backend }), launcher = await mutationLauncher(fixture.root, 'drop_receipt');
    const history = await createCursorHistory(options(fixture, ['archive', 'restore', 'delete'], launcher.executable));
    try {
      if (history.archive.status !== 'supported' || history.restore.status !== 'supported' || history.delete.status !== 'supported') assert.fail('Native management unavailable.');
      const conversation = ref(history, fixture.ids.alpha);
      await cursorFixtureActiveRun(fixture, fixture.ids.alpha, fixture.runIds.running);
      const before = await cursorFixtureAgent(fixture, fixture.ids.alpha);
      for (const port of [history.archive, history.restore, history.delete]) {
        const result = await port.apply({ conversation, acceptEffects: port.descriptor.effects });
        assert.equal(result.status, 'not_applied');
        if (result.status !== 'not_applied') assert.fail('Native active preflight must reject.');
        assert.equal(result.reason.code, 'unsupported_scope');
      }
      assert.deepEqual(await cursorFixtureAgent(fixture, fixture.ids.alpha), before);
      assert.equal((await launcher.events()).filter((event) => event === 'permit').length, 0);
      await cursorFixtureActiveRun(fixture, fixture.ids.alpha, null);
      const lost = await history.delete.apply({ conversation, acceptEffects: history.delete.descriptor.effects });
      assert.equal(lost.status, 'outcome_unknown'); assert.equal(await cursorFixtureAgent(fixture, fixture.ids.alpha), null);
      assert.equal((await launcher.events()).filter((event) => event === 'permit').length, 1);
      const beta = ref(history, fixture.ids.beta);
      assert.equal((await history.archive.apply({ conversation: beta, acceptEffects: history.archive.descriptor.effects })).status, 'not_applied');
      assert.equal((await launcher.events()).filter((event) => event === 'permit').length, 1);
      assert.equal((await cursorFixtureRows(fixture)).agents.length, 3);
      await history.close(); assert.deepEqual(await readdir(fixture.temporaryRoot), []);
    } finally { await history.close(); await fixture.cleanup(); }
  });
}
