import type { AgentHistoryOmission, AgentHistoryReadInput, AgentHistoryRecord, AgentHistorySource, AgentHistoryTranscriptPage } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { queryDigest } from '../../pagination/cursor.js';
import { nativePageFits } from '../../pagination/page.js';
import { parseAgentHistoryTranscriptPage } from '../../validation/parse.js';
import { projectGrokUpdate } from './content.js';
import { encodeGrokPosition, grokTranscriptPosition, type GrokTranscriptPosition } from './continuation.js';
import type { GrokHistoryConnection } from './contracts.js';
import { GrokUpdatesSchema, parseGrokNative } from './native.js';
import { grokRequest } from './request.js';
import { grokProject, grokState } from './session.js';

function stateRevision(summary: Awaited<ReturnType<typeof grokState>>['summary']): string {
  // Native state reports the effective GROK_HOME, which is fresh scratch for each owned read.
  const { grok_home: _launchRoot, ...retained } = summary;
  return queryDigest(retained);
}

export async function readGrokTranscript(connection: GrokHistoryConnection, source: AgentHistorySource,
  input: AgentHistoryReadInput, pageBytes: number, signal: AbortSignal, timeoutMs: number): Promise<AgentHistoryTranscriptPage> {
  const id = input.conversation.conversationId, initial = await grokState(connection, source, id, signal, timeoutMs);
  const revision = stateRevision(initial.summary), continued = grokTranscriptPosition(input.cursor, revision);
  let offset = continued?.offset ?? 0, total = continued?.total;
  let previous = continued?.previous;
  // One initialization, initial/final state and a continued-boundary check fit within eight native calls.
  let calls = 3;
  const updates = async (at: number) => {
    calls += 1;
    const page = parseGrokNative(GrokUpdatesSchema, await grokRequest(() => connection.sessionUpdates({ sessionId: id,
      cwd: grokProject(source), offset: at, limit: 1 }, { signal, timeoutMs }), signal));
    if (total !== undefined && page.totalCount !== total) throw new AgentHistoryError('invalid_cursor', 'The surviving Grok transcript changed during traversal.');
    total = page.totalCount;
    if (at > total || page.updates.length !== (at < total ? 1 : 0) || page.hasMore !== (at + page.updates.length < total)) {
      throw new AgentHistoryError('native_failure', 'Grok returned inconsistent stored update pagination.');
    }
    return page;
  };
  if (previous !== undefined) {
    const boundary = await updates(previous.offset), row = boundary.updates[0];
    if (row === undefined || queryDigest({ update: row }) !== previous.fingerprint) throw new AgentHistoryError('invalid_cursor', 'The continued Grok update was replaced or rewound.');
  }
  const items: AgentHistoryRecord[] = [], observedAt = new Date().toISOString();
  const omissions = new Set<AgentHistoryOmission>(['native_retention', 'subagents_excluded', 'provider_omission']);
  const makePage = (next?: GrokTranscriptPosition) => ({ items,
    ...(next === undefined ? {} : { nextCursor: encodeGrokPosition(next) }), observedAt, consistency: 'live',
    coverage: { view: 'stored_updates', children: 'excluded', omissions: [...omissions] } });
  let next: GrokTranscriptPosition | undefined;
  while (calls < 8 && items.length < (input.limit ?? 100)) {
    const page = await updates(offset), row = page.updates[0];
    if (row === undefined) break;
    const projected = projectGrokUpdate(row, id);
    const current: GrokTranscriptPosition = { version: 1, offset, revision, total: page.totalCount,
      ...(previous === undefined ? {} : { previous }) };
    for (const omission of projected.omissions) omissions.add(omission);
    const following: GrokTranscriptPosition | undefined = page.hasMore ? { version: 1, offset: offset + 1, revision, total: page.totalCount,
      previous: { offset, fingerprint: projected.fingerprint } } : undefined;
    items.push(projected.record);
    const candidate = makePage(following);
    if (!nativePageFits(candidate, pageBytes, candidate.nextCursor)) {
      items.pop();
      if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'One stored Grok update exceeds the normalized page budget.');
      next = current;
      break;
    }
    next = following;
    if (!page.hasMore) break;
    previous = { offset, fingerprint: projected.fingerprint };
    offset += 1;
  }
  const after = await grokState(connection, source, id, signal, timeoutMs);
  if (stateRevision(after.summary) !== revision) throw new AgentHistoryError('invalid_cursor', 'The Grok session state changed during its history read.');
  const result = makePage(next);
  if (!nativePageFits(result, pageBytes, result.nextCursor)) throw new AgentHistoryError('limit_exhausted', 'The Grok transcript exceeds the normalized page budget.');
  return parseAgentHistoryTranscriptPage(result);
}
