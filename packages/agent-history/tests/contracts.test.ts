import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentHistoryValidationError, parseAgentHistoryConversationRef, parseAgentHistoryConversationSummary,
  parseAgentHistoryListInput, parseAgentHistoryMutationResult, parseAgentHistoryReadInput,
  parseAgentHistorySource, parseAgentHistoryTranscriptPage,
} from '../src/index.js';

const identity = { providerKey: 'fixture.native', sourceId: 'fixture-store', generation: 'configuration-1' };
function source() {
  return { ...identity, kind: 'fixture-native', scope: { kind: 'project', projectPath: '/fixture', worktrees: 'excluded' },
    storageEffects: { kind: 'unknown', reason: 'Caller-owned provider may update an index.' }, resourceOwnership: 'borrowed' };
}
function reference() { return { source: { ...identity }, conversationId: '../../opaque/native-id' }; }
function summary() { return { ref: reference(), archiveState: 'unknown' }; }
function page(items: unknown[]) {
  return { items, observedAt: '2026-10-21T12:00:00.000Z', consistency: 'live',
    coverage: { view: 'retained_chain', children: 'excluded', omissions: ['compacted'] } };
}
function rejects(input: () => unknown, path: readonly (string | number)[], code?: string): void {
  assert.throws(input, (error: unknown) => {
    assert(error instanceof AgentHistoryValidationError);
    assert.deepEqual(error.issues[0]?.path, path);
    if (code) assert.equal(error.issues[0]?.code, code);
    return true;
  });
}

test('public parsers preserve opaque native references and missing metadata without inventing known facts', () => {
  assert.deepEqual(parseAgentHistoryConversationRef(reference()), {
    source: { providerKey: 'fixture.native', sourceId: 'fixture-store', generation: 'configuration-1' },
    conversationId: '../../opaque/native-id',
  });
  assert.deepEqual(parseAgentHistoryConversationSummary(summary()), {
    ref: { source: identity, conversationId: '../../opaque/native-id' }, archiveState: 'unknown',
  });
  const missingState = { ref: reference() };
  rejects(() => parseAgentHistoryConversationSummary(missingState), ['archiveState']);
  rejects(() => parseAgentHistoryConversationSummary({ ...summary(), parent: { ...reference(), source: { ...identity, generation: 'other-configuration' } } }), ['parent', 'source']);
});

test('inert transcript records preserve ordered text, attachments, tools and compaction without callable payloads', () => {
  const input = page([
    { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Inspect this image.' }, { kind: 'attachment', attachmentKind: 'image', reference: { kind: 'native', id: 'native-image-1' }, mediaType: 'image/png' }] },
    { kind: 'tool_call', callId: 'native-tool-1', name: 'shell', arguments: { command: 'do not execute this history text' } },
    { kind: 'tool_result', callId: 'native-tool-1', outcome: 'unknown', content: [{ kind: 'text', text: 'Retained historical output.' }] },
    { kind: 'compaction', summary: 'Only the surviving chain remains.' },
  ]);
  assert.deepEqual(parseAgentHistoryTranscriptPage(input), input);
  rejects(() => parseAgentHistoryTranscriptPage(page([{ kind: 'message', role: 'assistant', content: [{ kind: 'text', text: 'old' }], id: 'agent:0' }])), ['items', 0]);
  rejects(() => parseAgentHistoryTranscriptPage(page([{ kind: 'tool_call', name: 'shell', arguments: { execute() { throw new Error('must remain inert'); } } }])), ['items', 0, 'arguments', 'execute'], 'invalid_data');
});

test('source and operation parsers reject extra authority, oversized identities and incomplete native view selectors', () => {
  assert.deepEqual(parseAgentHistorySource(source()), source());
  rejects(() => parseAgentHistorySource({ ...source(), credentials: 'must-not-be-stored' }), []);
  rejects(() => parseAgentHistorySource({ ...source(), sourceId: 's'.repeat(129) }), ['sourceId']);
  rejects(() => parseAgentHistoryConversationRef({ ...reference(), conversationId: 'n'.repeat(513) }), ['conversationId']);
  rejects(() => parseAgentHistoryReadInput({ conversation: reference(), view: { kind: 'subagent' } }), ['view', 'id']);
  rejects(() => parseAgentHistoryReadInput({ conversation: reference(), view: { kind: 'main', id: 'unqualified-run' } }), ['view']);
  rejects(() => parseAgentHistoryListInput({ limit: 1, nativeOptions: { includeSecrets: true } }), []);
});

test('record, UTF-8 output and cursor ceilings reject the actual excess before returning partial pages', () => {
  rejects(() => parseAgentHistoryTranscriptPage(page(Array.from({ length: 101 }, () => ({ kind: 'notice', code: 'native', message: 'Historical notice' })))), ['items']);
  rejects(() => parseAgentHistoryTranscriptPage(page([{ kind: 'message', role: 'assistant', content: [{ kind: 'text', text: 'λ'.repeat(600_000) }] }])), ['items', 0, 'content', 0, 'text'], 'byte_limit');
  rejects(() => parseAgentHistoryListInput({ cursor: 'λ'.repeat(32_769) }), ['cursor']);
  assert.deepEqual(parseAgentHistoryListInput({ limit: 100, cursor: 'λ'.repeat(32_768) }), { limit: 100, cursor: 'λ'.repeat(32_768) });
});

test('parser boundary rejects accessors, sparse arrays, cycles and deep data without invoking accessors', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'sourceId', { enumerable: true, get() { reads += 1; return 'unexpected'; } });
  rejects(() => parseAgentHistorySource(accessor), ['sourceId'], 'invalid_data');
  assert.equal(reads, 0);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  rejects(() => parseAgentHistorySource(revoked.proxy), [], 'invalid_data');
  const sparse = new Array<unknown>(1);
  rejects(() => parseAgentHistoryTranscriptPage(page(sparse)), ['items'], 'entry_limit');
  const cyclic: { child?: unknown } = {};
  cyclic.child = cyclic;
  rejects(() => parseAgentHistoryTranscriptPage(page([{ kind: 'tool_call', name: 'retained', arguments: cyclic }])), ['items', 0, 'arguments', 'child'], 'invalid_data');
  let deep: unknown = 'end';
  for (let index = 0; index < 20; index += 1) deep = { child: deep };
  assert.throws(() => parseAgentHistoryTranscriptPage(page([{ kind: 'tool_call', name: 'retained', arguments: deep }])), (error: unknown) => {
    assert(error instanceof AgentHistoryValidationError);
    assert.equal(error.issues[0]?.code, 'depth_limit');
    return true;
  });
  assert.deepEqual(parseAgentHistorySource(source()), source());
});

test('accepted data is an owned immutable snapshot and mutation outcomes cannot mix receipts with uncertainty', () => {
  const input = source();
  const accepted = parseAgentHistorySource(input);
  input.scope.projectPath = '/changed-after-parse';
  assert.equal(accepted.scope.kind, 'project');
  if (accepted.scope.kind === 'project') assert.equal(accepted.scope.projectPath, '/fixture');
  assert.throws(() => Object.assign(accepted.scope, { projectPath: '/rewritten' }), TypeError);
  assert.deepEqual(parseAgentHistoryMutationResult({ status: 'outcome_unknown', ref: reference(), reason: { code: 'deadline_exceeded', message: 'Native effect may have occurred.' } }), {
    status: 'outcome_unknown', ref: reference(), reason: { code: 'deadline_exceeded', message: 'Native effect may have occurred.' },
  });
  rejects(() => parseAgentHistoryMutationResult({ status: 'applied', ref: reference(), reason: { code: 'failed', message: 'Contradictory result.' } }), []);
  rejects(() => parseAgentHistoryMutationResult({ status: 'not_applied', ref: reference() }), ['reason']);
});


test('optional undefined object properties are omitted while undefined array entries remain invalid', () => {
  assert.deepEqual(parseAgentHistoryListInput({ limit: undefined, cursor: undefined, order: 'native' }), { order: 'native' });
  const empty = page([]);
  assert.deepEqual(parseAgentHistoryTranscriptPage({ ...empty, nextCursor: undefined }), empty);
  rejects(() => parseAgentHistoryTranscriptPage(page([undefined])), ['items', 0], 'invalid_data');
});
