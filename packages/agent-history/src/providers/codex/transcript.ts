import { z } from 'zod/v4';
import type { AgentHistoryOmission, AgentHistoryReadInput, AgentHistoryRecord, AgentHistorySource, AgentHistoryTranscriptPage } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { nativePageFits } from '../../pagination/page.js';
import { parseAgentHistoryTranscriptPage } from '../../validation/parse.js';
import { normalizeCodexItem } from './content.js';
import { codexTranscriptContinuation, parseCodexTranscriptContinuation, type CodexTranscriptContinuation } from './continuation.js';
import { codexCursor, codexId, codexItemSchema, parseCodexNative, type CodexNativeItem, type CodexRequester } from './native.js';
import { readCodexThread } from './session.js';

const turnsPage = z.object({ data: z.array(z.object({ id: codexId,
  itemsView: z.literal('full'), items: z.array(codexItemSchema).max(1000) })).max(1), nextCursor: codexCursor.nullable() });
const itemsPage = z.object({ data: z.array(z.object({ turnId: codexId, item: codexItemSchema,
  startedAtMs: z.number().finite().min(0).max(8_640_000_000_000_000).nullable().optional() })).max(1), nextCursor: codexCursor.nullable() });

function omissions(items: readonly AgentHistoryRecord[]): readonly AgentHistoryOmission[] {
  const result: AgentHistoryOmission[] = ['native_retention', 'subagents_excluded'];
  if (items.some((item) => item.kind === 'compaction')) result.push('compacted');
  if (items.some((item) => item.kind === 'notice' && item.code === 'codex.unsupported_record_kind')) result.push('unsupported_record_kind');
  if (items.some((item) => (item.kind === 'message' || item.kind === 'tool_result') && item.content.some((entry) => entry.kind === 'omission'))) result.push('unsupported_content');
  return result;
}

function changed(): never {
  throw new AgentHistoryError('invalid_cursor', 'Codex retained history no longer matches the continued mode, turn or item.');
}

interface NativePosition {
  readonly turnId: string;
  readonly item: CodexNativeItem;
  readonly startedAtMs?: number | null;
  readonly before: CodexTranscriptContinuation;
  readonly after: CodexTranscriptContinuation | undefined;
}

interface NativeBatch {
  readonly entries: Iterable<NativePosition>;
  readonly next: CodexTranscriptContinuation | undefined;
}

function continuedItem(position: CodexTranscriptContinuation, turnId: string, itemId: string): void {
  if ((position.turnId !== undefined && position.turnId !== turnId)
    || (position.itemId !== undefined && position.itemId !== itemId)) changed();
}

async function legacyItems(requester: CodexRequester, threadId: string,
  position: Extract<CodexTranscriptContinuation, { mode: 'legacy' }>): Promise<NativeBatch> {
  const response = parseCodexNative(turnsPage, await requester.call({ method: 'thread/turns/list', params: {
    threadId, limit: 1, sortDirection: 'asc', itemsView: 'full', ...(position.cursor === undefined ? {} : { cursor: position.cursor }),
  } }));
  if (response.nextCursor !== null && response.nextCursor === position.cursor) throw new AgentHistoryError('native_failure', 'Codex turn traversal did not advance.');
  const next: CodexTranscriptContinuation | undefined = response.nextCursor === null ? undefined
    : { version: 1, mode: 'legacy', cursor: response.nextCursor, itemIndex: 0, recordPart: 0 };
  const turn = response.data[0];
  if (turn === undefined) {
    if (position.turnId !== undefined || position.itemId !== undefined || position.itemIndex > 0 || position.recordPart > 0) changed();
    return { entries: [], next };
  }
  if (position.turnId !== undefined && position.turnId !== turn.id) changed();
  if (position.itemIndex > turn.items.length || (position.itemId !== undefined && turn.items[position.itemIndex]?.id !== position.itemId)) changed();
  function* entries(): Generator<NativePosition> {
    for (let index = position.itemIndex; index < turn.items.length; index += 1) {
      const item = turn.items[index];
      if (item === undefined) throw new AgentHistoryError('native_failure', 'Codex returned a sparse turn item list.');
      const following = turn.items[index + 1];
      yield { turnId: turn.id, item,
        before: { version: 1, mode: 'legacy', cursor: position.cursor, turnId: turn.id, itemIndex: index,
          itemId: item.id, recordPart: index === position.itemIndex ? position.recordPart : 0 },
        after: following === undefined ? next : { version: 1, mode: 'legacy', cursor: position.cursor,
          turnId: turn.id, itemIndex: index + 1, itemId: following.id, recordPart: 0 },
      };
    }
  }
  return { entries: entries(), next };
}

async function indexedItems(requester: CodexRequester, threadId: string,
  position: Extract<CodexTranscriptContinuation, { mode: 'paginated' }>): Promise<NativeBatch> {
  const response = parseCodexNative(itemsPage, await requester.call({ method: 'thread/items/list', params: {
    threadId, limit: 1, sortDirection: 'asc', ...(position.cursor === undefined ? {} : { cursor: position.cursor }),
  } }));
  if (response.nextCursor !== null && response.nextCursor === position.cursor) throw new AgentHistoryError('native_failure', 'Codex item traversal did not advance.');
  const next: CodexTranscriptContinuation | undefined = response.nextCursor === null ? undefined
    : { version: 1, mode: 'paginated', cursor: response.nextCursor, recordPart: 0 };
  const entry = response.data[0];
  if (entry === undefined) {
    if (position.turnId !== undefined || position.itemId !== undefined || position.recordPart > 0) changed();
    return { entries: [], next };
  }
  continuedItem(position, entry.turnId, entry.item.id);
  return { entries: [{ turnId: entry.turnId, item: entry.item, ...(entry.startedAtMs === undefined ? {} : { startedAtMs: entry.startedAtMs }),
    before: { ...position, turnId: entry.turnId, itemId: entry.item.id }, after: next }], next };
}

export async function readCodexTranscript(requester: CodexRequester, source: AgentHistorySource,
  input: AgentHistoryReadInput, pageBytes: number): Promise<AgentHistoryTranscriptPage> {
  if (input.view !== undefined && input.view.kind !== 'main') throw new AgentHistoryError('unsupported_scope', 'Codex history currently exposes only the main transcript.');
  const continuation = parseCodexTranscriptContinuation(input.cursor), threadId = input.conversation.conversationId;
  const metadata = await readCodexThread(requester, source, threadId);
  if (continuation !== undefined && continuation.mode !== metadata.historyMode) changed();
  let position: CodexTranscriptContinuation | undefined = continuation ?? (metadata.historyMode === 'legacy'
    ? { version: 1, mode: 'legacy', itemIndex: 0, recordPart: 0 }
    : { version: 1, mode: 'paginated', recordPart: 0 });
  const items: AgentHistoryRecord[] = [], observedAt = new Date().toISOString();
  const page = (next?: CodexTranscriptContinuation) => ({ items, observedAt, consistency: 'live',
    coverage: { view: 'retained_chain', children: 'excluded', omissions: omissions(items) },
    nextCursor: next === undefined ? undefined : codexTranscriptContinuation(next) });
  let stopped = false;
  for (let call = 0; call < 6 && position !== undefined && !stopped; call += 1) {
    const batch: NativeBatch = position.mode === 'legacy' ? await legacyItems(requester, threadId, position)
      : await indexedItems(requester, threadId, position);
    for (const entry of batch.entries) {
      if (items.length >= (input.limit ?? 100)) { position = entry.before; stopped = true; break; }
      const records = normalizeCodexItem(entry.item, entry.turnId, entry.startedAtMs);
      const start = entry.before.recordPart;
      if (start >= records.length) changed();
      for (let part = start; part < records.length; part += 1) {
        const record = records[part];
        if (record === undefined) throw new AgentHistoryError('native_failure', 'Codex item normalization did not produce a record.');
        const before = { ...entry.before, recordPart: part };
        if (items.length >= (input.limit ?? 100)) { position = before; stopped = true; break; }
        const after = part + 1 < records.length ? { ...entry.before, recordPart: part + 1 } : entry.after;
        items.push(record);
        const candidate = page(after);
        if (!nativePageFits(candidate, pageBytes, candidate.nextCursor)) {
          items.pop();
          if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'Codex transcript record exceeds its page byte budget.');
          position = before; stopped = true; break;
        }
        position = after;
      }
      if (stopped) break;
    }
    if (!stopped) position = batch.next;
    if (items.length >= (input.limit ?? 100)) stopped = true;
  }
  const after = await readCodexThread(requester, source, threadId);
  if (after.historyMode !== metadata.historyMode) changed();
  return parseAgentHistoryTranscriptPage(page(position));
}
