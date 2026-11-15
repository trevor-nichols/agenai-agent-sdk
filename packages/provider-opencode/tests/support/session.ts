// ------------------------------------------------------------------------------------------------
//                session.ts - A registry-validated OpenCode session over a scripted native boundary
// ------------------------------------------------------------------------------------------------

import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderConversationId, parseAgentProviderKey, parseAgentSessionBinding,
  parseAgentSessionId, parseAgentTurnId, type AgentEvent,
} from '@agen-ai/agent-protocol';
import {
  createAgentProviderRegistry, defineAgentProviderDriver, type AgentApprovalPolicy, type AgentProviderOutput, type AgentProviderSession,
  type AgentProviderTurnExecution,
} from '@agen-ai/agent-runtime';
import type { NodeProviderToolCallInput, NodeProviderToolResult, NodeProviderToolSession } from '@agen-ai/provider-tools/node';
import { openCodeCapabilities } from '../../src/node/capabilities.js';
import type { PluginCall } from '../../src/node/endpoint.js';
import type { NativeEvent } from '../../src/node/native-events.js';
import type { NativeSession, NativeSignal } from '../../src/node/native.js';
import { createOpenCodeSession } from '../../src/node/session.js';
import type { NodeOpenCodeModelProvider } from '../../src/index.js';

export const NATIVE_SESSION = 'ses_native_1';
export const SCRIPTED_MODEL = Object.freeze({ provider: 'anthropic' as const, id: 'claude-sonnet-4-5' });

/**
 * Stands in for the owned server at the session boundary: native signals in, replies and controls out.
 * `interrupt` and `savedGrants` replace the native control receipts, which may stay unsettled. Without
 * `readSession` every session readback is unavailable as a lost transport would be.
 */
export function scriptedNative(options: {
  savedGrants?: () => number | Promise<number>; interrupt?: () => Promise<boolean>; readSession?: () => Promise<unknown>;
} = {}) {
  let listener: ((signal: NativeSignal) => void) | undefined;
  const replies: Array<{ id: number; text: string; isError: boolean }> = [];
  const prompts: string[] = [];
  const controls: string[] = [];
  const waiting: Array<{ id: number; resolve: (reply: { text: string; isError: boolean }) => void }> = [];
  const prompted: Array<{ count: number; resolve: () => void }> = [];
  let closeFailures = 0;
  let closes = 0;
  let nextId = 0;
  const native: NativeSession = {
    sessionID: NATIVE_SESSION,
    listen(next) { listener = next; },
    async prompt(text) {
      prompts.push(text);
      for (const waiter of prompted.filter((candidate) => prompts.length >= candidate.count)) {
        prompted.splice(prompted.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    async readSession() {
      if (!options.readSession) return { kind: 'unavailable' };
      return { kind: 'available', session: await options.readSession() };
    },
    async interrupt() { controls.push('interrupt'); return options.interrupt?.() ?? true; },
    async rejectPermission(id) { controls.push(`reject:${id}`); },
    async cancelForm(id) { controls.push(`cancel-form:${id}`); },
    async savedGrants() { return options.savedGrants?.() ?? 0; },
    reply(id, result) {
      replies.push({ id, ...result });
      const waiter = waiting.find((candidate) => candidate.id === id);
      if (waiter) { waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(result); }
    },
    async close() {
      closes += 1;
      if (closeFailures > 0) { closeFailures -= 1; throw new Error('The OpenCode server group survived.'); }
    },
  };
  return {
    native,
    replies,
    prompts,
    controls,
    emit(signal: NativeSignal) { listener?.(signal); },
    event(event: NativeEvent) { listener?.({ type: 'event', event }); },
    /** Sends one plugin call and resolves with the driver's single reply. */
    call(tool: PluginCall['tool'], input: Record<string, unknown>, ids: Partial<Pick<PluginCall, 'callID' | 'messageID' | 'sessionID'>> = {}) {
      const id = ++nextId;
      const reply = new Promise<{ text: string; isError: boolean }>((resolve) => { waiting.push({ id, resolve }); });
      listener?.({ type: 'call', call: { id, tool, input, sessionID: NATIVE_SESSION, messageID: 'msg_1', callID: `toolu_${id}`, ...ids } });
      return { id, reply };
    },
    /** Resolves once the driver has sent `count` prompts in total. */
    prompted(count = 1): Promise<void> {
      if (prompts.length >= count) return Promise.resolve();
      return new Promise((resolve) => { prompted.push({ count, resolve }); });
    },
    failClose(count: number) { closeFailures = count; },
    get closes() { return closes; },
  };
}

export function scriptedTools(script: (input: NodeProviderToolCallInput) => Promise<NodeProviderToolResult>) {
  const calls: NodeProviderToolCallInput[] = [];
  let closes = 0;
  let closeFailures = 0;
  const tools: NodeProviderToolSession = {
    call(input) { calls.push(input); return script(input); },
    fence: undefined,
    async idle() {},
    async close() {
      closes += 1;
      if (closeFailures > 0) { closeFailures -= 1; throw new Error('A command descendant survived.'); }
    },
  };
  return { tools, calls, failClose(count: number) { closeFailures = count; }, get closes() { return closes; } };
}

/** The approval signal follows call cancellation, as the broker's does. */
export function approvalSignal(call: NodeProviderToolCallInput): AbortSignal {
  const controller = new AbortController();
  call.signal.addEventListener('abort', () => controller.abort('canceled'), { once: true });
  return controller.signal;
}

export async function openValidatedSession(options: {
  native: NativeSession;
  tools: NodeProviderToolSession;
  approvalPolicy?: AgentApprovalPolicy;
  release?: () => Promise<void>;
  model?: Readonly<{ provider: NodeOpenCodeModelProvider; id: string }>;
}): Promise<AgentProviderSession> {
  const providerKey = parseAgentProviderKey('opencode');
  const instanceId = parseAgentInstanceId('opencode-test');
  const model = options.model ?? SCRIPTED_MODEL;
  const driver = defineAgentProviderDriver({
    providerKey, supportsMultipleInstances: false, parseConfiguration: () => ({}),
    createInstance: () => ({
      instanceId, capabilities: openCodeCapabilities(providerKey, model.provider),
      adapter: {
        approvalPolicy: { kind: 'supported', policies: [{ policy: 'host', operations: ['create'] }, { policy: 'provider_accept_edits', operations: ['create'] }] },
        createSession: (openingInput) => {
          const binding = parseAgentSessionBinding({ conversationId: parseAgentProviderConversationId('opencode:test') });
          const session = createOpenCodeSession({
            providerKey, openingInput, sessionId: openingInput.sessionId, tools: options.tools, native: options.native, binding, model,
            approvalPolicy: openingInput.approvalPolicy ? { policy: { kind: openingInput.approvalPolicy.kind }, verification: 'controlled_configuration' } : undefined,
            release: options.release ?? (async () => {}),
          });
          openingInput.onBindingCreated(binding);
          return session;
        },
        resumption: { kind: 'unsupported' }, branching: { kind: 'unsupported' }, authentication: { kind: 'unsupported' },
      },
      accountQuota: { kind: 'unsupported' }, environment: { kind: 'unsupported' },
      checkReadiness: () => { throw new Error('unused'); }, dispose: () => {},
    }),
  });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [{ providerKey, instanceId, driverConfiguration: {} }] });
  return registry.requireInstance(instanceId).adapter.createSession({
    sessionId: parseAgentSessionId('opencode-session:1'), workingDirectory: '/work',
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('configuration:1') },
    onBindingCreated: () => undefined, ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
  });
}

export function startText(session: AgentProviderSession, turn: string, signal?: AbortSignal): AgentProviderTurnExecution {
  return session.startTurn({ turnId: parseAgentTurnId(turn), interactionMode: 'default', parts: [{ type: 'text', text: 'Do the task.' }],
    ...(signal ? { signal } : {}) });
}

/** Reads validated outputs until `stop` matches, returning every event seen including the match. */
export async function readUntil(iterator: AsyncIterator<AgentProviderOutput>, stop: (event: AgentEvent) => boolean) {
  const events: Array<{ event: AgentEvent; output: AgentProviderOutput }> = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error(`The turn ended after ${events.map((entry) => entry.event.type).join(', ')}.`);
    if (next.value.kind !== 'event') continue;
    events.push({ event: next.value.event, output: next.value });
    if (stop(next.value.event)) return events;
  }
}

export function outcome(events: ReadonlyArray<{ event: AgentEvent }>) {
  const event = events.at(-1)?.event;
  return event?.type === 'turn.completed' ? event.payload.outcome : undefined;
}
