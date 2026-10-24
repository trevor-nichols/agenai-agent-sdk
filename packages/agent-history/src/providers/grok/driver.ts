import type { AgentHistoryDriver, AgentHistorySource, AgentHistoryUnsupportedReason } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import type { GrokHistoryAccess, GrokManagementAccess } from './contracts.js';
import { assertGrokList, assertGrokRef, listGrokSessions, lookupGrokSession } from './session.js';
import { readGrokTranscript } from './transcript.js';
import { assertGrokSearch, searchGrokContent, searchGrokMetadata } from './search.js';
import { GROK_LOCAL_EFFECTS, mutateGrokSession } from './management.js';

export function grokDriver(source: AgentHistorySource, access: GrokHistoryAccess, pageBytes: number, timeoutMs: number,
  policy: { readonly contentSearch: boolean; readonly management?: GrokManagementAccess }, dispose?: () => Promise<void>): AgentHistoryDriver {
  const unavailable = (message: string) => ({ status: 'unsupported' as const,
    reason: { code: 'unqualified', message } satisfies AgentHistoryUnsupportedReason });
  const management = policy.management;
  return {
    catalog: { status: 'supported', descriptor: { filters: ['projectPath'], orders: ['native'], pagination: 'cursor' },
      list: (input, context) => {
        assertGrokList(source, input);
        context.markDispatched();
        return access.run((connection) => listGrokSessions(connection, source, input, pageBytes, context.signal, timeoutMs), context.signal);
      } },
    lookup: { status: 'supported', descriptor: { semantics: 'native_lookup' },
      get: (input, context) => {
        assertGrokRef(input.conversation);
        context.markDispatched();
        return access.run((connection) => lookupGrokSession(connection, source, input.conversation.conversationId,
          context.signal, timeoutMs), context.signal);
      } },
    transcript: { status: 'supported', descriptor: { views: ['main'], pagination: 'cursor' },
      read: (input, context) => {
        assertGrokRef(input.conversation);
        if (input.view !== undefined && input.view.kind !== 'main') throw new AgentHistoryError('unsupported_scope', 'Grok history exposes its surviving stored updates only.');
        context.markDispatched();
        return access.run((connection) => readGrokTranscript(connection, source, input, pageBytes, context.signal, timeoutMs), context.signal);
      } },
    views: unavailable('Grok named saved-transcript views are not qualified.'),
    metadataSearch: { status: 'supported', descriptor: { scope: 'metadata', syntax: 'literal', caseSensitivity: 'insensitive',
      ranking: 'chronological', filters: ['projectPath'], orders: ['native'] }, search: (input, context) => {
      assertGrokSearch(source, input);
      context.markDispatched();
      return access.run((connection) => searchGrokMetadata(connection, source, input, pageBytes, context.signal, timeoutMs), context.signal);
    } },
    contentSearch: policy.contentSearch ? { status: 'supported', descriptor: { scope: 'transcript', syntax: 'provider_defined',
      caseSensitivity: 'provider_defined', ranking: 'native', filters: ['projectPath'], orders: ['native'] }, search: (input, context) => {
      assertGrokSearch(source, input);
      context.markDispatched();
      return access.run((connection) => searchGrokContent(connection, source, input, pageBytes, context.signal, timeoutMs), context.signal, 'content-search');
    } } : unavailable('The supplied Grok connection has no qualified named native content-search method.'),
    rename: management === undefined ? unavailable('Borrowed or non-quiescent Grok rename effects are unqualified.')
      : { status: 'supported', descriptor: { effects: GROK_LOCAL_EFFECTS }, apply: (input, context) =>
        mutateGrokSession('rename', access, management, source, input, context, timeoutMs) },
    archive: unavailable('Grok archive effects are not admitted by this reader.'),
    restore: unavailable('Grok restore effects are not admitted by this reader.'),
    delete: management === undefined ? unavailable('Borrowed or non-quiescent Grok deletion effects are unqualified.')
      : { status: 'supported', descriptor: { effects: GROK_LOCAL_EFFECTS }, apply: (input, context) =>
        mutateGrokSession('delete', access, management, source, input, context, timeoutMs) },
    ...(dispose === undefined ? {} : { dispose }),
  };
}
