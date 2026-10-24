import { z } from 'zod/v4';
import { parseAgentIsoDateTime } from '@agen-ai/agent-protocol';
import type { AgentHistoryCatalogPage, AgentHistoryConversationSummary, AgentHistoryListInput, AgentHistoryPage,
  AgentHistorySearchInput, AgentHistorySearchPage, AgentHistorySource } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { nativePageFits } from '../../pagination/page.js';
import { parseAgentHistoryConversationSummary } from '../../validation/parse.js';
import type { OpenCodeSessionListInput } from './contracts.js';
import { openCodeCatalogContinuation, parseOpenCodeCatalogContinuation } from './continuation.js';
import { openCodePagination, openCodeSession, parseOpenCodeNative, type OpenCodeRequester, type OpenCodeSession } from './native.js';
import type { ResolvedOpenCodeHistoryOptions } from './options.js';

const catalogPage = z.object({ data: z.array(openCodeSession).max(1), cursor: openCodePagination });

function assertScope(session: OpenCodeSession, options: ResolvedOpenCodeHistoryOptions): void {
  if (session.location.directory !== options.scope.projectPath
    || (options.projectID !== undefined && session.projectID !== options.projectID)) {
    throw new AgentHistoryError('unsupported_scope', 'OpenCode session does not belong to the configured exact project scope.');
  }
}

export function summarizeOpenCodeSession(session: OpenCodeSession, source: AgentHistorySource): AgentHistoryConversationSummary {
  const identity = { providerKey: source.providerKey, sourceId: source.sourceId, generation: source.generation };
  try {
    return parseAgentHistoryConversationSummary({ ref: { source: identity, conversationId: session.id }, title: session.title,
      createdAt: new Date(session.time.created).toISOString(), updatedAt: new Date(session.time.updated).toISOString(),
      projectPath: session.location.directory, model: session.model?.id,
      parent: session.parentID === undefined ? undefined : { source: identity, conversationId: session.parentID },
      archiveState: session.time.archived === undefined ? 'not_archived' : 'archived',
    });
  } catch { throw new AgentHistoryError('limit_exhausted', 'OpenCode session metadata exceeds the portable summary bounds.'); }
}

export async function readOpenCodeSession(requester: OpenCodeRequester, options: ResolvedOpenCodeHistoryOptions, id: string): Promise<OpenCodeSession> {
  const session = parseOpenCodeNative(openCodeSession, await requester.session(id));
  if (session.id !== id) throw new AgentHistoryError('native_failure', 'OpenCode returned metadata for another session.');
  assertScope(session, options);
  return session;
}

async function catalogOpenCodeSessions<Item>(requester: OpenCodeRequester, source: AgentHistorySource,
  options: ResolvedOpenCodeHistoryOptions, input: AgentHistoryListInput, mapSummary: (summary: AgentHistoryConversationSummary) => Item,
  search?: string): Promise<AgentHistoryPage<Item>> {
  if (input.projectPath !== undefined && input.projectPath !== options.scope.projectPath) {
    throw new AgentHistoryError('unsupported_scope', 'OpenCode catalog filters cannot widen the configured exact directory.');
  }
  let cursor = parseOpenCodeCatalogContinuation(input.cursor);
  const items: Item[] = [], observedAt = parseAgentIsoDateTime(new Date().toISOString());
  const page = (next?: string): AgentHistoryPage<Item> => ({ items, observedAt, consistency: 'live',
    coverage: { view: 'catalog', children: 'unknown', omissions: ['provider_omission'] },
    ...(next === undefined ? {} : { nextCursor: openCodeCatalogContinuation(next) }) });
  for (let count = 0; count < 8; count += 1) {
    const before = cursor;
    const request: OpenCodeSessionListInput = cursor === undefined ? { limit: 1,
      order: input.order === 'updated_asc' ? 'asc' : 'desc', directory: options.scope.projectPath,
      ...(options.projectID === undefined ? {} : { project: options.projectID }),
      ...(search === undefined ? {} : { search }),
      ...(input.parent === undefined ? {} : { parentID: input.parent.conversationId }),
      ...(input.archived === 'only' ? { archived: true } : input.archived === 'exclude' ? { archived: false } : {}),
    } : { limit: 1, cursor };
    const result = parseOpenCodeNative(catalogPage, await requester.sessions(request));
    if (result.cursor.next !== undefined && result.cursor.next === before) {
      throw new AgentHistoryError('native_failure', 'OpenCode catalog did not advance its native cursor.');
    }
    for (const session of result.data) {
      assertScope(session, options);
      if ((input.parent !== undefined && session.parentID !== input.parent.conversationId)
        || (input.archived === 'only' && session.time.archived === undefined)
        || (input.archived === 'exclude' && session.time.archived !== undefined)) {
        throw new AgentHistoryError('native_failure', 'OpenCode returned a session outside the requested catalog filters.');
      }
      items.push(mapSummary(summarizeOpenCodeSession(session, source)));
      const candidate = page(result.cursor.next);
      if (!nativePageFits(candidate, options.limits.pageBytes, candidate.nextCursor)) {
        items.pop();
        if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'OpenCode session metadata exceeds its page byte budget.');
        return page(before);
      }
    }
    cursor = result.cursor.next;
    if (cursor === undefined || items.length >= (input.limit ?? 100)) return page(cursor);
  }
  return page(cursor);
}

export function listOpenCodeSessions(requester: OpenCodeRequester, source: AgentHistorySource,
  options: ResolvedOpenCodeHistoryOptions, input: AgentHistoryListInput): Promise<AgentHistoryCatalogPage> {
  return catalogOpenCodeSessions(requester, source, options, input, (summary) => summary);
}

export function searchOpenCodeSessions(requester: OpenCodeRequester, source: AgentHistorySource,
  options: ResolvedOpenCodeHistoryOptions, input: AgentHistorySearchInput): Promise<AgentHistorySearchPage> {
  return catalogOpenCodeSessions(requester, source, options, input, (conversation) => ({ conversation }), input.query);
}
