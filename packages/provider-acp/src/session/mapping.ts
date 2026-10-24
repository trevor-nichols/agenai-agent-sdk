import type { AcpJsonObject } from '@agen-ai/acp-transport';
import {
  parseAgentApprovalRequest,
  parseAgentItemId,
  parseAgentRequestId,
  type AgentApprovalRequest,
  type AgentItemId,
  type AgentItemSnapshot,
  type AgentSessionId,
  type AgentTurnCompletedPayload,
  type AgentTurnId,
} from '@agen-ai/agent-protocol';
import { chunkAgentCanonicalText, createAgentEventOutput, type AgentProviderOutput } from '@agen-ai/agent-runtime';

import { AcpProviderSessionError } from './errors.js';
import { displayText, nativeObject, nativeString } from './native.js';
import type { SessionQueue } from './queue.js';
import { acpPlanSteps } from './plans.js';
import { acpToolDiff } from './files.js';
import type { AcpPermissionMappingSelection } from '../permissions/contracts.js';
import { mapAcpPermissionOptions } from '../permissions/mapping.js';

interface ObservedItem {
  snapshot: AgentItemSnapshot;
  terminal: boolean;
}

export interface MappedPermission {
  readonly request: AgentApprovalRequest;
  readonly nativeOptions: ReadonlyMap<string, string>;
  readonly warning?: Readonly<{ code: string; message: string }>;
}

export class TurnMapping {
  private readonly tools = new Map<string, ObservedItem>();
  private readonly messages = new Map<string, ObservedItem>();
  private readonly files = new Map<string, ObservedItem & { release: () => void }>();
  private readonly releaseState: (() => void)[] = [];
  private planRevision = 0;

  constructor(private readonly context: {
    readonly sessionId: AgentSessionId;
    readonly turnId: AgentTurnId;
    readonly workingDirectory: string;
    readonly permissionMapping: AcpPermissionMappingSelection;
    readonly now: () => string;
    readonly nextItemId: () => number;
    readonly nextRequestId: () => number;
    readonly reserveState: SessionQueue<unknown>['reserveState'];
  }) {}

  event(type: string, payload: unknown): AgentProviderOutput {
    return createAgentEventOutput({
      protocolVersion: 13,
      sessionId: this.context.sessionId,
      turnId: this.context.turnId,
      occurredAt: this.context.now(),
      type,
      payload,
    });
  }

  private remember(value: unknown, extraBytes = 0): void {
    this.releaseState.push(this.context.reserveState(value, extraBytes));
  }

  *update(update: AcpJsonObject): Generator<AgentProviderOutput> {
    const kind = nativeString(update.sessionUpdate, 'session update kind');
    if (kind === 'plan') {
      yield this.event('turn.plan.updated', { steps: acpPlanSteps(update, ++this.planRevision) });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      yield* this.tool(update);
      return;
    }
    const itemKind: 'assistant_message' | 'reasoning' | 'user_message' | undefined = kind === 'agent_message_chunk' ? 'assistant_message'
      : kind === 'agent_thought_chunk' ? 'reasoning'
        : kind === 'user_message_chunk' ? 'user_message' : undefined;
    if (!itemKind) return;
    const content = nativeObject(update.content, 'message content');
    if (content.type !== 'text') {
      throw new AcpProviderSessionError('acp_output_content_unsupported', 'The ACP baseline supports only text message output.');
    }
    const text = nativeString(content.text, 'message text');
    if (text.length === 0) return;
    let item = this.messages.get(itemKind);
    if (!item) {
      const snapshot = {
        itemId: parseAgentItemId(`acp:item:${this.context.nextItemId()}`),
        itemKind,
        status: 'in_progress' as const,
      };
      this.remember(snapshot);
      item = { snapshot, terminal: false };
      this.messages.set(itemKind, item);
      yield this.event('item.started', snapshot);
    }
    for (const delta of chunkAgentCanonicalText(text)) {
      yield this.event('content.delta', {
        itemId: item.snapshot.itemId,
        streamKind: itemKind === 'assistant_message' ? 'assistant_text'
          : itemKind === 'reasoning' ? 'reasoning_text' : 'unknown',
        delta,
      });
    }
  }

  private toolSnapshot(update: AcpJsonObject, previous?: AgentItemSnapshot): AgentItemSnapshot {
    const title = displayText(update.title, previous?.title ?? 'Agent tool');
    const nativeStatus = update.status;
    const status = nativeStatus === 'completed' || nativeStatus === 'failed'
      || nativeStatus === 'pending' || nativeStatus === 'in_progress'
      ? nativeStatus : previous?.status ?? 'in_progress';
    if (previous?.status === 'in_progress' && status === 'pending') {
      throw new AcpProviderSessionError('acp_tool_status_regressed', 'An ACP tool regressed from running to pending.');
    }
    const previousToolName = previous?.itemKind === 'dynamic_tool_call' ? previous.details?.toolName : undefined;
    const toolName = update.name === undefined || update.name === null ? previousToolName
      : typeof update.name === 'string' && update.name.trim() ? displayText(update.name, 'Agent tool', 120) : undefined;
    let summary = previous?.summary;
    if (Array.isArray(update.content)) {
      summary = undefined;
      const text = update.content.flatMap((value) => {
        const content = nativeObject(value, 'tool content');
        if (content.type === 'diff') return [];
        if (content.type !== 'content') {
          throw new AcpProviderSessionError('acp_output_content_unsupported', 'ACP terminal embedding requires a qualified semantic output mapping.');
        }
        const block = nativeObject(content.content, 'tool content block');
        if (block.type !== 'text') {
          throw new AcpProviderSessionError('acp_output_content_unsupported', 'ACP media and resource output require artifact publication authority.');
        }
        return [nativeString(block.text, 'tool text')];
      }).join('\n');
      if (text.trim()) summary = displayText(text, title, 2_000);
    }
    return {
      itemId: previous?.itemId ?? parseAgentItemId(`acp:item:${this.context.nextItemId()}`),
      itemKind: 'dynamic_tool_call',
      status,
      title,
      ...(summary === undefined ? {} : { summary }),
      details: {
        ...(toolName === undefined ? {} : { toolName }),
        actionSummary: title,
        ...(status === 'completed' || status === 'failed' ? { success: status === 'completed' } : {}),
      },
    };
  }

  *tool(update: AcpJsonObject, permission = false): Generator<AgentProviderOutput, AgentItemId> {
    const nativeId = nativeString(update.toolCallId, 'tool identity');
    let item = this.tools.get(nativeId);
    if (item?.terminal) {
      throw new AcpProviderSessionError('acp_tool_already_terminal', 'ACP updated a tool after terminal completion.');
    }
    const snapshot = this.toolSnapshot(update, item?.snapshot);
    const terminal = snapshot.status === 'completed' || snapshot.status === 'failed';
    if (permission && terminal) {
      throw new AcpProviderSessionError('acp_permission_tool_terminal', 'ACP requested permission for a completed tool.');
    }
    if (!item) {
      this.remember({ nativeId, snapshot }, 16_000);
      item = { snapshot: { ...snapshot, status: terminal ? 'in_progress' : snapshot.status }, terminal: false };
      this.tools.set(nativeId, item);
      yield this.event('item.started', item.snapshot);
      if (!terminal) {
        yield* this.fileUpdate(nativeId, update, item.snapshot);
        return item.snapshot.itemId;
      }
    }
    item.snapshot = snapshot;
    item.terminal = terminal;
    yield this.event(terminal ? 'item.completed' : 'item.updated', snapshot);
    yield* this.fileUpdate(nativeId, update, snapshot);
    return snapshot.itemId;
  }

  hasTool(nativeId: string): boolean {
    return this.tools.has(nativeId);
  }

  private *fileUpdate(nativeId: string, update: AcpJsonObject, tool: AgentItemSnapshot): Generator<AgentProviderOutput> {
    const diff = acpToolDiff(update, this.context.workingDirectory);
    let item = this.files.get(nativeId);
    if (!item && !diff) return;
    if (item?.terminal) return;
    const snapshot: AgentItemSnapshot = {
      itemId: item?.snapshot.itemId ?? parseAgentItemId(`acp:item:${this.context.nextItemId()}`),
      itemKind: 'file_change', status: tool.status,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(diff ? { details: { changes: diff.changes } }
        : item?.snapshot.itemKind === 'file_change' && item.snapshot.details ? { details: item.snapshot.details } : {}),
    };
    const release = this.context.reserveState({ nativeId, snapshot });
    item?.release();
    if (!item) {
      item = { snapshot: { ...snapshot, status: snapshot.status === 'completed' || snapshot.status === 'failed' ? 'in_progress' : snapshot.status }, terminal: false, release };
      this.files.set(nativeId, item);
      yield this.event('item.started', item.snapshot);
    } else item.release = release;
    if (diff) {
      for (const delta of chunkAgentCanonicalText(diff.text)) yield this.event('content.delta', { itemId: snapshot.itemId, streamKind: 'file_change_output', delta });
    }
    item.snapshot = snapshot;
    item.terminal = snapshot.status === 'completed' || snapshot.status === 'failed';
    yield this.event(item.terminal ? 'item.completed' : 'item.updated', snapshot);
  }

  permission(params: AcpJsonObject, itemId: AgentItemId): MappedPermission {
    const tool = nativeObject(params.toolCall, 'permission tool');
    const title = displayText(tool.title, 'Agent tool');
    const { options, nativeOptions, warning } = mapAcpPermissionOptions(this.context.permissionMapping, params);
    return {
      request: parseAgentApprovalRequest({
        requestKind: 'approval',
        requestId: parseAgentRequestId(`acp:request:${this.context.nextRequestId()}`),
        prompt: title,
        subject: { kind: 'tool', title, itemId },
        options,
      }),
      nativeOptions,
      ...(warning ? { warning } : {}),
    };
  }

  *complete(payload: AgentTurnCompletedPayload): Generator<AgentProviderOutput> {
    for (const item of [...this.messages.values(), ...this.tools.values(), ...this.files.values()]) {
      if (item.terminal) continue;
      if (payload.outcome === 'completed' && (item.snapshot.itemKind === 'dynamic_tool_call' || item.snapshot.itemKind === 'file_change')) {
        item.snapshot = { ...item.snapshot, status: 'unknown' };
        yield this.event('item.updated', item.snapshot);
        continue;
      }
      item.terminal = true;
      item.snapshot = {
        ...item.snapshot,
        status: payload.outcome === 'canceled' || payload.outcome === 'expired' ? 'canceled'
          : payload.outcome === 'failed' ? 'failed' : 'completed',
      };
      yield this.event('item.completed', item.snapshot);
    }
    yield this.event('turn.completed', payload);
  }

  release(): void {
    for (const release of this.releaseState.splice(0)) release();
    this.messages.clear();
    this.tools.clear();
    for (const item of this.files.values()) item.release();
    this.files.clear();
  }
}
