import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod/v4';
import type { AgentHistorySearchHit, AgentHistorySearchInput, AgentHistorySource } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { queryDigest } from '../../pagination/cursor.js';
import { nativePageFits } from '../../pagination/page.js';
import { parseAgentHistorySearchPage } from '../../validation/parse.js';
import { AgentHistorySearchHitSchema } from '../../validation/records.js';
import type { GrokHistoryConnection } from './contracts.js';
import { GrokSearchResponseSchema, parseGrokNative } from './native.js';
import { grokRequest } from './request.js';
import { assertGrokList, grokProject, listGrokSessions } from './session.js';

const searchPosition = z.strictObject({ version: z.literal(1), offset: z.int().min(0).max(1000),
  previous: z.strictObject({ offset: z.int().min(0).max(999), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).optional(),
}).refine((value) => value.offset === 0 || value.previous?.offset === value.offset - 1);

export function assertGrokSearch(source: AgentHistorySource, input: AgentHistorySearchInput): void {
  assertGrokList(source, input);
  if (input.query.trim() === '') throw new AgentHistoryError('invalid_input', 'Grok search requires a nonblank native query.');
}

export async function searchGrokMetadata(connection: GrokHistoryConnection, source: AgentHistorySource,
  input: AgentHistorySearchInput, pageBytes: number, signal: AbortSignal, timeoutMs: number) {
  const page = await listGrokSessions(connection, source, input, pageBytes, signal, timeoutMs, input.query);
  const result = { ...page, items: page.items.map((conversation) => ({ conversation })) };
  if (!nativePageFits(result, pageBytes, result.nextCursor)) throw new AgentHistoryError('limit_exhausted', 'The Grok metadata search page exceeds its output budget.');
  return parseAgentHistorySearchPage(result);
}

export async function searchGrokContent(connection: GrokHistoryConnection, source: AgentHistorySource,
  input: AgentHistorySearchInput, pageBytes: number, signal: AbortSignal, timeoutMs: number) {
  const search = connection.sessionSearch?.bind(connection);
  if (search === undefined) throw new AgentHistoryError('unsupported_scope', 'The supplied Grok connection has no qualified native search method.');
  let position: z.infer<typeof searchPosition> = { version: 1, offset: 0 };
  if (input.cursor !== undefined) {
    try { position = searchPosition.parse(JSON.parse(input.cursor)); }
    catch { throw new AgentHistoryError('invalid_cursor', 'The Grok search continuation is invalid.'); }
  }
  const items: AgentHistorySearchHit[] = [], cwd = grokProject(source), observedAt = new Date().toISOString();
  let calls = 1, totalEstimate: number | undefined, capped = false;
  const fetch = async (offset: number) => {
    while (calls < 8) {
      calls += 1;
      const response = parseGrokNative(GrokSearchResponseSchema, await grokRequest(() => search({ query: input.query,
        cwd, limit: 1, offset, includeContent: true, headless: 'exclude' }, { signal, timeoutMs }), signal));
      if ('error' in response) throw new AgentHistoryError('native_failure', 'The native Grok search index could not complete this query.');
      const page = response.result;
      if (page.results.length > 1 || page.results.some((hit) => hit.cwd !== cwd)) throw new AgentHistoryError('native_failure', 'Grok returned invalid scoped search results.');
      if (page.bootstrapping) { if (calls < 8) await delay(50, undefined, { signal }); continue; }
      if (page.nextOffset !== null && (page.results.length !== 1 || page.nextOffset !== offset + 1)) {
        throw new AgentHistoryError('native_failure', 'Grok returned a non-advancing search window.');
      }
      totalEstimate = page.totalEstimate ?? undefined;
      return page;
    }
    throw new AgentHistoryError('limit_exhausted', 'The native Grok search index is still settling within this operation budget.');
  };
  if (position.previous !== undefined) {
    const page = await fetch(position.previous.offset);
    if (queryDigest({ hit: page.results[0] ?? null }) !== position.previous.fingerprint) throw new AgentHistoryError('invalid_cursor', 'The native ranked Grok search window changed.');
  }
  const makePage = (next?: z.infer<typeof searchPosition>) => ({ items, observedAt, consistency: 'live',
    ...(next === undefined ? {} : { nextCursor: JSON.stringify(next) }), ...(totalEstimate === undefined ? {} : { totalEstimate }),
    coverage: { view: 'catalog', children: 'excluded', omissions: ['native_retention', 'subagents_excluded', 'provider_omission', ...(capped ? ['resource_limit'] : [])] } });
  let next: z.infer<typeof searchPosition> | undefined = position;
  while (calls < 8 && items.length < (input.limit ?? 100)) {
    const page = await fetch(position.offset), hit = page.results[0];
    // A native terminal window without an estimate did not exhaust the classified hit walk.
    const nativeCapped = page.nextOffset === null && page.totalEstimate === null;
    if (hit === undefined) { capped = nativeCapped; next = undefined; break; }
    const following = page.nextOffset === null ? undefined : { version: 1 as const, offset: page.nextOffset,
      previous: { offset: position.offset, fingerprint: queryDigest({ hit }) } };
    capped = (following !== undefined && following.offset > 1000) || nativeCapped;
    items.push(parseGrokNative(AgentHistorySearchHitSchema, { conversation: { ref: { source: { providerKey: source.providerKey,
      sourceId: source.sourceId, generation: source.generation }, conversationId: hit.sessionId }, title: hit.summary,
    projectPath: hit.cwd, updatedAt: new Date(hit.updatedAt).toISOString(), archiveState: 'unknown' }, score: hit.score,
    matchedFields: hit.matchedFields.map((field) => field === 'content' ? 'transcript' : field === 'session_id' ? 'conversation_id' : 'title'),
    ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }) }));
    next = capped ? undefined : following;
    const candidate = makePage(next);
    if (!nativePageFits(candidate, pageBytes, candidate.nextCursor)) {
      items.pop();
      if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'One Grok search result exceeds its output budget.');
      next = position;
      break;
    }
    if (next === undefined) break;
    position = next;
  }
  const result = makePage(next);
  if (!nativePageFits(result, pageBytes, result.nextCursor)) throw new AgentHistoryError('limit_exhausted', 'The Grok search page exceeds its output budget.');
  return parseAgentHistorySearchPage(result);
}
