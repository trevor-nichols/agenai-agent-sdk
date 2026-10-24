import type {
  AgentHistoryCatalogPage, AgentHistoryConversationSummary, AgentHistoryListInput, AgentHistorySource,
  AgentHistoryViewListInput, AgentHistoryViewPage, AgentHistoryViewSummary,
} from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { nativePageFits } from '../../pagination/page.js';
import { parseAgentHistoryCatalogPage, parseAgentHistoryConversationSummary, parseAgentHistoryViewPage, parseAgentHistoryViewSummary } from '../../validation/parse.js';
import { encodeCursorCatalog, nativeCatalogCursor } from './continuation.js';
import { agentDocument, agentInfo, parseCursorNative, parseCursorNativePage, runInfo, type CursorHistorySdk } from './native.js';
import { cursorNativeId } from './worker/protocol.js';

const MAX_NATIVE_CATALOG_READS = 8;

function project(source: AgentHistorySource): string {
  if (source.scope.kind !== 'project') throw new AgentHistoryError('unsupported_scope', 'Cursor local history requires one explicit project.');
  return source.scope.projectPath;
}

function summary(source: AgentHistorySource, value: unknown): AgentHistoryConversationSummary {
  const native = parseCursorNative(agentInfo, value);
  if (native.cwd !== project(source)) throw new AgentHistoryError('unsupported_scope', 'Cursor agent is outside the configured project.');
  if (native.agentId.startsWith('bc-')) throw new AgentHistoryError('native_failure', 'The local Cursor store contains an unsupported cloud agent identifier.');
  return parseAgentHistoryConversationSummary({
    ref: { source: { providerKey: source.providerKey, sourceId: source.sourceId, generation: source.generation }, conversationId: native.agentId },
    ...(native.name === '' ? {} : { title: native.name }),
    ...(native.createdAt === undefined ? {} : { createdAt: new Date(native.createdAt).toISOString() }),
    updatedAt: new Date(native.lastModified).toISOString(), projectPath: native.cwd,
    archiveState: native.archived === undefined ? 'unknown' : native.archived ? 'archived' : 'not_archived',
  });
}

export async function scopedCursorAgent(sdk: CursorHistorySdk, source: AgentHistorySource, id: string) {
  if (!cursorNativeId.safeParse(id).success || id.startsWith('bc-')) throw new AgentHistoryError('invalid_input', 'Cursor local history requires a native local agent ID.');
  const raw = await sdk.agentDocument(id);
  if (raw === null) throw new AgentHistoryError('not_found', 'The Cursor local agent is missing.');
  const document = parseCursorNative(agentDocument, raw);
  if (document.agentId !== id) throw new AgentHistoryError('native_failure', 'Cursor returned metadata for another agent.');
  if (document.cwd !== project(source)) throw new AgentHistoryError('unsupported_scope', 'Cursor agent is outside the configured project.');
  return document;
}

export async function lookupCursorAgent(sdk: CursorHistorySdk, source: AgentHistorySource, id: string): Promise<AgentHistoryConversationSummary> {
  await scopedCursorAgent(sdk, source, id);
  const result = summary(source, await sdk.getAgent(id));
  if (result.ref.conversationId !== id) throw new AgentHistoryError('native_failure', 'Cursor returned metadata for another agent.');
  return result;
}

export async function listCursorAgents(sdk: CursorHistorySdk, source: AgentHistorySource, input: AgentHistoryListInput, bytes: number): Promise<AgentHistoryCatalogPage> {
  if (input.projectPath !== undefined && input.projectPath !== project(source)) throw new AgentHistoryError('unsupported_scope', 'Cursor catalog cannot widen its project scope.');
  if (input.archived !== undefined || input.parent !== undefined || input.sourceKinds !== undefined
    || (input.order !== undefined && input.order !== 'native')) throw new AgentHistoryError('unsupported_scope', 'Cursor local catalog supports only its native project order.');
  let cursor = nativeCatalogCursor(input.cursor, 'catalog');
  const items: AgentHistoryConversationSummary[] = [];
  const observedAt = new Date().toISOString();
  const makePage = (next: string | undefined) => parseAgentHistoryCatalogPage({ items,
    ...(next === undefined ? {} : { nextCursor: encodeCursorCatalog(next, 'catalog') }), observedAt, consistency: 'live',
    coverage: { view: 'catalog', children: 'unknown', omissions: ['provider_omission'] } });
  for (let reads = 0; reads < MAX_NATIVE_CATALOG_READS; reads += 1) {
    const before = cursor;
    const native = parseCursorNativePage(await sdk.listAgents({ limit: 1, ...(cursor === undefined ? {} : { cursor }) }));
    if (native.nextCursor === before && native.nextCursor !== undefined) throw new AgentHistoryError('native_failure', 'Cursor catalog did not advance.');
    const row = native.items[0];
    if (row !== undefined) {
      items.push(summary(source, row));
      const candidate = makePage(native.nextCursor);
      if (!nativePageFits(candidate, bytes, candidate.nextCursor)) {
        items.pop();
        if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'One Cursor catalog record exceeds the page budget.');
        return makePage(before);
      }
    }
    cursor = native.nextCursor;
    if (cursor === undefined || items.length >= (input.limit ?? 100)) return makePage(cursor);
  }
  return makePage(cursor);
}

export async function listCursorViews(sdk: CursorHistorySdk, source: AgentHistorySource, input: AgentHistoryViewListInput, bytes: number): Promise<AgentHistoryViewPage> {
  if (input.kind !== 'run') throw new AgentHistoryError('unsupported_scope', 'Cursor local history exposes terminal run views only.');
  const agentId = input.conversation.conversationId;
  await scopedCursorAgent(sdk, source, agentId);
  let cursor = nativeCatalogCursor(input.cursor, 'views');
  const items: AgentHistoryViewSummary[] = [], observedAt = new Date().toISOString();
  const makePage = (next: string | undefined) => parseAgentHistoryViewPage({ items,
    ...(next === undefined ? {} : { nextCursor: encodeCursorCatalog(next, 'views') }), observedAt, consistency: 'live',
    coverage: { view: 'catalog', children: 'excluded', omissions: ['provider_omission'] } });
  for (let reads = 0; reads < MAX_NATIVE_CATALOG_READS; reads += 1) {
    const before = cursor;
    const native = parseCursorNativePage(await sdk.listRuns(agentId, { limit: 1, ...(cursor === undefined ? {} : { cursor }) }));
    if (native.nextCursor === before && native.nextCursor !== undefined) throw new AgentHistoryError('native_failure', 'Cursor run catalog did not advance.');
    const row = native.items[0];
    if (row !== undefined) {
      const run = parseCursorNative(runInfo, row);
      if (run.agentId !== agentId) throw new AgentHistoryError('native_failure', 'Cursor run belongs to another agent.');
      if (run.status !== 'running') {
        items.push(parseAgentHistoryViewSummary({ view: { kind: 'run', id: run.id },
          ...(run.createdAt === undefined ? {} : { createdAt: new Date(run.createdAt).toISOString() }) }));
        const candidate = makePage(native.nextCursor);
        if (!nativePageFits(candidate, bytes, candidate.nextCursor)) {
          items.pop();
          if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'One Cursor run view exceeds the page budget.');
          return makePage(before);
        }
      }
    }
    cursor = native.nextCursor;
    if (cursor === undefined || items.length >= (input.limit ?? 100)) return makePage(cursor);
  }
  return makePage(cursor);
}
