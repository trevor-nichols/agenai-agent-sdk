// ------------------------------------------------------------------------------------------------
//                events.ts - Neutral event construction for text streams, owned tool calls and approvals
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import {
  AGENT_PROTOCOL_VERSION, compareStringsByUnicodeCodePoint, parseAgentApprovalOptionId, parseAgentItemId, type AgentError, type AgentItemId, type AgentRequest, type AgentRequestId, type AgentSessionId,
  type AgentTurnId,
} from '@agen-ai/agent-protocol';
import { chunkAgentCanonicalText, createAgentEventOutput, createAgentProviderRequestContext, type AgentProviderOutput, type AgentProviderRequestContext } from '@agen-ai/agent-runtime';
import type { NodeProviderToolApprovalRequest, NodeProviderToolRefusal, NodeProviderToolResult, NodeProviderToolStart } from '@agen-ai/provider-tools/node';
import type { NativeEvent } from './native-events.js';

export const APPROVE_ONCE = parseAgentApprovalOptionId('approval:approve-once');
export const DENY_ONCE = parseAgentApprovalOptionId('approval:deny-once');
const ONCE = Object.freeze({ kind: 'scoped', persistence: 'once', scope: Object.freeze({ kind: 'exact_action' }) } as const);
const OPEN_TEXT_ITEMS = 64;

export const turnError = (category: AgentError['category'], code: string, message: string): AgentError =>
  ({ category, code, message, recovery: { kind: 'unknown' } });

/** Single-line canonical display text; exact action text travels only in request context. */
export function display(value: string, max: number): string {
  const text = value.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (text.length <= max) return text || '-';
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function turnEvents(sessionId: AgentSessionId, turnId: AgentTurnId) {
  return (type: string, payload: unknown, options?: Parameters<typeof createAgentEventOutput>[1]): AgentProviderOutput =>
    createAgentEventOutput({ protocolVersion: AGENT_PROTOCOL_VERSION, sessionId, turnId, occurredAt: new Date().toISOString(), type, payload }, options);
}

/** A turn's open native text streams as neutral items; an unknown, repeated or excess stream is a protocol failure. */
export class TurnTexts {
  private readonly open = new Map<string, AgentItemId>();

  constructor(private readonly event: ReturnType<typeof turnEvents>) {}

  map(event: Extract<NativeEvent, { kind: 'text' }>): AgentProviderOutput[] | AgentError {
    const itemKind = event.stream === 'assistant' ? 'assistant_message' : 'reasoning';
    const streamKind = event.stream === 'assistant' ? 'assistant_text' : 'reasoning_text';
    const key = `${event.stream}:${event.key}`;
    const existing = this.open.get(key);
    if (event.phase === 'started') {
      if (existing || this.open.size >= OPEN_TEXT_ITEMS) return turnError('protocol', 'opencode_text_invalid', 'OpenCode opened a text stream twice or past its bound.');
      const itemId = parseAgentItemId(`opencode-item:${randomUUID()}`);
      this.open.set(key, itemId);
      return [this.event('item.started', { itemId, itemKind, status: 'in_progress' })];
    }
    if (!existing) return turnError('protocol', 'opencode_text_invalid', 'OpenCode streamed text for an unknown stream.');
    if (event.phase === 'delta') return chunkAgentCanonicalText(event.text).map((delta) => this.event('content.delta', { itemId: existing, streamKind, delta }));
    this.open.delete(key);
    return [this.event('item.completed', { itemId: existing, itemKind, status: 'completed' })];
  }
}

export function startedItem(itemId: AgentItemId, start: NodeProviderToolStart) {
  switch (start.kind) {
    case 'command': return { itemId, itemKind: 'command_execution', status: 'in_progress', title: 'Command',
      details: { commandSummary: display(start.command, 2_000) } };
    case 'edit': return { itemId, itemKind: 'file_change', status: 'in_progress', title: start.paths.length === 1 ? 'Edit file' : 'Edit files' };
    case 'read': return { itemId, itemKind: 'dynamic_tool_call', status: 'in_progress', title: 'Read file',
      details: { toolName: 'read', actionSummary: display(start.path, 2_000) } };
    case 'search': return { itemId, itemKind: 'dynamic_tool_call', status: 'in_progress', title: 'Search files',
      details: { toolName: 'search', actionSummary: display(`${start.pattern} in ${start.path}`, 2_000) } };
  }
}

const REFUSALS: Readonly<Record<NodeProviderToolRefusal, string>> = {
  invalid_input: 'Refused: the call input is invalid.',
  outside_workspace: 'Refused: the path is outside the workspace.',
  restricted: 'Refused by the session file restrictions.',
  unavailable: 'Refused: the tool session no longer admits calls.',
};
const UNSTARTED = {
  bash: ['command_execution', 'Command'], write: ['file_change', 'Edit file'], edit: ['file_change', 'Edit file'], patch: ['file_change', 'Edit files'],
  read: ['dynamic_tool_call', 'Read file'], glob: ['dynamic_tool_call', 'Search files'], grep: ['dynamic_tool_call', 'Search files'],
} as const;

const itemStatus = (result: NodeProviderToolResult) =>
  result.status === 'completed' ? 'completed' : result.status === 'canceled' ? 'canceled' : 'failed';

/** A call that settled before it started: its item names only the owned tool and refusal category, never the model's input. */
export function unstartedItem(itemId: AgentItemId, result: NodeProviderToolResult) {
  const [itemKind, title] = result.tool === null ? ['dynamic_tool_call', 'Tool call'] as const : UNSTARTED[result.tool];
  const started = { itemId, itemKind, status: 'in_progress', title };
  return { started, completed: { ...started, status: itemStatus(result), ...(result.refusal ? { summary: REFUSALS[result.refusal] } : {}) } };
}

/** The tools' own refusal of a call, as a bounded category a host can attribute without reading model text. */
export function refusalDiagnostic(refusal: NodeProviderToolRefusal, tool: NodeProviderToolResult['tool']) {
  return { code: 'owned_tool_refused', message: REFUSALS[refusal], context: { operation: tool ?? 'unknown', status: refusal } };
}

export function completedItem(itemId: AgentItemId, start: NodeProviderToolStart, result: NodeProviderToolResult) {
  const status = itemStatus(result);
  const base = { ...startedItem(itemId, start), ...(result.refusal ? { summary: REFUSALS[result.refusal] } : {}) };
  if (start.kind === 'command') {
    const receipt = result.command;
    return { ...base, status, details: { commandSummary: display(start.command, 2_000),
      ...(receipt?.exitCode !== null && receipt?.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
      ...(receipt ? { durationMs: receipt.durationMs } : {}), ...(receipt?.truncated ? { truncated: true } : {}) } };
  }
  if (start.kind === 'edit') {
    const changes = [...result.changes].sort((left, right) => compareStringsByUnicodeCodePoint(left.path, right.path));
    return { ...base, status, ...(changes.length
      ? { details: { changes: changes.map((change) => ({ path: change.path, changeKind: change.change })) } } : {}) };
  }
  return { ...base, status, details: { ...base.details, success: result.status === 'completed' } };
}

export interface BuiltApproval {
  readonly request: AgentRequest;
  readonly context: AgentProviderRequestContext;
}

/**
 * The exact action is carried untruncated in request context. If it cannot fit, no approval is
 * offered and the caller refuses the call, so a host never approves a summary of an action.
 */
export function buildApproval(requestId: AgentRequestId, itemId: AgentItemId, action: NodeProviderToolApprovalRequest): BuiltApproval | undefined {
  let context: AgentProviderRequestContext;
  try { context = createAgentProviderRequestContext({ action }); } catch { return undefined; }
  const options = [
    { optionId: APPROVE_ONCE, label: 'Approve once', decision: 'approved', consequence: ONCE },
    { optionId: DENY_ONCE, label: 'Deny', decision: 'denied', consequence: ONCE },
  ] as const;
  const subject = action.kind === 'command'
    ? { kind: 'command', title: 'Run command', description: display(action.command, 1_000), itemId }
    : action.kind === 'edit'
      ? { kind: 'file_change', title: action.paths.length === 1 ? 'Edit file' : `Edit ${action.paths.length} files`,
        description: display(action.paths.join(', '), 1_000), itemId }
      : { kind: 'other', title: 'Read restricted file', description: display(action.path, 1_000), itemId };
  const prompt = action.kind === 'command' ? `Run this command once?\n${action.command}`
    : action.kind === 'edit' ? `Apply ${action.reason === 'restricted' ? 'restricted ' : ''}edits once?\n${action.paths.join('\n')}`
      : `Read this restricted file once?\n${action.path}`;
  return Object.freeze({
    request: { requestKind: 'approval', requestId, prompt: display(prompt, 4_000), subject, options } as unknown as AgentRequest,
    context,
  });
}
