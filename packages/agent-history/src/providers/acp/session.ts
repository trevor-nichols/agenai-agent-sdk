import type { AgentHistoryCatalogPage, AgentHistoryConversationSummary, AgentHistoryListInput, AgentHistorySource } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { queryDigest } from '../../pagination/cursor.js';
import { nativePageFits } from '../../pagination/page.js';
import { parseAgentHistoryCatalogPage, parseAgentHistoryConversationSummary } from '../../validation/parse.js';
import type { AcpHistoryConnection } from './contracts.js';
import { acpHistoryPosition, encodeAcpHistoryPosition, type AcpHistoryPosition } from './continuation.js';
import { AcpHistoryDirectorySchema, parseAcpHistoryList } from './native.js';

const MAX_NATIVE_READS = 8;

export async function listAcpHistorySessions(connection: AcpHistoryConnection, source: AgentHistorySource,
  input: AgentHistoryListInput, pageBytes: number, timeoutMs: number, signal: AbortSignal,
  nativeReadBudget = MAX_NATIVE_READS, projectItem?: (summary: AgentHistoryConversationSummary) => unknown): Promise<AgentHistoryCatalogPage> {
  if (input.archived !== undefined || input.parent !== undefined || input.sourceKinds !== undefined
    || (input.order !== undefined && input.order !== 'native')) throw new AgentHistoryError('unsupported_scope', 'Generic ACP discovery supports only project filtering and native order.');
  const cwd = input.projectPath ?? (source.scope.kind === 'project' ? source.scope.projectPath : undefined);
  if ((cwd !== undefined && !AcpHistoryDirectorySchema.safeParse(cwd).success)
    || (source.scope.kind === 'project' && cwd !== source.scope.projectPath)) throw new AgentHistoryError('unsupported_scope', 'ACP discovery cannot widen or change the configured project scope.');
  let position = acpHistoryPosition(input.cursor);
  const items: AgentHistoryConversationSummary[] = [], seen = new Set<string | undefined>();
  const observedAt = new Date().toISOString(), limit = input.limit ?? 100;
  const makePage = (next?: AcpHistoryPosition) => ({ items,
    ...(next === undefined ? {} : { nextCursor: encodeAcpHistoryPosition(next) }), observedAt, consistency: 'live',
    coverage: { view: 'catalog', children: 'unknown', omissions: ['provider_omission'] },
  });
  const fits = (page: ReturnType<typeof makePage>) => nativePageFits(projectItem === undefined ? page
    : { ...page, items: page.items.map(projectItem) }, pageBytes, page.nextCursor);
  const finish = (next?: AcpHistoryPosition): AgentHistoryCatalogPage => {
    const page = makePage(next);
    if (!fits(page)) throw new AgentHistoryError('limit_exhausted', 'ACP catalog page exceeds its output budget.');
    return parseAgentHistoryCatalogPage(page);
  };
  for (let reads = 0; reads < nativeReadBudget; reads += 1) {
    signal.throwIfAborted();
    if (seen.has(position.cursor)) throw new AgentHistoryError('native_failure', 'The ACP peer repeated a catalog page cursor.');
    seen.add(position.cursor);
    const native = parseAcpHistoryList(await connection.listSessions({ ...(cwd === undefined ? {} : { cwd }),
      ...(position.cursor === undefined ? {} : { cursor: position.cursor }) }, { signal, timeoutMs }));
    const fingerprint = queryDigest(native);
    if ((position.fingerprint !== undefined && position.fingerprint !== fingerprint) || position.offset > native.sessions.length) {
      throw new AgentHistoryError('invalid_cursor', 'The ACP native catalog page changed during traversal.');
    }
    const next = native.nextCursor == null ? undefined : native.nextCursor;
    if (next !== undefined && next === position.cursor) throw new AgentHistoryError('native_failure', 'The ACP peer did not advance its catalog cursor.');
    for (let index = position.offset; index < native.sessions.length; index += 1) {
      const current = { ...position, offset: index, fingerprint };
      if (items.length === limit) return finish(current);
      const row = native.sessions[index];
      if (row === undefined) throw new AgentHistoryError('native_failure', 'The ACP native catalog contains an invalid session.');
      if (cwd !== undefined && row.cwd !== cwd) throw new AgentHistoryError('unsupported_scope', 'The ACP peer returned a session outside the requested project.');
      const summary = parseAgentHistoryConversationSummary({
        ref: { source: { providerKey: source.providerKey, sourceId: source.sourceId, generation: source.generation }, conversationId: row.sessionId },
        ...(row.title == null ? {} : { title: row.title }), ...(row.updatedAt == null ? {} : { updatedAt: row.updatedAt }),
        projectPath: row.cwd, archiveState: 'unknown',
      });
      const following = index + 1 < native.sessions.length ? { ...current, offset: index + 1 }
        : next === undefined ? undefined : { version: 1 as const, cursor: next, offset: 0 };
      items.push(summary);
      const page = makePage(following);
      if (!fits(page)) {
        items.pop();
        if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'One ACP catalog record exceeds the output budget.');
        return finish(current);
      }
      if (items.length === limit) return finish(following);
    }
    if (next === undefined) return finish();
    position = { version: 1, cursor: next, offset: 0 };
  }
  return finish(position);
}
