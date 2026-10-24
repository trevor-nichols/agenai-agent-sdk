// ------------------------------------------------------------------------------------------------
//                Credential-free custom history driver over bundled immutable example data
// ------------------------------------------------------------------------------------------------

import {
  AgentHistoryError,
  createAgentHistory,
  type AgentHistory,
  type AgentHistoryConversationSummary,
  type AgentHistoryCoverage,
  type AgentHistoryDriver,
  type AgentHistoryPage,
  type AgentHistoryRecord,
  type AgentHistorySource,
} from '@agen-ai/agent-history';
import {
  parseAgentIsoDateTime,
  parseAgentProviderConversationId,
  parseAgentProviderKey,
} from '@agen-ai/agent-protocol';

export const FIXTURE_SELECTED_CONVERSATION_ID = parseAgentProviderConversationId('example:release-review');

const identity = {
  providerKey: parseAgentProviderKey('example-history'),
  sourceId: 'bundled-history',
  generation: 'immutable-example-v1',
};
const source: AgentHistorySource = {
  ...identity,
  kind: 'example-memory-snapshot',
  scope: { kind: 'provider_defined', description: 'The two bundled synthetic conversations only.' },
  resourceOwnership: 'borrowed',
  storageEffects: { kind: 'none' },
};
const observedAt = parseAgentIsoDateTime('2026-10-21T12:00:00Z');
const conversations: readonly AgentHistoryConversationSummary[] = [
  {
    ref: { source: identity, conversationId: parseAgentProviderConversationId('example:design-review') },
    title: 'Synthetic design review', archiveState: 'not_archived',
  },
  {
    ref: { source: identity, conversationId: FIXTURE_SELECTED_CONVERSATION_ID },
    title: 'Synthetic release review', archiveState: 'not_archived',
  },
];
const releaseRecords: readonly AgentHistoryRecord[] = [
  { kind: 'compaction', summary: 'Earlier synthetic discussion was compacted.' },
  { kind: 'message', role: 'user', content: [
    { kind: 'text', text: 'Review the bundled release note.' },
    { kind: 'attachment', attachmentKind: 'document', name: 'release-note.txt',
      reference: { kind: 'native', id: 'example:inert-document' }, mediaType: 'text/plain' },
  ] },
  { kind: 'tool_call', callId: 'example:historical-read', name: 'read_file', arguments: { path: 'release-note.txt' } },
  { kind: 'tool_result', callId: 'example:historical-read', outcome: 'succeeded',
    content: [{ kind: 'text', text: 'Synthetic release note: history browsing is read-only.' }] },
  { kind: 'message', role: 'assistant', content: [
    { kind: 'thinking', text: 'This retained synthetic observation is inert history.' },
    { kind: 'text', text: 'The bundled release note is ready for review.' },
  ] },
];
const transcriptCoverage: AgentHistoryCoverage = {
  view: 'retained_chain', children: 'excluded', omissions: ['compacted', 'subagents_excluded'],
};
const unavailable = {
  status: 'unsupported',
  reason: { code: 'native_unavailable', message: 'This synthetic source implements catalog, lookup and main transcript only.' },
} satisfies AgentHistoryDriver['views'];

function page<Item>(
  items: readonly Item[],
  input: Readonly<{ cursor?: string; limit?: number }>,
  coverage: AgentHistoryCoverage,
): AgentHistoryPage<Item> {
  // This immutable driver emits its own offsets; the SDK seals them in source/query-bound cursors.
  const offset = Number(input.cursor ?? 0);
  const end = offset + (input.limit ?? 1);
  return {
    items: items.slice(offset, end), observedAt, consistency: 'snapshot', coverage,
    ...(end < items.length ? { nextCursor: String(end) } : {}),
  };
}

/** Uses no native SDK, execution provider, filesystem, network or credentials. */
export function createFixtureHistory(): AgentHistory {
  const driver: AgentHistoryDriver = {
    catalog: {
      status: 'supported', descriptor: { filters: [], orders: ['native'], pagination: 'cursor' },
      list: async (input, context) => {
        context.signal.throwIfAborted();
        return page(conversations, input, { view: 'catalog', children: 'included', omissions: [] });
      },
    },
    lookup: {
      status: 'supported', descriptor: { semantics: 'native_lookup' },
      get: async (input, context) => {
        context.signal.throwIfAborted();
        const conversation = conversations.find((item) => item.ref.conversationId === input.conversation.conversationId);
        if (!conversation) throw new AgentHistoryError('not_found', 'Synthetic conversation not found.');
        return conversation;
      },
    },
    transcript: {
      status: 'supported', descriptor: { views: ['main'], pagination: 'cursor' },
      read: async (input, context) => {
        context.signal.throwIfAborted();
        if (!conversations.some((item) => item.ref.conversationId === input.conversation.conversationId)) {
          throw new AgentHistoryError('not_found', 'Synthetic conversation not found.');
        }
        return page(input.conversation.conversationId === FIXTURE_SELECTED_CONVERSATION_ID ? releaseRecords : [], input, transcriptCoverage);
      },
    },
    views: unavailable, metadataSearch: unavailable, contentSearch: unavailable,
    rename: unavailable, archive: unavailable, restore: unavailable, delete: unavailable,
  };
  return createAgentHistory({ source, driver });
}
