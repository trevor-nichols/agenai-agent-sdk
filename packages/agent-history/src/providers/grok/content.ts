import { z } from 'zod/v4';
import type { AgentHistoryContent, AgentHistoryOmission } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { queryDigest } from '../../pagination/cursor.js';
import { captureHistoryData } from '../../validation/bounds.js';
import { parseAgentHistoryRecord } from '../../validation/parse.js';
import { AgentHistoryContentSchema } from '../../validation/records.js';
import { GrokEnvelopeSchema, GrokUpdateParamsSchema, parseGrokNative } from './native.js';

const text = z.object({ type: z.literal('text'), text: z.string() });
const link = z.object({ type: z.literal('resource_link'), uri: z.string().min(1), name: z.string().optional(), mimeType: z.string().optional() });
const image = z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1), uri: z.string().min(1).nullable().optional() });
const tool = z.object({ toolCallId: z.string().min(1).max(512), title: z.string().min(1).max(512), rawInput: z.unknown().optional() });
const toolUpdate = z.object({ toolCallId: z.string().min(1).max(512), status: z.enum(['pending', 'in_progress', 'completed', 'failed']).nullable().optional(),
  content: z.array(z.unknown()).max(1000).nullable().optional() });

function content(value: unknown, omissions: Set<AgentHistoryOmission>): AgentHistoryContent {
  const block = parseGrokNative(z.object({ type: z.string().min(1).max(256) }), value);
  if (block.type === 'text') return { kind: 'text', text: parseGrokNative(text, value).text };
  if (block.type === 'resource_link') {
    const resource = parseGrokNative(link, value);
    const candidate = AgentHistoryContentSchema.safeParse({ kind: 'attachment', attachmentKind: 'file', reference: { kind: 'uri', uri: resource.uri },
      ...(resource.name === undefined ? {} : { name: resource.name }), ...(resource.mimeType === undefined ? {} : { mediaType: resource.mimeType }) });
    if (candidate.success) return candidate.data;
  }
  if (block.type === 'image') {
    const picture = parseGrokNative(image, value);
    const candidate = AgentHistoryContentSchema.safeParse({ kind: 'attachment', attachmentKind: 'image',
      reference: { kind: 'uri', uri: picture.uri ?? `data:${picture.mimeType};base64,${picture.data}` }, mediaType: picture.mimeType });
    if (candidate.success) return candidate.data;
  }
  omissions.add('unsupported_content');
  return { kind: 'omission', reason: 'unsupported_content', detail: 'This stored Grok content block has no qualified portable representation.' };
}

export function projectGrokUpdate(value: unknown, sessionId: string) {
  const captured = captureHistoryData(value), envelope = parseGrokNative(GrokEnvelopeSchema, captured);
  const params = parseGrokNative(GrokUpdateParamsSchema, envelope.method === undefined ? captured : envelope.params);
  if (params.sessionId !== sessionId) throw new AgentHistoryError('native_failure', 'Grok returned a stored update from another session.');
  const omissions = new Set<AgentHistoryOmission>();
  const timestamp = envelope.timestamp === undefined ? undefined
    : new Date(typeof envelope.timestamp === 'number' ? envelope.timestamp * 1000 : envelope.timestamp).toISOString();
  const base = { ...(timestamp === undefined ? {} : { timestamp }),
    ...(params._meta?.eventId === undefined ? {} : { native: { itemId: params._meta.eventId } }) };
  const update = params.update;
  const unknown = () => {
    omissions.add('unsupported_record_kind');
    return { ...base, kind: 'notice', code: 'grok.unsupported_record_kind', message: 'Grok retained a stored update without a qualified portable history mapping.' };
  };
  let record: unknown;
  if (envelope.method !== undefined && !['session/update', '_x.ai/session/update'].includes(envelope.method)) record = unknown();
  else switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk': record = { ...base, kind: 'message', role: update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant',
      content: [content(update.content, omissions)] }; break;
    case 'agent_thought_chunk': {
      const thought = text.safeParse(update.content);
      if (!thought.success) record = { ...base, kind: 'message', role: 'assistant', content: [content(update.content, omissions)] };
      else record = { ...base, kind: 'message', role: 'assistant', content: [{ kind: 'thinking', text: thought.data.text }] };
      break;
    }
    case 'tool_call': {
      const parsed = parseGrokNative(tool, update);
      if (parsed.title.length > 256) { record = unknown(); break; }
      record = parseAgentHistoryRecord({ ...base, kind: 'tool_call', callId: parsed.toolCallId, name: parsed.title,
        ...(parsed.rawInput === undefined ? {} : { arguments: parsed.rawInput }) });
      break;
    }
    case 'tool_call_update': {
      const parsed = parseGrokNative(toolUpdate, update);
      record = { ...base, kind: 'tool_result', callId: parsed.toolCallId,
        outcome: parsed.status === 'completed' ? 'succeeded' : parsed.status === 'failed' ? 'failed' : 'unknown',
        content: (parsed.content ?? []).map((part) => {
          const wrapped = z.object({ type: z.literal('content'), content: z.unknown() }).safeParse(part);
          return content(wrapped.success ? wrapped.data.content : part, omissions);
        }) };
      break;
    }
    default: record = unknown();
  }
  return { record: parseAgentHistoryRecord(record), fingerprint: queryDigest({ update: captured }), omissions: [...omissions] };
}
