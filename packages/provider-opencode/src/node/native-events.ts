// ------------------------------------------------------------------------------------------------
//                native-events.ts - Exhaustive classification of OpenCode 2.2.7 V2 events
// ------------------------------------------------------------------------------------------------

import type { V2Event } from '@opencode/client';
import { z } from 'zod/v4';

/**
 * `opening` events form the location-load burst that ends with `plugin.updated`; afterwards they
 * are configuration drift. `request` events need a native reply. `drift` always fences the session.
 * `usage` events carry session snapshots and model-step accounting. `turn`, `usage`, `benign` and
 * `request` events carry a required session identity in the 2.2.7 schema; only `global` events have none.
 */
type EventClass = 'connected' | 'created' | 'opening' | 'turn' | 'usage' | 'benign' | 'global' | 'request' | 'drift';

const CLASSES: Readonly<Record<Exclude<V2Event['type'], `rpc.${string}`>, EventClass>> = {
  'server.connected': 'connected',
  'session.created': 'created',
  'integration.updated': 'opening', 'provider.updated': 'opening', 'model.updated': 'opening', 'agent.updated': 'opening',
  'command.updated': 'opening', 'skill.updated': 'opening', 'websearch.updated': 'opening', 'reference.updated': 'opening',
  'plugin.updated': 'opening',
  'session.execution.started': 'turn', 'session.execution.succeeded': 'turn', 'session.execution.failed': 'turn',
  'session.execution.interrupted': 'turn', 'session.text.started': 'turn', 'session.text.delta': 'turn', 'session.text.ended': 'turn',
  'session.reasoning.started': 'turn', 'session.reasoning.delta': 'turn', 'session.reasoning.ended': 'turn',
  'session.tool.input.started': 'turn', 'session.tool.called': 'turn',
  'project.updated': 'global', 'filesystem.changed': 'global', 'session.usage.updated': 'usage', 'session.status': 'benign',
  'session.idle': 'benign', 'session.inbox.enqueued': 'benign', 'session.inbox.delivered': 'benign',
  'session.instructions.updated': 'benign', 'session.step.started': 'usage', 'session.step.streamed': 'benign',
  'session.step.ended': 'usage', 'session.step.failed': 'usage', 'session.tool.input.delta': 'benign',
  'session.tool.input.ended': 'benign', 'session.tool.progress': 'benign', 'session.tool.success': 'benign',
  'session.tool.failed': 'benign', 'permission.replied': 'benign', 'form.cancelled': 'benign',
  'permission.asked': 'request', 'form.created': 'request',
  'location.shutdown': 'drift', 'models-dev.refreshed': 'drift', 'credential.updated': 'drift', 'credential.switched': 'drift',
  'config.updated': 'drift', 'session.agent.selected': 'drift', 'session.model.selected': 'drift', 'session.moved': 'drift',
  'session.renamed': 'drift', 'session.metadata.updated': 'drift', 'session.permissions': 'drift', 'session.viewed': 'drift',
  'session.archived': 'drift', 'session.unarchived': 'drift', 'session.deleted': 'drift', 'session.forked': 'drift',
  'session.inbox.cancelled': 'drift', 'session.inbox.delivery.changed': 'drift', 'session.synthetic': 'drift',
  'session.skill.activated': 'drift', 'session.shell.started': 'drift', 'session.shell.ended': 'drift',
  'session.retry.scheduled': 'drift', 'session.compaction.started': 'drift', 'session.compaction.delta': 'drift',
  'session.compaction.ended': 'drift', 'session.compaction.failed': 'drift', 'session.revert.staged': 'drift',
  'session.revert.cleared': 'drift', 'session.revert.committed': 'drift', 'worktree.updated': 'drift', 'worktree.resolved': 'drift',
  'pty.created': 'drift', 'pty.updated': 'drift', 'pty.exited': 'drift', 'pty.deleted': 'drift', 'persistent-pty.added': 'drift',
  'persistent-pty.removed': 'drift', 'persistent-pty.updated': 'drift', 'shell.created': 'drift', 'shell.exited': 'drift',
  'shell.deleted': 'drift', 'form.replied': 'drift', 'artifact.updated': 'drift', 'tui.prompt.append': 'drift',
  'tui.command.execute': 'drift', 'tui.toast.show': 'drift', 'tui.session.select': 'drift', 'installation.updated': 'drift',
  'installation.update-available': 'drift', 'vcs.branch.updated': 'drift', 'mcp.status.changed': 'drift', 'mcp.resources.changed': 'drift',
};

/** OpenCode's exclusive token buckets: uncached input, cache reads, cache writes, visible output and reasoning. */
export type NativeTokens = Readonly<{ input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }>;
/** Counters outside non-negative safe integers are kept as `invalid` for the usage contract to reject. */
export type NativeUsage = NativeTokens | 'invalid';
export type NativeModel = Readonly<{ providerID: string; id: string }>;

export type NativeEvent =
  | Readonly<{ kind: 'connected' }>
  | Readonly<{ kind: 'created'; sessionID: string }>
  | Readonly<{ kind: 'opening'; type: string }>
  | Readonly<{ kind: 'benign' }>
  | Readonly<{ kind: 'drift'; type: string }>
  | Readonly<{ kind: 'execution_started' }>
  | Readonly<{ kind: 'execution_succeeded' }>
  | Readonly<{ kind: 'execution_failed'; message: string }>
  | Readonly<{ kind: 'execution_interrupted' }>
  | Readonly<{ kind: 'text'; stream: 'assistant' | 'reasoning'; phase: 'started' | 'delta' | 'ended'; key: string; text: string }>
  | Readonly<{ kind: 'tool_input'; callID: string; name: string }>
  | Readonly<{ kind: 'tool_called'; callID: string; executed: boolean }>
  | Readonly<{ kind: 'permission_asked'; requestID: string }>
  | Readonly<{ kind: 'form_created'; formID: string }>
  | Readonly<{ kind: 'session_usage'; tokens: NativeUsage }>
  | Readonly<{ kind: 'step_started'; messageID: string; model: NativeModel }>
  | Readonly<{ kind: 'step_ended'; messageID: string; tokens: NativeUsage }>
  /** `null` when OpenCode recorded no usage for the failed step. */
  | Readonly<{ kind: 'step_failed'; messageID: string; tokens: NativeUsage | null }>;

const id = z.string().min(1).max(256);
const envelope = z.object({ type: z.string().max(128), data: z.record(z.string(), z.unknown()) });
const scoped = z.object({ sessionID: id });
const message = z.object({ sessionID: id, assistantMessageID: id, ordinal: z.number().int().nonnegative() });
const streamed = message.extend({ delta: z.string() });
const ended = message.extend({ text: z.string() });
const toolInput = z.object({ sessionID: id, id, name: z.string().max(256) });
const toolCalled = z.object({ sessionID: id, id, executed: z.boolean() });
const failed = z.object({ sessionID: id, error: z.object({ message: z.string().optional() }).passthrough() });
const permission = z.object({ sessionID: id, id });
const form = z.object({ form: z.object({ id, sessionID: id }) });
const usageUpdated = z.object({ sessionID: id, tokens: z.unknown() });
const stepStarted = z.object({ sessionID: id, assistantMessageID: id, model: z.object({ providerID: id, id }) });
const stepEnded = z.object({ sessionID: id, assistantMessageID: id, tokens: z.unknown() });
const stepFailed = z.object({ sessionID: id, assistantMessageID: id, tokens: z.unknown().optional() });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tokens = z.object({ input: count, output: count, reasoning: count, cache: z.object({ read: count, write: count }) });

export class NativeEventError extends Error {}

/** One native `TokenUsageInfo`, from an event or a session readback. */
export function nativeUsage(value: unknown): NativeUsage {
  const parsed = tokens.safeParse(value);
  if (!parsed.success) return 'invalid';
  const { input, output, reasoning, cache } = parsed.data;
  return Object.freeze({ input, cacheRead: cache.read, cacheWrite: cache.write, output, reasoning });
}

function data<T>(schema: z.ZodType<T>, value: unknown, type: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NativeEventError(`OpenCode sent a malformed ${type} event.`);
  return parsed.data;
}

/** Classifies one decoded native event; session-scoped events for another session are drift. */
export function classifyNativeEvent(raw: unknown, sessionID: string | undefined): NativeEvent {
  const event = data(envelope, raw, 'native');
  const type = event.type;
  const known = type.startsWith('rpc.') ? 'drift' : (CLASSES as Readonly<Record<string, EventClass>>)[type];
  if (known === undefined) return { kind: 'drift', type };
  if (known === 'connected') return { kind: 'connected' };
  if (known === 'created') return { kind: 'created', sessionID: data(scoped, event.data, type).sessionID };
  if (known === 'opening') return { kind: 'opening', type };
  if (known === 'drift') return { kind: 'drift', type };
  if (known === 'global') return { kind: 'benign' };
  if (type === 'form.created') {
    const parsed = data(form, event.data, type).form;
    return parsed.sessionID === sessionID ? { kind: 'form_created', formID: parsed.id } : { kind: 'drift', type };
  }
  if (data(scoped, event.data, type).sessionID !== sessionID) return { kind: 'drift', type };
  if (known === 'benign') return { kind: 'benign' };
  switch (type) {
    case 'session.usage.updated': return { kind: 'session_usage', tokens: nativeUsage(data(usageUpdated, event.data, type).tokens) };
    case 'session.step.started': {
      const parsed = data(stepStarted, event.data, type);
      return { kind: 'step_started', messageID: parsed.assistantMessageID, model: { providerID: parsed.model.providerID, id: parsed.model.id } };
    }
    case 'session.step.ended': {
      const parsed = data(stepEnded, event.data, type);
      return { kind: 'step_ended', messageID: parsed.assistantMessageID, tokens: nativeUsage(parsed.tokens) };
    }
    case 'session.step.failed': {
      const parsed = data(stepFailed, event.data, type);
      return { kind: 'step_failed', messageID: parsed.assistantMessageID, tokens: parsed.tokens === undefined ? null : nativeUsage(parsed.tokens) };
    }
    case 'permission.asked': return { kind: 'permission_asked', requestID: data(permission, event.data, type).id };
    case 'session.execution.started': return { kind: 'execution_started' };
    case 'session.execution.succeeded': return { kind: 'execution_succeeded' };
    case 'session.execution.interrupted': return { kind: 'execution_interrupted' };
    case 'session.execution.failed': return { kind: 'execution_failed', message: data(failed, event.data, type).error.message ?? 'OpenCode execution failed.' };
    case 'session.tool.input.started': {
      const parsed = data(toolInput, event.data, type);
      return { kind: 'tool_input', callID: parsed.id, name: parsed.name };
    }
    case 'session.tool.called': {
      const parsed = data(toolCalled, event.data, type);
      return { kind: 'tool_called', callID: parsed.id, executed: parsed.executed };
    }
  }
  const stream = type.startsWith('session.reasoning.') ? 'reasoning' : 'assistant';
  const phase = type.endsWith('.started') ? 'started' : type.endsWith('.delta') ? 'delta' : 'ended';
  const parsed = data(phase === 'delta' ? streamed : phase === 'ended' ? ended : message, event.data, type) as z.infer<typeof message> & { delta?: string; text?: string };
  return { kind: 'text', stream, phase, key: `${parsed.assistantMessageID}:${parsed.ordinal}`, text: parsed.delta ?? parsed.text ?? '' };
}
