import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { AgentHistoryOmission, AgentHistoryReadInput, AgentHistoryRecord, AgentHistoryTranscriptPage } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { nativePageFits } from '../../pagination/page.js';
import { parseAgentHistoryTranscriptPage } from '../../validation/parse.js';
import { normalizeOpenCodeMessage } from './content.js';
import { openCodeTranscriptContinuation, parseOpenCodeTranscriptContinuation, type OpenCodeTranscriptContinuation } from './continuation.js';
import { openCodeMessage, openCodePagination, parseOpenCodeNative, type OpenCodeRequester } from './native.js';
import type { ResolvedOpenCodeHistoryOptions } from './options.js';
import { readOpenCodeSession } from './session.js';

const nativePage = z.object({ data: z.array(openCodeMessage).max(1), cursor: openCodePagination });
type OpenCodeMessagePage = z.infer<typeof nativePage>;

function omissions(items: readonly AgentHistoryRecord[], filtered: boolean): readonly AgentHistoryOmission[] {
  const result = new Set<AgentHistoryOmission>(['native_retention', 'subagents_excluded']);
  if (filtered) result.add('provider_omission');
  for (const item of items) {
    if (item.kind === 'compaction') result.add('compacted');
    if (item.kind === 'notice' && item.code === 'opencode.unsupported_record_kind') result.add('unsupported_record_kind');
    if (item.kind === 'message' || item.kind === 'tool_result') {
      for (const content of item.content) if (content.kind === 'omission') result.add(content.reason);
    }
  }
  return [...result];
}

function changed(): never {
  throw new AgentHistoryError('invalid_cursor', 'OpenCode retained message no longer matches its continuation.');
}

export async function readOpenCodeTranscript(requester: OpenCodeRequester, options: ResolvedOpenCodeHistoryOptions,
  input: AgentHistoryReadInput): Promise<AgentHistoryTranscriptPage> {
  const sessionID = input.conversation.conversationId;
  await readOpenCodeSession(requester, options, sessionID);
  let position: OpenCodeTranscriptContinuation | undefined = parseOpenCodeTranscriptContinuation(input.cursor)
    ?? { version: 1, kind: 'transcript', part: 0 };
  const items: AgentHistoryRecord[] = [], observedAt = new Date().toISOString();
  const page = (next?: OpenCodeTranscriptContinuation) => ({ items, observedAt, consistency: 'live',
    coverage: { view: 'retained_chain', children: 'excluded', omissions: omissions(items, options.messageType !== undefined) },
    nextCursor: next === undefined ? undefined : openCodeTranscriptContinuation(next) });
  for (let count = 0; count < 6 && position !== undefined && items.length < (input.limit ?? 100); count += 1) {
    const before = position;
    const result: OpenCodeMessagePage = parseOpenCodeNative(nativePage, await requester.messages({ sessionID, limit: 1,
      ...(position.cursor === undefined ? { order: 'asc' } : { cursor: position.cursor }),
      ...(options.messageType === undefined ? {} : { type: options.messageType }),
    }));
    if (result.cursor.next !== undefined && result.cursor.next === position.cursor) {
      throw new AgentHistoryError('native_failure', 'OpenCode message traversal did not advance its native cursor.');
    }
    const message = result.data[0];
    const after: OpenCodeTranscriptContinuation | undefined = result.cursor.next === undefined ? undefined
      : { version: 1, kind: 'transcript', cursor: result.cursor.next, part: 0 };
    if (message === undefined) {
      if (position.messageID !== undefined || position.part > 0) changed();
      position = after;
      continue;
    }
    if (options.messageType !== undefined && message.type !== options.messageType) {
      throw new AgentHistoryError('native_failure', 'OpenCode returned a message outside the selected native type filter.');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    if ((position.messageID !== undefined && position.messageID !== message.id)
      || (position.fingerprint !== undefined && position.fingerprint !== fingerprint)) changed();
    const records = normalizeOpenCodeMessage(message);
    if (position.part >= records.length) changed();
    let stopped = false;
    for (let part = position.part; part < records.length; part += 1) {
      const record = records[part];
      if (record === undefined) throw new AgentHistoryError('native_failure', 'OpenCode message normalization produced a sparse result.');
      const current: OpenCodeTranscriptContinuation = { ...before, messageID: message.id, fingerprint, part };
      if (items.length >= (input.limit ?? 100)) { position = current; stopped = true; break; }
      const next = part + 1 < records.length ? { ...current, part: part + 1 } : after;
      items.push(record);
      const candidate = page(next);
      if (!nativePageFits(candidate, options.limits.pageBytes, candidate.nextCursor)) {
        items.pop();
        if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'OpenCode transcript record exceeds its page byte budget.');
        position = current; stopped = true; break;
      }
      position = next;
    }
    if (stopped) break;
    position = after;
  }
  await readOpenCodeSession(requester, options, sessionID);
  return parseAgentHistoryTranscriptPage(page(position));
}
