import { z } from 'zod/v4';
import { parseAgentJsonValue } from '@agen-ai/agent-protocol';
import type { AgentHistoryContent, AgentHistoryRecord } from '../../contracts/index.js';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistoryRecord } from '../../validation/parse.js';
import { openCodeID, parseOpenCodeNative, type OpenCodeMessage } from './native.js';

const array = z.array(z.unknown()).max(1000);
const text = z.object({ text: z.string() });
const blockType = z.object({ type: z.string().min(1).max(120) });
interface OpenCodeRecordBase {
  readonly native: Readonly<{ itemId: string }>;
  readonly timestamp: string;
}

function omission(detail: string): AgentHistoryContent {
  return { kind: 'omission', reason: 'unsupported_content', detail };
}

function attachment(uri: string, mime?: string, name?: string): AgentHistoryContent {
  if (uri.length > 8192 || !URL.canParse(uri)) return omission('The native attachment has no bounded inert URI representation.');
  const url = new URL(uri);
  if (url.username || url.password) return omission('The native attachment URI contains credentials and is omitted.');
  if ((mime !== undefined && (mime.length === 0 || mime.length > 128)) || (name !== undefined && name.length > 512)) {
    return omission('The native attachment metadata exceeds its portable bounds.');
  }
  return { kind: 'attachment', attachmentKind: mime?.startsWith('image/') ? 'image'
    : mime === 'application/pdf' ? 'document' : 'file', reference: { kind: 'uri', uri }, mediaType: mime, name };
}

function userFile(value: unknown): AgentHistoryContent {
  const file = parseOpenCodeNative(z.object({ data: z.string(), mime: z.string(), name: z.string().optional(),
    source: z.discriminatedUnion('type', [z.object({ type: z.literal('inline') }), z.object({ type: z.literal('uri'), uri: z.string() })]) }), value);
  if (file.source.type === 'uri') return attachment(file.source.uri, file.mime, file.name);
  if (file.data.length > 8192 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.data)
    || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(file.mime)) {
    return omission('The inline native attachment cannot be represented as a bounded data URI.');
  }
  return attachment(`data:${file.mime};base64,${file.data}`, file.mime, file.name);
}

function toolContent(value: unknown): AgentHistoryContent {
  const type = parseOpenCodeNative(blockType, value).type;
  if (type === 'text') return { kind: 'text', text: parseOpenCodeNative(text, value).text };
  if (type === 'file') {
    const file = parseOpenCodeNative(z.object({ uri: z.string(), mime: z.string(), name: z.string().optional() }), value);
    return attachment(file.uri, file.mime, file.name);
  }
  return omission('This retained native tool content kind is unavailable in the portable transcript.');
}

function portable(value: unknown): AgentHistoryRecord {
  try { return parseAgentHistoryRecord(value); }
  catch { throw new AgentHistoryError('limit_exhausted', 'OpenCode history record exceeds its portable bounds.'); }
}

function argumentsValue(value: unknown) {
  try { return parseAgentJsonValue(value); }
  catch { throw new AgentHistoryError('limit_exhausted', 'OpenCode retained tool arguments exceed their portable JSON bounds.'); }
}

function tool(value: unknown, base: OpenCodeRecordBase): AgentHistoryRecord[] {
  const item = parseOpenCodeNative(z.object({ id: openCodeID, name: z.string().min(1), state: z.discriminatedUnion('status', [
    z.object({ status: z.literal('streaming'), input: z.string() }),
    z.object({ status: z.literal('running'), input: z.record(z.string(), z.unknown()) }),
    z.object({ status: z.literal('completed'), input: z.record(z.string(), z.unknown()), content: array }),
    z.object({ status: z.literal('error'), input: z.record(z.string(), z.unknown()), content: array.optional(), error: z.object({ message: z.string() }) }),
  ]) }), value);
  const records = [portable({ ...base, kind: 'tool_call', callId: item.id, name: item.name,
    arguments: item.state.status === 'streaming' ? undefined : argumentsValue(item.state.input) })];
  if (item.state.status === 'completed' || item.state.status === 'error') {
    const content = item.state.content?.map(toolContent)
      ?? (item.state.status === 'error' ? [{ kind: 'text', text: item.state.error.message }] : []);
    records.push(portable({ ...base, kind: 'tool_result', callId: item.id,
      outcome: item.state.status === 'completed' ? 'succeeded' : 'failed', content }));
  }
  return records;
}

function assistant(message: OpenCodeMessage, base: OpenCodeRecordBase): AgentHistoryRecord[] {
  const blocks = parseOpenCodeNative(z.object({ content: array }), message).content;
  const records: AgentHistoryRecord[] = [];
  let content: AgentHistoryContent[] = [];
  const flush = () => {
    if (content.length === 0) return;
    records.push(portable({ ...base, kind: 'message', role: 'assistant', content }));
    content = [];
  };
  for (const block of blocks) {
    const type = parseOpenCodeNative(blockType, block).type;
    switch (type) {
      case 'text': content.push({ kind: 'text', text: parseOpenCodeNative(text, block).text }); break;
      case 'reasoning': content.push({ kind: 'thinking', text: parseOpenCodeNative(text, block).text }); break;
      case 'tool': flush(); records.push(...tool(block, base)); break;
      default: content.push(omission('This retained native assistant content kind is unavailable in the portable transcript.'));
    }
  }
  flush();
  if (records.length === 0) records.push(portable({ ...base, kind: 'message', role: 'assistant', content: [] }));
  return records;
}

export function normalizeOpenCodeMessage(message: OpenCodeMessage): readonly AgentHistoryRecord[] {
  const base = { native: { itemId: message.id }, timestamp: new Date(message.time.created).toISOString() };
  switch (message.type) {
    case 'user': {
      const value = parseOpenCodeNative(z.object({ text: z.string(), files: array.optional(),
        skills: z.array(z.object({ text: z.string().optional() })).max(1000).optional() }), message);
      return [portable({ ...base, kind: 'message', role: 'user', content: [
        ...(value.skills ?? []).flatMap((skill) => skill.text === undefined ? [] : [{ kind: 'text', text: skill.text }]),
        ...(value.text === '' ? [] : [{ kind: 'text', text: value.text }]), ...(value.files ?? []).map(userFile),
      ] })];
    }
    case 'synthetic': case 'skill': case 'system': return [portable({ ...base, kind: 'message',
      role: message.type === 'system' ? 'system' : 'user', content: [{ kind: 'text', text: parseOpenCodeNative(text, message).text }] })];
    case 'assistant': return assistant(message, base);
    case 'compaction': {
      const value = parseOpenCodeNative(z.discriminatedUnion('status', [
        z.object({ status: z.literal('running'), summary: z.string() }),
        z.object({ status: z.literal('completed'), summary: z.string() }),
        z.object({ status: z.literal('failed') }),
      ]), message);
      return [portable(value.status === 'completed' ? { ...base, kind: 'compaction', summary: value.summary }
        : { ...base, kind: 'notice', code: `opencode.compaction_${value.status}`,
          message: `OpenCode retained a ${value.status} compaction observation.` })];
    }
    case 'shell': {
      const value = parseOpenCodeNative(z.object({ shellID: openCodeID, command: z.string(),
        status: z.enum(['running', 'exited', 'timeout', 'killed']), exit: z.number().finite().optional(),
        output: z.object({ output: z.string(), truncated: z.boolean() }).optional() }), message);
      const records = [portable({ ...base, kind: 'tool_call', callId: value.shellID, name: 'shell', arguments: { command: value.command } })];
      if (value.status !== 'running' || value.output !== undefined) {
        records.push(portable({ ...base, kind: 'tool_result', callId: value.shellID,
          outcome: value.status === 'running' || (value.status === 'exited' && value.exit === undefined) ? 'unknown'
            : value.status === 'exited' && value.exit === 0 ? 'succeeded' : 'failed',
          content: value.output === undefined ? [] : [{ kind: 'text', text: value.output.output },
            ...(value.output.truncated ? [{ kind: 'omission', reason: 'provider_omission', detail: 'OpenCode retained only truncated shell output.' }] : [])],
        }));
      }
      return records;
    }
    case 'agent-switched': case 'model-switched': case 'location-switched': case 'idle': return [portable({ ...base, kind: 'notice',
      code: `opencode.${message.type.replaceAll('-', '_')}`, message: `OpenCode retained a ${message.type} observation.` })];
    default: return [portable({ ...base, kind: 'notice', code: 'opencode.unsupported_record_kind',
      message: 'OpenCode retained an unsupported projected message kind.' })];
  }
}
