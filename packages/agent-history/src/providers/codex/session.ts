import { z } from 'zod/v4';
import { parseAgentIsoDateTime } from '@agen-ai/agent-protocol';
import type { AgentHistoryCatalogPage, AgentHistoryConversationSummary, AgentHistoryListInput, AgentHistoryPage,
  AgentHistorySearchInput, AgentHistorySearchPage, AgentHistorySource } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { nativePageFits } from '../../pagination/page.js';
import { parseAgentHistoryConversationSummary } from '../../validation/parse.js';
import type { CodexHistoryMappingOptions, CodexHistoryRequest, CodexHistorySourceKind } from './contracts.js';
import { codexCatalogContinuation, parseCodexCatalogContinuation } from './continuation.js';
import { codexCursor, codexThreadParentId, codexThreadSchema, parseCodexNative, type CodexNativeThread, type CodexRequester } from './native.js';

const catalogPage = z.object({ data: z.array(codexThreadSchema).max(1), nextCursor: codexCursor.nullable() });
const readResponse = z.object({ thread: codexThreadSchema });

function assertProject(thread: CodexNativeThread, source: AgentHistorySource, projectPath?: string): void {
  if ((source.scope.kind === 'project' && thread.cwd !== source.scope.projectPath)
    || (projectPath !== undefined && thread.cwd !== projectPath)) {
    throw new AgentHistoryError('unsupported_scope', 'Codex thread metadata does not match the selected exact project scope.');
  }
}

export function summarizeCodexThread(thread: CodexNativeThread, source: AgentHistorySource,
  archiveState: AgentHistoryConversationSummary['archiveState'] = 'unknown'): AgentHistoryConversationSummary {
  assertProject(thread, source);
  const identity = { providerKey: source.providerKey, sourceId: source.sourceId, generation: source.generation };
  const parentThreadId = codexThreadParentId(thread);
  try {
    return parseAgentHistoryConversationSummary({ ref: { source: identity, conversationId: thread.id },
      title: thread.name ?? thread.preview, createdAt: new Date(thread.createdAt * 1000).toISOString(),
      updatedAt: new Date(thread.updatedAt * 1000).toISOString(), projectPath: thread.cwd,
      model: thread.model ?? undefined, archiveState,
      parent: parentThreadId === undefined ? undefined : { source: identity, conversationId: parentThreadId },
    });
  } catch { throw new AgentHistoryError('limit_exhausted', 'Codex thread metadata cannot fit the portable summary bounds.'); }
}

export async function readCodexThread(requester: CodexRequester, source: AgentHistorySource, threadId: string): Promise<CodexNativeThread> {
  const response = parseCodexNative(readResponse, await requester.call({ method: 'thread/read', params: { threadId, includeTurns: false } }));
  if (response.thread.id !== threadId) throw new AgentHistoryError('native_failure', 'Codex returned metadata for another thread.');
  assertProject(response.thread, source);
  return response.thread;
}

function selectedKinds(options: CodexHistoryMappingOptions, input: AgentHistoryListInput): readonly CodexHistorySourceKind[] {
  if (input.sourceKinds === undefined) return options.sourceKinds;
  const selection = options.sourceKinds.filter((kind) => input.sourceKinds?.includes(kind));
  if (selection.length === 0 || selection.length !== input.sourceKinds.length) {
    throw new AgentHistoryError('unsupported_scope', 'Codex catalog source filters may narrow but cannot expand the configured selection.');
  }
  return selection;
}

function catalogRequest(source: AgentHistorySource, options: CodexHistoryMappingOptions,
  input: AgentHistoryListInput, cursor?: string, searchTerm?: string): Extract<CodexHistoryRequest, { method: 'thread/list' }> {
  if (input.archived === 'include' || input.parent !== undefined) {
    throw new AgentHistoryError('unsupported_scope', 'Codex catalog supports separate active or archived pages and no parent query.');
  }
  if (source.scope.kind === 'project' && input.projectPath !== undefined && input.projectPath !== source.scope.projectPath) {
    throw new AgentHistoryError('unsupported_scope', 'Codex catalog project filter cannot expand the configured exact project.');
  }
  if (input.projectPath !== undefined && !input.projectPath.startsWith('/')) {
    throw new AgentHistoryError('invalid_input', 'Codex catalog requires an absolute exact project path.');
  }
  const order = input.order ?? 'native';
  const sortKey = order.startsWith('updated_') ? 'updated_at' : 'created_at';
  const sortDirection = order.endsWith('_asc') ? 'asc' : 'desc';
  const cwd = source.scope.kind === 'project' ? source.scope.projectPath : input.projectPath;
  return { method: 'thread/list', params: { limit: 1, sortKey, sortDirection, modelProviders: [],
    sourceKinds: selectedKinds(options, input), archived: input.archived === 'only',
    useStateDbOnly: options.catalogPolicy === 'state_db_only',
    ...(cwd === undefined ? {} : { cwd }), ...(cursor === undefined ? {} : { cursor }),
    ...(searchTerm === undefined ? {} : { searchTerm }),
  } };
}

async function catalogCodexThreads<Item>(requester: CodexRequester, source: AgentHistorySource,
  options: CodexHistoryMappingOptions, input: AgentHistoryListInput, mapSummary: (summary: AgentHistoryConversationSummary) => Item,
  searchTerm?: string): Promise<AgentHistoryPage<Item>> {
  let cursor = parseCodexCatalogContinuation(input.cursor);
  const initial = catalogRequest(source, options, input, cursor, searchTerm);
  const observedAt = parseAgentIsoDateTime(new Date().toISOString()), items: Item[] = [];
  const page = (nativeCursor?: string): AgentHistoryPage<Item> => ({ items, observedAt, consistency: 'live',
    coverage: { view: 'catalog', children: 'unknown', omissions: ['provider_omission'] },
    ...(nativeCursor === undefined ? {} : { nextCursor: codexCatalogContinuation(nativeCursor) }) });
  for (let call = 0; call < 8; call += 1) {
    const before = cursor;
    const request = { ...initial, params: { ...initial.params, ...(cursor === undefined ? {} : { cursor }) } };
    const result = parseCodexNative(catalogPage, await requester.call(request));
    if (result.nextCursor !== null && result.nextCursor === before) throw new AgentHistoryError('native_failure', 'Codex catalog did not advance its native cursor.');
    for (const thread of result.data) {
      assertProject(thread, source, input.projectPath);
      items.push(mapSummary(summarizeCodexThread(thread, source, input.archived === 'only' ? 'archived' : 'not_archived')));
      const candidate = page(result.nextCursor ?? undefined);
      if (!nativePageFits(candidate, options.pageBytes, candidate.nextCursor)) {
        items.pop();
        if (items.length === 0 || before === undefined) throw new AgentHistoryError('limit_exhausted', 'Codex catalog record exceeds the page byte budget.');
        return page(before);
      }
    }
    cursor = result.nextCursor ?? undefined;
    if (cursor === undefined || items.length >= (input.limit ?? 100)) return page(cursor);
  }
  return page(cursor);
}

export function listCodexThreads(requester: CodexRequester, source: AgentHistorySource,
  options: CodexHistoryMappingOptions, input: AgentHistoryListInput): Promise<AgentHistoryCatalogPage> {
  return catalogCodexThreads(requester, source, options, input, (summary) => summary);
}

export function searchCodexThreads(requester: CodexRequester, source: AgentHistorySource,
  options: CodexHistoryMappingOptions, input: AgentHistorySearchInput): Promise<AgentHistorySearchPage> {
  return catalogCodexThreads(requester, source, options, input, (conversation) => ({ conversation }), input.query);
}
