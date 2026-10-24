import assert from 'node:assert/strict';
import {
  createAgentHistory, parseAgentHistorySource, parseAgentHistoryConversationRef,
  parseAgentHistoryCatalogPage, parseAgentHistoryTranscriptPage,
  type AgentHistoryDriver, type AgentHistoryUnsupportedReason,
} from '@agen-ai/agent-history';
import { AgentHistorySourceSchema } from '@agen-ai/agent-history/zod';
import { createClaudeHistory } from '@agen-ai/agent-history/claude';
import { createCodexHistory, createCodexHistoryProcess } from '@agen-ai/agent-history/codex';
import { createOpenCodeHistory } from '@agen-ai/agent-history/opencode';
import { createCursorHistory } from '@agen-ai/agent-history/cursor';
import { createAcpHistory } from '@agen-ai/agent-history/acp';
import { createGrokHistory, createGrokHistoryProcess } from '@agen-ai/agent-history/grok';

assert.equal(typeof createClaudeHistory, 'function');
assert.equal(typeof createCodexHistory, 'function');
assert.equal(typeof createCodexHistoryProcess, 'function');
assert.equal(typeof createOpenCodeHistory, 'function');
assert.equal(typeof createCursorHistory, 'function');
assert.equal(typeof createAcpHistory, 'function');
assert.equal(typeof createGrokHistory, 'function');
assert.equal(typeof createGrokHistoryProcess, 'function');

const source = parseAgentHistorySource({
  providerKey: 'packed-history', sourceId: 'fixture-source', generation: 'generation-one',
  kind: 'deterministic', scope: { kind: 'all_projects' },
  storageEffects: { kind: 'none' }, resourceOwnership: 'owned',
});
assert.equal(AgentHistorySourceSchema.parse(source).sourceId, 'fixture-source');
const identity = { providerKey: source.providerKey, sourceId: source.sourceId, generation: source.generation };
const firstRef = parseAgentHistoryConversationRef({ source: identity, conversationId: 'native-first' });
const secondRef = parseAgentHistoryConversationRef({ source: identity, conversationId: 'native-second' });
const observedAt = '2026-10-21T12:00:00.000Z';
const catalogCoverage = { view: 'catalog', children: 'excluded', omissions: [] };
const first = parseAgentHistoryCatalogPage({
  items: [{ ref: firstRef, title: 'First history', archiveState: 'unknown' }],
  nextCursor: 'native-next', observedAt, consistency: 'live', coverage: catalogCoverage,
});
const second = parseAgentHistoryCatalogPage({
  items: [{ ref: secondRef, title: 'Second history', archiveState: 'not_archived' }],
  observedAt, consistency: 'live', coverage: catalogCoverage,
});
const transcript = parseAgentHistoryTranscriptPage({
  items: [
    { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Fixture question' }] },
    { kind: 'message', role: 'assistant', content: [{ kind: 'text', text: 'Fixture answer' }] },
  ], observedAt, consistency: 'live',
  coverage: { view: 'retained_chain', children: 'excluded', omissions: ['subagents_excluded'] },
});
const unsupported = { status: 'unsupported', reason: {
  code: 'native_unavailable', message: 'The synthetic driver only exposes catalog, lookup and transcript.',
} satisfies AgentHistoryUnsupportedReason } as const;
let disposals = 0;
let listDelegations = 0;
const driver: AgentHistoryDriver = {
  catalog: { status: 'supported', descriptor: { filters: [], orders: ['native', 'created_desc'], pagination: 'cursor' },
    async list(input, context) {
      context.markDispatched();
      listDelegations += 1;
      assert.equal(input.limit, 1);
      if (input.cursor === undefined) return first;
      assert.equal(input.cursor, 'native-next');
      return second;
    } },
  lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' },
    async get(input, context) {
      context.markDispatched();
      assert.deepEqual(input.conversation, firstRef);
      const summary = first.items[0];
      assert(summary);
      return summary;
    } },
  transcript: { status: 'supported', descriptor: { views: ['main'], pagination: 'cursor' },
    async read(input, context) {
      context.markDispatched();
      assert.deepEqual(input.conversation, firstRef);
      return transcript;
    } },
  views: unsupported, metadataSearch: unsupported, contentSearch: unsupported, rename: unsupported,
  archive: unsupported, restore: unsupported, delete: unsupported,
  async dispose() { disposals += 1; },
};
const history = createAgentHistory({ source, driver });
try {
  assert.equal(history.catalog.status, 'supported');
  assert.equal(history.lookup.status, 'supported');
  assert.equal(history.transcript.status, 'supported');
  if (history.catalog.status !== 'supported' || history.lookup.status !== 'supported'
    || history.transcript.status !== 'supported') throw new Error('Required history ports are unavailable');
  const pageOne = await history.catalog.list({ limit: 1 });
  assert(pageOne.nextCursor);
  assert.notEqual(pageOne.nextCursor, 'native-next');
  const pageTwo = await history.catalog.list({ limit: 1, cursor: pageOne.nextCursor });
  const titles = [...pageOne.items, ...pageTwo.items].map((item) => item.title);
  assert.deepEqual(titles, ['First history', 'Second history']);
  assert.equal(pageTwo.nextCursor, undefined);
  const summary = await history.lookup.get({ conversation: firstRef });
  assert.equal(summary.title, 'First history');
  const read = await history.transcript.read({ conversation: summary.ref });
  const texts = read.items.flatMap((item) => item.kind === 'message'
    ? item.content.flatMap((content) => content.kind === 'text' ? [content.text] : []) : []);
  assert.deepEqual(texts, ['Fixture question', 'Fixture answer']);
  assert.deepEqual(read.coverage.omissions, ['subagents_excluded']);
  const beforeForeignCursor = listDelegations;
  await assert.rejects(history.catalog.list({ limit: 1, cursor: pageOne.nextCursor, order: 'created_desc' }), { code: 'invalid_cursor' });
  assert.equal(listDelegations, beforeForeignCursor);
  const foreign = parseAgentHistoryConversationRef({ source: { ...identity, generation: 'generation-two' }, conversationId: 'native-first' });
  await assert.rejects(history.lookup.get({ conversation: foreign }), { code: 'wrong_source' });
  assert.equal(history.rename.status, 'unsupported');
  await Promise.all([history.close(), history.close()]);
  assert.equal(disposals, 1);
  await assert.rejects(history.catalog.list({ limit: 1 }), { code: 'closed' });
  assert.equal(listDelegations, 2);
  process.stdout.write(`${JSON.stringify({
    proof: 'history-only-root', evidence: 'synthetic', catalogTitles: titles, transcriptTexts: texts,
    nativeDisposals: disposals, foreignCursorDelegations: listDelegations - beforeForeignCursor, unsupportedRename: true,
    claudeImportWithoutPeer: true,
    codexImportWithoutPeer: true,
    opencodeImportWithoutPeer: true,
    cursorImportWithoutPeer: true,
    acpImportWithoutPeer: true,
    grokImportWithoutPeer: true,
  })}\n`);
} finally { await history.close(); }
