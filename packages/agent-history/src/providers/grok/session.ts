import type { AgentHistoryConversationRef, AgentHistoryConversationSummary, AgentHistoryListInput, AgentHistorySource } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryConversationSummary } from '../../validation/parse.js';
import { listAcpHistorySessions } from '../acp/session.js';
import type { GrokHistoryConnection } from './contracts.js';
import { GrokListSchema, GrokSessionIdSchema, GrokStateSchema, parseGrokNative } from './native.js';
import { grokRequest } from './request.js';

export function grokProject(source: AgentHistorySource): string {
  if (source.scope.kind !== 'project') throw new AgentHistoryError('unsupported_scope', 'Grok local history requires one explicit project.');
  return source.scope.projectPath;
}
export function assertGrokRef(conversation: AgentHistoryConversationRef): void {
  if (!GrokSessionIdSchema.safeParse(conversation.conversationId).success) throw new AgentHistoryError('invalid_input', 'Grok history requires a native session UUID.');
}
export function assertGrokList(source: AgentHistorySource, input: AgentHistoryListInput): void {
  if ((input.projectPath !== undefined && input.projectPath !== grokProject(source)) || input.archived !== undefined
    || input.parent !== undefined || input.sourceKinds !== undefined || (input.order !== undefined && input.order !== 'native')) {
    throw new AgentHistoryError('unsupported_scope', 'Grok local catalog supports its exact project and native order only.');
  }
}
export async function grokState(connection: GrokHistoryConnection, source: AgentHistorySource,
  id: string, signal: AbortSignal, timeoutMs: number) {
  const state = parseGrokNative(GrokStateSchema, await grokRequest(() => connection.sessionState({ sessionId: id,
    cwd: grokProject(source) }, { signal, timeoutMs }), signal, true));
  if (state.summary.info.id !== id) throw new AgentHistoryError('native_failure', 'Grok returned state for another session.');
  if (state.summary.info.cwd !== grokProject(source)) throw new AgentHistoryError('unsupported_scope', 'The saved Grok session is outside the configured project.');
  return state;
}
export async function lookupGrokSession(connection: GrokHistoryConnection, source: AgentHistorySource,
  id: string, signal: AbortSignal, timeoutMs: number) {
  const { summary } = await grokState(connection, source, id, signal, timeoutMs);
  const identity = { providerKey: source.providerKey, sourceId: source.sourceId, generation: source.generation };
  const title = summary.generated_title || summary.session_summary;
  return parseAgentHistoryConversationSummary({ ref: { source: identity, conversationId: id }, projectPath: summary.info.cwd,
    ...(title == null ? {} : { title }), ...(summary.current_model_id == null ? {} : { model: summary.current_model_id }),
    ...(summary.created_at === undefined ? {} : { createdAt: new Date(summary.created_at).toISOString() }),
    ...(summary.updated_at === undefined ? {} : { updatedAt: new Date(summary.updated_at).toISOString() }),
    ...(summary.parent_session_id == null ? {} : { parent: { source: identity, conversationId: summary.parent_session_id } }), archiveState: 'unknown' });
}
export async function listGrokSessions(connection: GrokHistoryConnection, source: AgentHistorySource,
  input: AgentHistoryListInput, pageBytes: number, signal: AbortSignal, timeoutMs: number, query?: string) {
  const page = await listAcpHistorySessions({ protocolProfile: connection.protocolProfile,
    initialization: connection.initialization, resources: connection.resources,
    listSessions: async (params, options) => parseGrokNative(GrokListSchema, await grokRequest(() => connection.listSessions({
      cwd: grokProject(source), ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      _meta: { 'x.ai/limit': 1, 'x.ai/facetFilters': { kind: 'build' }, ...(query === undefined ? {} : { 'x.ai/query': query }) },
    }, options), signal)),
  }, source, input, pageBytes, timeoutMs, signal, 7, query === undefined ? undefined : (summary: AgentHistoryConversationSummary) => ({ conversation: summary }));
  return { ...page, coverage: { ...page.coverage, children: 'excluded' as const } };
}
