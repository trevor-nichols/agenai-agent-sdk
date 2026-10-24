import { z } from 'zod/v4';
import { parseAgentJsonValue } from '@agen-ai/agent-protocol';
import type { AgentHistoryContent, AgentHistoryRecord } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryRecord } from '../../validation/parse.js';
import { codexId, parseCodexNative, type CodexNativeItem } from './native.js';

const contentArray = z.array(z.unknown()).max(1000);
const contentType = z.object({ type: z.string().min(1).max(120) });
const text = z.object({ text: z.string() });

function omitted(detail: string): AgentHistoryContent {
  return { kind: 'omission', reason: 'unsupported_content', detail };
}

function uriAttachment(uri: string, attachmentKind: 'image' | 'unknown'): AgentHistoryContent {
  if (uri.length > 8192 || !URL.canParse(uri)) return omitted('The native attachment has no bounded inert URI representation.');
  const url = new URL(uri);
  if (url.username || url.password) return omitted('The native attachment URI contains credentials and is omitted.');
  return { kind: 'attachment', attachmentKind, reference: { kind: 'uri', uri } };
}

function nativeAttachment(id: string, attachmentKind: 'image' | 'unknown'): AgentHistoryContent {
  if (!codexId.safeParse(id).success) return omitted('The native attachment reference exceeds its portable identity bound.');
  return { kind: 'attachment', attachmentKind, reference: { kind: 'native', id } };
}

function content(value: unknown): AgentHistoryContent {
  const type = parseCodexNative(contentType, value).type;
  switch (type) {
    case 'text': case 'input_text': case 'inputText': return { kind: 'text', text: parseCodexNative(text, value).text };
    case 'image': {
      const block = parseCodexNative(z.object({ url: z.string().optional(), fileId: z.string().optional() }), value);
      if (block.url !== undefined) return uriAttachment(block.url, 'image');
      if (block.fileId !== undefined) return nativeAttachment(block.fileId, 'image');
      return omitted('The native image has no supported inert reference.');
    }
    case 'input_image': {
      const block = parseCodexNative(z.object({ image_url: z.string().optional(), file_id: z.string().optional() }), value);
      if (block.image_url !== undefined) return uriAttachment(block.image_url, 'image');
      if (block.file_id !== undefined) return nativeAttachment(block.file_id, 'image');
      return omitted('The native image has no supported inert reference.');
    }
    case 'inputImage': return uriAttachment(parseCodexNative(z.object({ imageUrl: z.string() }), value).imageUrl, 'image');
    case 'localImage': return nativeAttachment(parseCodexNative(z.object({ path: z.string() }), value).path, 'image');
    case 'audio': return uriAttachment(parseCodexNative(z.object({ url: z.string() }), value).url, 'unknown');
    case 'input_audio': return uriAttachment(parseCodexNative(z.object({ audio_url: z.string() }), value).audio_url, 'unknown');
    case 'inputAudio': return uriAttachment(parseCodexNative(z.object({ audioUrl: z.string() }), value).audioUrl, 'unknown');
    case 'localAudio': return nativeAttachment(parseCodexNative(z.object({ path: z.string() }), value).path, 'unknown');
    default: return omitted('This retained native content kind is unavailable in the portable transcript.');
  }
}

function output(value: unknown): readonly AgentHistoryContent[] {
  if (typeof value === 'string') return [{ kind: 'text', text: value }];
  return parseCodexNative(contentArray, value).map(content);
}

function portable(value: unknown): AgentHistoryRecord {
  try { return parseAgentHistoryRecord(value); }
  catch { throw new AgentHistoryError('limit_exhausted', 'Codex history item exceeds its portable record bounds.'); }
}

function argumentsValue(value: unknown) {
  try { return parseAgentJsonValue(value); }
  catch { throw new AgentHistoryError('limit_exhausted', 'Codex retained tool arguments exceed the portable JSON bounds.'); }
}

export function normalizeCodexItem(item: CodexNativeItem, turnId: string, startedAtMs?: number | null): readonly AgentHistoryRecord[] {
  const timestamp = startedAtMs == null ? undefined : new Date(startedAtMs).toISOString();
  const base = { native: { turnId, itemId: item.id }, timestamp };
  switch (item.type) {
    case 'userMessage': return [portable({ ...base, kind: 'message', role: 'user',
      content: parseCodexNative(z.object({ content: contentArray }), item).content.map(content) })];
    case 'agentMessage': return [portable({ ...base, kind: 'message', role: 'assistant',
      content: [{ kind: 'text', text: parseCodexNative(text, item).text }] })];
    case 'reasoning': {
      const value = parseCodexNative(z.object({ summary: z.array(z.string()).max(1000), content: z.array(z.string()).max(1000) }), item);
      return [portable({ ...base, kind: 'message', role: 'assistant',
        content: [...value.summary, ...value.content].map((entry) => ({ kind: 'thinking', text: entry })) })];
    }
    case 'functionCallOutput': return [portable({ ...base, kind: 'tool_result', outcome: 'unknown', content: output(item.output) })];
    case 'contextCompaction': return [portable({ ...base, kind: 'compaction' })];
    case 'commandExecution': {
      const value = parseCodexNative(z.object({ command: z.string(), cwd: z.string(),
        status: z.enum(['inProgress', 'completed', 'failed', 'declined']), aggregatedOutput: z.string().nullable() }), item);
      return [portable({ ...base, kind: 'tool_call', name: 'commandExecution', arguments: argumentsValue({ command: value.command, cwd: value.cwd }) }),
        portable({ ...base, kind: 'tool_result', outcome: value.status === 'completed' ? 'succeeded'
          : value.status === 'failed' || value.status === 'declined' ? 'failed' : 'unknown',
        content: value.aggregatedOutput === null ? [] : [{ kind: 'text', text: value.aggregatedOutput }] })];
    }
    case 'dynamicToolCall': {
      const value = parseCodexNative(z.object({ tool: z.string().min(1), namespace: z.string().nullable().optional(), arguments: z.unknown(),
        status: z.enum(['inProgress', 'completed', 'failed']), success: z.boolean().nullable(),
        contentItems: contentArray.nullable() }), item);
      return [portable({ ...base, kind: 'tool_call', name: value.namespace ? `${value.namespace}/${value.tool}` : value.tool, arguments: argumentsValue(value.arguments) }),
        portable({ ...base, kind: 'tool_result', outcome: value.success === true ? 'succeeded'
          : value.success === false || value.status === 'failed' ? 'failed' : 'unknown',
        content: value.contentItems === null ? [] : value.contentItems.map(content) })];
    }
    case 'mcpToolCall': {
      const value = parseCodexNative(z.object({ server: z.string().min(1), tool: z.string().min(1), arguments: z.unknown(),
        status: z.enum(['inProgress', 'completed', 'failed']),
        result: z.object({ content: contentArray, structuredContent: z.unknown().optional() }).nullable(), error: z.object({ message: z.string() }).nullable() }), item);
      const resultContent = value.result?.content.map(content) ?? [];
      if (value.result?.structuredContent != null) resultContent.push(omitted('Native structured tool output has no portable structured-content representation.'));
      return [portable({ ...base, kind: 'tool_call', name: `${value.server}/${value.tool}`, arguments: argumentsValue(value.arguments) }),
        portable({ ...base, kind: 'tool_result', outcome: value.error !== null || value.status === 'failed' ? 'failed'
          : value.status === 'completed' ? 'succeeded' : 'unknown',
        content: value.error !== null ? [{ kind: 'text', text: value.error.message }]
          : resultContent })];
    }
    default: return [portable({ ...base, kind: 'notice', code: 'codex.unsupported_record_kind',
      message: `Codex retained an unsupported history item of kind ${item.type}.` })];
  }
}
