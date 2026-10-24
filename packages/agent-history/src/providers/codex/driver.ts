import type { AgentHistoryDriver, AgentHistorySource, AgentHistoryUnsupportedReason } from '../../contracts/index.js';
import type { CodexHistoryAccess, CodexHistoryMappingOptions } from './contracts.js';
import { codexRequester } from './native.js';
import { listCodexThreads, readCodexThread, searchCodexThreads, summarizeCodexThread } from './session.js';
import { readCodexTranscript } from './transcript.js';
import { codexMutations } from './mutations.js';

export function codexDriver(source: AgentHistorySource, options: CodexHistoryMappingOptions,
  access: CodexHistoryAccess, dispose?: () => Promise<void>): AgentHistoryDriver {
  const unsupported = (message: string) => ({ status: 'unsupported' as const,
    reason: { code: 'unqualified', message } satisfies AgentHistoryUnsupportedReason });
  return {
    catalog: { status: 'supported', descriptor: { filters: ['projectPath', 'archived', 'sourceKinds'],
      orders: ['native', 'created_asc', 'created_desc', 'updated_asc', 'updated_desc'], pagination: 'cursor' },
    list: (input, context) => access.run((connection) => listCodexThreads(codexRequester(connection, context), source, options, input), context.signal) },
    lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' },
      get: (input, context) => access.run(async (connection) => summarizeCodexThread(
        await readCodexThread(codexRequester(connection, context), source, input.conversation.conversationId), source), context.signal) },
    transcript: { status: 'supported', descriptor: { views: ['main'], pagination: 'cursor' },
      read: (input, context) => access.run((connection) => readCodexTranscript(codexRequester(connection, context), source, input, options.pageBytes), context.signal) },
    views: unsupported('Codex has no qualified named transcript view discovery.'),
    metadataSearch: { status: 'supported', descriptor: { syntax: 'literal', caseSensitivity: 'sensitive', scope: 'title', ranking: 'chronological',
      filters: ['projectPath', 'archived', 'sourceKinds'], orders: ['native', 'created_asc', 'created_desc', 'updated_asc', 'updated_desc'] },
      search: (input, context) => access.run((connection) => searchCodexThreads(codexRequester(connection, context), source, options, input), context.signal) },
    contentSearch: unsupported('Codex history content search is not admitted by this reader.'),
    ...codexMutations(source, access),
    ...(dispose === undefined ? {} : { dispose }),
  };
}
