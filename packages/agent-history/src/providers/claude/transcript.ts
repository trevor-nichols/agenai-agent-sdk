import { z } from 'zod/v4';
import { parseAgentJsonValue, type AgentJsonValue } from '@agen-ai/agent-protocol';
import type {
  AgentHistoryContent, AgentHistoryOmission, AgentHistoryReadInput,
  AgentHistoryRecord, AgentHistorySource, AgentHistoryTranscriptPage,
} from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryRecord, parseAgentHistoryTranscriptPage } from '../../validation/parse.js';
import { claudeTranscriptContinuation, parseClaudeTranscriptContinuation } from './continuation.js';
import {
  captureClaudeNative, claudePageBudget, claudeProjectOptions, fitsClaudePage,
  lookupClaudeSession, type ClaudeHistorySdk,
} from './session.js';

const nativeId = z.string().min(1).max(512).refine((value) => value.trim() === value && !/[\u0000-\u001F\u007F-\u009F]/u.test(value));
const nativeMessage = z.object({
  type: z.enum(['user', 'assistant', 'system']), uuid: nativeId, session_id: z.string().uuid(),
  message: z.unknown().optional(), timestamp: z.string().optional(),
});
type ClaudeMessage = z.infer<typeof nativeMessage>;
const contentSchema = z.union([z.string(), z.array(z.unknown()).max(1000)]);
const messageBody = z.object({ role: z.enum(['user', 'assistant', 'system', 'developer']).optional(), content: contentSchema });
const blockType = z.object({ type: z.string().min(1).max(120) });
const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const thinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string() });
const toolCall = z.object({ type: z.literal('tool_use'), id: nativeId, name: z.string().min(1).max(256), input: z.unknown().optional() });
const toolResult = z.object({ type: z.literal('tool_result'), tool_use_id: nativeId, content: contentSchema.optional(), is_error: z.boolean().optional() });
const attachmentBlock = z.object({ type: z.enum(['image', 'document']), source: z.discriminatedUnion('type', [
  z.object({ type: z.literal('url'), url: z.string().max(8192), media_type: z.string().min(1).max(128).optional() }),
  z.object({ type: z.literal('base64'), data: z.string(), media_type: z.string().min(1).max(128) }),
  z.object({ type: z.literal('file'), file_id: nativeId }),
]), title: z.string().max(512).optional() });

function invalidNative(): never {
  throw new AgentHistoryError('native_failure', 'Claude returned invalid transcript content.');
}

function omission(detail = 'This native content kind is unavailable in the portable transcript.'): AgentHistoryContent {
  return { kind: 'omission', reason: 'unsupported_content', detail };
}

function attachment(value: unknown): AgentHistoryContent {
  const parsed = attachmentBlock.safeParse(value);
  if (!parsed.success) return omission('This native attachment has no supported inert reference.');
  const block = parsed.data, source = block.source;
  if (source.type === 'file') {
    return { kind: 'attachment', attachmentKind: block.type, reference: { kind: 'native', id: source.file_id }, name: block.title };
  }
  const uri = source.type === 'url' ? source.url : `data:${source.media_type};base64,${source.data}`;
  if (uri.length > 8192 || !URL.canParse(uri)) return omission('This inline attachment exceeds the bounded inert-reference representation.');
  const url = new URL(uri);
  if (url.username || url.password) return omission('This attachment reference contains credentials and is omitted.');
  return { kind: 'attachment', attachmentKind: block.type, reference: { kind: 'uri', uri },
    name: block.title, mediaType: source.media_type };
}

function contentBlock(value: unknown): AgentHistoryContent {
  const type = blockType.safeParse(value);
  if (!type.success) return invalidNative();
  switch (type.data.type) {
    case 'text': {
      const parsed = textBlock.safeParse(value);
      return parsed.success ? { kind: 'text', text: parsed.data.text } : invalidNative();
    }
    case 'thinking': {
      const parsed = thinkingBlock.safeParse(value);
      return parsed.success ? { kind: 'thinking', text: parsed.data.thinking } : invalidNative();
    }
    case 'image': case 'document': return attachment(value);
    default: return omission();
  }
}

function resultContent(value: string | unknown[] | undefined): readonly AgentHistoryContent[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [{ kind: 'text', text: value }] : value.map(contentBlock);
}

function record(value: unknown): AgentHistoryRecord {
  try { return parseAgentHistoryRecord(value); }
  catch { throw new AgentHistoryError('native_failure', 'Claude content cannot be represented as a portable transcript record.'); }
}

function normalize(message: ClaudeMessage): readonly AgentHistoryRecord[] {
  let timestamp: string | undefined;
  if (message.timestamp !== undefined) {
    const epoch = Date.parse(message.timestamp);
    if (!Number.isFinite(epoch)) return invalidNative();
    timestamp = new Date(epoch).toISOString();
  }
  const base = { native: { historyAnchor: message.uuid }, timestamp };
  const body = messageBody.safeParse(message.message);
  if (!body.success) {
    if (message.type !== 'system') return invalidNative();
    return [record({ ...base, kind: 'notice', code: 'claude.system_record',
      message: 'Claude retained an opaque system record; its subtype and content are unavailable through the history helper.' })];
  }
  if (body.data.role !== undefined && body.data.role !== message.type) return invalidNative();
  const content = body.data.content;
  if (typeof content === 'string') return [record({ ...base, kind: 'message', role: message.type, content: [{ kind: 'text', text: content }] })];
  const records: AgentHistoryRecord[] = [], pending: AgentHistoryContent[] = [];
  const flush = () => {
    if (pending.length > 0) records.push(record({ ...base, kind: 'message', role: message.type, content: pending.splice(0) }));
  };
  for (const value of content) {
    const type = blockType.safeParse(value);
    if (!type.success) return invalidNative();
    if (type.data.type === 'tool_use') {
      flush();
      const parsed = toolCall.safeParse(value);
      if (!parsed.success) return invalidNative();
      let args: AgentJsonValue | undefined;
      try { args = parsed.data.input === undefined ? undefined : parseAgentJsonValue(parsed.data.input); }
      catch { return invalidNative(); }
      records.push(record({ ...base, kind: 'tool_call', callId: parsed.data.id, name: parsed.data.name, arguments: args }));
    } else if (type.data.type === 'tool_result') {
      flush();
      const parsed = toolResult.safeParse(value);
      if (!parsed.success) return invalidNative();
      records.push(record({ ...base, kind: 'tool_result', callId: parsed.data.tool_use_id,
        outcome: parsed.data.is_error ? 'failed' : 'succeeded', content: resultContent(parsed.data.content) }));
    } else pending.push(contentBlock(value));
  }
  flush();
  if (records.length === 0) records.push(record({ ...base, kind: 'message', role: message.type, content: [] }));
  return records;
}

function pageOmissions(items: readonly AgentHistoryRecord[]): readonly AgentHistoryOmission[] {
  const omissions: AgentHistoryOmission[] = ['native_retention', 'subagents_excluded'];
  if (items.some((item) => item.kind === 'notice' && item.code === 'claude.system_record')) omissions.push('unsupported_record_kind');
  if (items.some((item) => (item.kind === 'message' || item.kind === 'tool_result') && item.content.some((content) => content.kind === 'omission'))) omissions.push('unsupported_content');
  return omissions;
}

export async function readClaudeTranscript(sdk: ClaudeHistorySdk, source: AgentHistorySource,
  input: AgentHistoryReadInput, pageBytes: number): Promise<AgentHistoryTranscriptPage> {
  if (input.view !== undefined && input.view.kind !== 'main') throw new AgentHistoryError('unsupported_scope', 'Claude history currently exposes only the main transcript.');
  const continuation = parseClaudeTranscriptContinuation(input.cursor), limit = input.limit ?? 100;
  const nativeLimit = Math.min(limit + 1, 100);
  await lookupClaudeSession(sdk, source, input.conversation.conversationId);
  const raw = await sdk.getSessionMessages(input.conversation.conversationId,
    { ...claudeProjectOptions(source), limit: nativeLimit, offset: continuation.offset, includeSystemMessages: true });
  const parsed = z.array(z.unknown()).max(nativeLimit).safeParse(raw);
  if (!parsed.success) throw new AgentHistoryError('native_failure', 'Claude returned an invalid transcript page.');
  // The native helper returns [] both for deletion and an existing empty transcript.
  await lookupClaudeSession(sdk, source, input.conversation.conversationId);
  const budget = claudePageBudget(pageBytes), observedAt = new Date().toISOString();
  const items: AgentHistoryRecord[] = [];
  const page = (nextCursor?: string) => ({ items, nextCursor, observedAt, consistency: 'live',
    coverage: { view: 'retained_chain', children: 'excluded', omissions: pageOmissions(items) } });
  let nextCursor: string | undefined;
  for (let index = 0; index < parsed.data.length; index += 1) {
    if (items.length === limit) return parseAgentHistoryTranscriptPage(page(claudeTranscriptContinuation({
      version: 1, offset: continuation.offset + index, part: 0,
    })));
    const message = nativeMessage.safeParse(captureClaudeNative(parsed.data[index]));
    if (!message.success || message.data.session_id !== input.conversation.conversationId) return invalidNative();
    if (index === 0 && continuation.uuid !== undefined && continuation.uuid !== message.data.uuid) {
      throw new AgentHistoryError('invalid_cursor', 'Claude transcript changed at the continued native record.');
    }
    const records = normalize(message.data), start = index === 0 ? continuation.part : 0;
    if (start >= records.length) throw new AgentHistoryError('invalid_cursor', 'Claude transcript continuation no longer identifies a record.');
    for (const [part, entry] of records.entries()) {
      if (part < start) continue;
      const cursor = claudeTranscriptContinuation({ version: 1, offset: continuation.offset + index, part, uuid: message.data.uuid });
      if (items.length === limit) return parseAgentHistoryTranscriptPage(page(cursor));
      items.push(entry);
      if (!fitsClaudePage(page(cursor), budget)) {
        items.pop();
        if (items.length === 0) throw new AgentHistoryError('limit_exhausted', 'Claude transcript record exceeds the page byte budget.');
        return parseAgentHistoryTranscriptPage(page(cursor));
      }
    }
  }
  if (parsed.data.length === 0 && continuation.part > 0) throw new AgentHistoryError('invalid_cursor', 'Claude transcript no longer contains the continued native record.');
  if (parsed.data.length === nativeLimit) nextCursor = claudeTranscriptContinuation({ version: 1, offset: continuation.offset + nativeLimit, part: 0 });
  const result = page(nextCursor);
  if (!fitsClaudePage(result, budget)) throw new AgentHistoryError('limit_exhausted', 'Claude transcript page exceeds the page byte budget.');
  return parseAgentHistoryTranscriptPage(result);
}
