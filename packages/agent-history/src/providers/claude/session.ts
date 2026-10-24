import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import type {
  AgentHistoryCatalogPage, AgentHistoryConversationSummary, AgentHistoryListInput,
  AgentHistorySource,
} from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryCatalogPage, parseAgentHistoryConversationSummary } from '../../validation/parse.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { AgentHistoryValidationError } from '../../validation/errors.js';
import { claudeCatalogContinuation, parseClaudeCatalogContinuation } from './continuation.js';
import { CLAUDE_CURSOR_RESERVE_BYTES } from './worker/protocol.js';

export interface ClaudeHistorySdk {
  renameSession(sessionId: string, title: string, options: Readonly<{ dir?: string }>): Promise<unknown>;
  deleteSession(sessionId: string, options: Readonly<{ dir?: string }>): Promise<unknown>;
  listSessions(options: Readonly<{ dir?: string; limit: number; offset: number; includeWorktrees: boolean; includeProgrammatic: boolean }>): Promise<unknown>;
  getSessionInfo(sessionId: string, options: Readonly<{ dir?: string }>): Promise<unknown>;
  getSessionMessages(sessionId: string, options: Readonly<{ dir?: string; limit: number; offset: number; includeSystemMessages: true }>): Promise<unknown>;
}

const epoch = z.number().int().min(0).max(8_640_000_000_000_000);
const nativeSession = z.object({
  sessionId: z.string().uuid(), summary: z.string(), lastModified: epoch,
  customTitle: z.string().optional(), cwd: z.string().optional(), createdAt: epoch.optional(),
});
type ClaudeSession = z.infer<typeof nativeSession>;

export function captureClaudeNative(value: unknown): unknown {
  try { return captureHistoryData(value); }
  catch (error) {
    if (error instanceof AgentHistoryValidationError && error.issues.some((issue) => /_limit$/u.test(issue.code))) {
      throw new AgentHistoryError('limit_exhausted', 'Claude native history record exceeds the supported ingress bounds.');
    }
    throw new AgentHistoryError('native_failure', 'Claude returned invalid native history data.');
  }
}

function parseSession(value: unknown): ClaudeSession {
  const result = nativeSession.safeParse(captureClaudeNative(value));
  if (!result.success) throw new AgentHistoryError('native_failure', 'Claude returned invalid session metadata.');
  return result.data;
}

export function claudeProjectOptions(source: AgentHistorySource): Readonly<{ dir?: string }> {
  return source.scope.kind === 'project' ? { dir: source.scope.projectPath } : {};
}

async function assertSessionScope(session: ClaudeSession, source: AgentHistorySource): Promise<void> {
  if (source.scope.kind !== 'project' || source.scope.worktrees !== 'excluded') return;
  let project: string | undefined;
  if (session.cwd && isAbsolute(session.cwd)) {
    try { project = await realpath(session.cwd); } catch { /* A deleted project cannot establish this scope. */ }
  }
  if (project !== source.scope.projectPath) {
    throw new AgentHistoryError('unsupported_scope', 'Claude session metadata cannot establish the selected project-only scope.');
  }
}

async function summarize(session: ClaudeSession, source: AgentHistorySource): Promise<AgentHistoryConversationSummary> {
  await assertSessionScope(session, source);
  const title = session.customTitle ?? session.summary;
  if (title.length > 2000) throw new AgentHistoryError('limit_exhausted', 'Claude session title exceeds its portable bound.');
  try {
    return parseAgentHistoryConversationSummary({
      ref: { source: { providerKey: source.providerKey, sourceId: source.sourceId, generation: source.generation }, conversationId: session.sessionId },
      title, createdAt: session.createdAt === undefined ? undefined : new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.lastModified).toISOString(), projectPath: session.cwd, archiveState: 'unknown',
    });
  } catch (error) {
    if (error instanceof AgentHistoryError) throw error;
    throw new AgentHistoryError('native_failure', 'Claude metadata cannot be represented as a portable session.');
  }
}

export async function lookupClaudeSession(sdk: ClaudeHistorySdk, source: AgentHistorySource, sessionId: string): Promise<AgentHistoryConversationSummary> {
  const result = await sdk.getSessionInfo(sessionId, claudeProjectOptions(source));
  if (result === undefined) throw new AgentHistoryError('not_found', 'Claude session is missing or unavailable through its metadata helper.');
  const session = parseSession(result);
  if (session.sessionId !== sessionId) throw new AgentHistoryError('native_failure', 'Claude returned metadata for another session.');
  return summarize(session, source);
}

export function claudePageBudget(pageBytes: number): number {
  const budget = pageBytes - CLAUDE_CURSOR_RESERVE_BYTES;
  if (budget < 1) throw new AgentHistoryError('limit_exhausted', 'Claude page budget cannot contain its continuation envelope.');
  return budget;
}

export function fitsClaudePage(value: unknown, budget: number): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= budget;
}

export async function listClaudeSessions(sdk: ClaudeHistorySdk, source: AgentHistorySource, includeProgrammatic: boolean,
  input: AgentHistoryListInput, pageBytes: number): Promise<AgentHistoryCatalogPage> {
  if (input.projectPath !== undefined || input.archived !== undefined || input.parent !== undefined || input.sourceKinds !== undefined
    || (input.order !== undefined && input.order !== 'native')) {
    throw new AgentHistoryError('unsupported_scope', 'Claude catalog supports only the configured scope and native order.');
  }
  const offset = parseClaudeCatalogContinuation(input.cursor), limit = input.limit ?? 100;
  const nativeLimit = Math.min(limit + 1, 100);
  const raw = await sdk.listSessions({ ...claudeProjectOptions(source), limit: nativeLimit, offset,
    includeWorktrees: source.scope.kind === 'project' && source.scope.worktrees === 'included', includeProgrammatic });
  const result = z.array(z.unknown()).max(nativeLimit).safeParse(raw);
  if (!result.success) throw new AgentHistoryError('native_failure', 'Claude returned an invalid catalog page.');
  const observedAt = new Date().toISOString(), budget = claudePageBudget(pageBytes);
  const items: AgentHistoryConversationSummary[] = [];
  const page = (nextCursor?: string) => ({ items, observedAt, consistency: 'live',
    coverage: { view: 'catalog', children: 'excluded', omissions: ['subagents_excluded'] }, nextCursor });
  for (const row of result.data) {
    if (items.length === limit) break;
    const summary = await summarize(parseSession(row), source);
    items.push(summary);
    if (!fitsClaudePage(page(claudeCatalogContinuation(offset + items.length)), budget)) {
      items.pop();
      if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'Claude session metadata exceeds the page byte budget.');
      break;
    }
  }
  const nextCursor = items.length < result.data.length || result.data.length === nativeLimit
    ? claudeCatalogContinuation(offset + items.length) : undefined;
  return parseAgentHistoryCatalogPage(page(nextCursor));
}
