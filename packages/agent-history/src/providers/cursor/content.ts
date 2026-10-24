import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { AgentHistoryOmission, AgentHistoryRecord } from '../../contracts/index.js';
import { parseAgentHistoryRecord } from '../../validation/parse.js';
import { cursorNativeJson, parseCursorNative } from './native.js';

const text = z.string().max(1_048_576);
const user = z.object({ text, messageId: z.string().max(16_384).optional() });
const agentTurn = z.object({ userMessage: user.optional(), steps: z.array(z.unknown()).max(100_000) });
const prose = z.object({ text });
const read = z.object({ args: z.object({ path: z.string().max(16_384) }), result: z.unknown().optional() });
const structuredTool = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read'), args: z.object({ path: z.string().max(16_384) }),
    result: z.discriminatedUnion('status', [z.object({ status: z.literal('success'), value: z.object({ content: text }) }),
      z.object({ status: z.literal('error') })]).optional() }),
  z.object({ type: z.literal('shell'), args: z.object({ command: text, workingDirectory: z.string().max(4096).optional(), timeout: z.number().optional() }),
    result: z.discriminatedUnion('status', [z.object({ status: z.literal('success'), value: z.object({ stdout: text, stderr: text, exitCode: z.number() }) }),
      z.object({ status: z.literal('error') })]).optional() }),
]);
const shell = z.object({
  shellCommand: z.object({ command: text, workingDirectory: z.string().max(4096).optional() }).optional(),
  shellOutput: z.object({ stdout: text, stderr: text, exitCode: z.number() }).optional(),
});

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface CursorTurnProjection {
  readonly records: readonly AgentHistoryRecord[];
  readonly omissions: readonly AgentHistoryOmission[];
  readonly fingerprint: string;
}

export function projectCursorTurn(value: unknown, kind: 'checkpoint' | 'run', agentId: string): CursorTurnProjection {
  const native = cursorNativeJson(value);
  const fingerprint = createHash('sha256').update(JSON.stringify(native)).digest('hex');
  const records: AgentHistoryRecord[] = [], omissions = new Set<AgentHistoryOmission>();
  const push = (record: unknown) => records.push(parseAgentHistoryRecord(record));
  const unknown = () => {
    omissions.add('unsupported_record_kind');
    push({ kind: 'notice', code: 'cursor.record_unavailable', message: 'This native Cursor record is outside the qualified history projection.' });
  };
  const message = (role: 'user' | 'assistant', content: string, thinking = false, id?: string) => push({
    kind: 'message', role, content: [{ kind: thinking ? 'thinking' : 'text', text: content }],
    ...(id === undefined || id === '' ? {} : { native: { itemId: id } }),
  });
  const shellRecords = (raw: unknown) => {
    const turn = parseCursorNative(shell, raw);
    if (turn.shellCommand !== undefined) push({ kind: 'tool_call', name: 'shell', arguments: turn.shellCommand });
    if (turn.shellOutput !== undefined) push({ kind: 'tool_result', outcome: turn.shellOutput.exitCode === 0 ? 'succeeded' : 'failed',
      content: [{ kind: 'text', text: turn.shellOutput.stdout }, { kind: 'text', text: turn.shellOutput.stderr }] });
    if (turn.shellCommand === undefined && turn.shellOutput === undefined) unknown();
  };
  const structuredToolRecords = (raw: unknown) => {
    const parsed = structuredTool.safeParse(raw);
    if (!parsed.success) { unknown(); return; }
    const tool = parsed.data;
    push({ kind: 'tool_call', name: tool.type, arguments: tool.args });
    const result = tool.result;
    if (result === undefined) return;
    if (result.status === 'error') {
      push({ kind: 'tool_result', outcome: 'failed', content: [{ kind: 'omission', reason: 'unsupported_content', detail: 'Native tool error details are not exposed by this history projection.' }] });
      omissions.add('unsupported_content');
    } else if (tool.type === 'read' && 'content' in result.value) {
      push({ kind: 'tool_result', outcome: 'succeeded', content: [{ kind: 'text', text: result.value.content }] });
    } else if ('stdout' in result.value) {
      push({ kind: 'tool_result', outcome: result.value.exitCode === 0 ? 'succeeded' : 'failed',
        content: [{ kind: 'text', text: result.value.stdout }, { kind: 'text', text: result.value.stderr }] });
    }
  };
  const agentRecords = (raw: unknown) => {
    const turn = parseCursorNative(agentTurn, raw);
    if (turn.userMessage !== undefined) message('user', turn.userMessage.text, false,
      kind === 'checkpoint' ? turn.userMessage.messageId : undefined);
    for (const step of turn.steps) {
      if (!object(step)) { unknown(); continue; }
      if (kind === 'checkpoint') {
        if (step.assistantMessage !== undefined) message('assistant', parseCursorNative(prose, step.assistantMessage).text);
        else if (step.thinkingMessage !== undefined) message('assistant', parseCursorNative(prose, step.thinkingMessage).text, true);
        else if (object(step.toolCall) && step.toolCall.readToolCall !== undefined) {
          const tool = parseCursorNative(read, step.toolCall.readToolCall);
          push({ kind: 'tool_call', name: 'read', arguments: tool.args });
          if (tool.result !== undefined) {
            omissions.add('unsupported_content');
            push({ kind: 'notice', code: 'cursor.tool_result_unavailable', message: 'This stored native tool result is outside the qualified checkpoint projection.' });
          }
        } else unknown();
      } else {
        if (step.type === 'assistantMessage') message('assistant', parseCursorNative(prose, step.message).text);
        else if (step.type === 'thinkingMessage') message('assistant', parseCursorNative(prose, step.message).text, true);
        else if (step.type === 'toolCall') structuredToolRecords(step.message);
        else unknown();
      }
    }
    if (records.length === 0) unknown();
  };
  if (!object(native)) { unknown(); return { records, omissions: [...omissions], fingerprint }; }
  if (kind === 'checkpoint') {
    if (native.agent_id !== agentId || !object(native.message)) throw new Error('Cursor returned a checkpoint for another agent');
    if (native.message.agentConversationTurn !== undefined) agentRecords(native.message.agentConversationTurn);
    else if (native.message.shellConversationTurn !== undefined) shellRecords(native.message.shellConversationTurn);
    else unknown();
  } else if (native.type === 'agentConversationTurn') agentRecords(native.turn);
  else if (native.type === 'shellConversationTurn') shellRecords(native.turn);
  else unknown();
  return { records, omissions: [...omissions], fingerprint };
}
