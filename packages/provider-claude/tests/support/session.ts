// ------------------------------------------------------------------------------------------------
//                session.ts - A registry-validated Claude session over a scripted worker and tool session
// ------------------------------------------------------------------------------------------------

import {
  parseAgentApprovalOptionId, parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderConversationId, parseAgentProviderKey, parseAgentSessionBinding,
  parseAgentSessionId, parseAgentTurnId, type AgentEvent, type AgentRequest,
} from '@agen-ai/agent-protocol';
import {
  createAgentProviderRegistry, defineAgentProviderDriver, type AgentApprovalPolicy, type AgentProviderOutput, type AgentProviderSession,
  type AgentProviderTurnExecution,
} from '@agen-ai/agent-runtime';
import type { NodeProviderToolCallInput, NodeProviderToolResult, NodeProviderToolSession } from '@agen-ai/provider-tools/node';
import { claudeCapabilities } from '../../src/node/capabilities.js';
import type { WorkerEvent, WorkerProcess } from '../../src/node/process.js';
import type { DriverMessage } from '../../src/node/protocol.js';
import { createClaudeSession } from '../../src/node/session.js';
import { ownedToolNames } from '../../src/node/turn.js';

export const OWNED = [...ownedToolNames(['read', 'glob', 'grep', 'write', 'edit', 'patch', 'bash'])];
export const MODEL = 'claude-test';
/** A turn result whose usage, model usage and result index Claude omitted. */
export const RESULT: Extract<WorkerEvent, { type: 'result' }> = Object.freeze({
  type: 'result', subtype: 'success', isError: false, denials: [], resultIndex: null, usage: null, modelUsage: null,
});
/** The init Claude reports for the bound configuration. */
export const INIT = Object.freeze({ type: 'init', tools: OWNED, model: MODEL, permissionMode: 'default', claudeCodeVersion: '2.1.322' } as const);

/** Stands in for the worker process at its wire contract: parsed messages each way and a joinable close. */
export function scriptedWorker() {
  let listener: ((event: WorkerEvent) => void) | undefined;
  const sent: DriverMessage[] = [];
  const taken = new Set<number>();
  const waiting: Array<{ type: DriverMessage['type']; resolve: (message: DriverMessage) => void }> = [];
  let closeFailures = 0;
  let closes = 0;
  const take = (type: DriverMessage['type']) => {
    const index = sent.findIndex((message, position) => message.type === type && !taken.has(position));
    if (index === -1) return undefined;
    taken.add(index);
    return sent[index];
  };
  const worker: WorkerProcess = {
    listen(next) { listener = next; },
    send(message) {
      sent.push(message);
      const waiter = waiting.find((candidate) => candidate.type === message.type);
      if (waiter) { waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(take(message.type)!); }
    },
    async close() {
      closes += 1;
      if (closeFailures > 0) { closeFailures -= 1; throw new Error('The worker process group survived.'); }
    },
  };
  return {
    worker,
    sent,
    emit(event: WorkerEvent) { listener?.(event); },
    /** Resolves with the oldest message of `type` not yet taken, waiting for it if necessary. */
    next<Type extends DriverMessage['type']>(type: Type): Promise<Extract<DriverMessage, { type: Type }>> {
      const found = take(type);
      if (found) return Promise.resolve(found as Extract<DriverMessage, { type: Type }>);
      return new Promise((resolve) => { waiting.push({ type, resolve: resolve as (message: DriverMessage) => void }); });
    },
    failClose(count: number) { closeFailures = count; },
    get closes() { return closes; },
  };
}

export function scriptedTools(script: (input: NodeProviderToolCallInput) => Promise<NodeProviderToolResult>) {
  const calls: NodeProviderToolCallInput[] = [];
  let closes = 0;
  const tools: NodeProviderToolSession = {
    call(input) { calls.push(input); return script(input); },
    fence: undefined,
    async idle() {},
    async close() { closes += 1; },
  };
  return { tools, calls, get closes() { return closes; } };
}

/** The approval signal follows call cancellation, as the broker's does. */
export function approvalSignal(call: NodeProviderToolCallInput): AbortSignal {
  const controller = new AbortController();
  call.signal.addEventListener('abort', () => controller.abort('canceled'), { once: true });
  return controller.signal;
}

export async function openValidatedSession(options: {
  worker: WorkerProcess;
  tools: NodeProviderToolSession;
  approvalPolicy?: AgentApprovalPolicy;
  model?: string;
}): Promise<AgentProviderSession> {
  const providerKey = parseAgentProviderKey('claude');
  const instanceId = parseAgentInstanceId('claude-test');
  const driver = defineAgentProviderDriver({
    providerKey, supportsMultipleInstances: false, parseConfiguration: () => ({}),
    createInstance: () => ({
      instanceId, capabilities: claudeCapabilities(providerKey),
      adapter: {
        approvalPolicy: { kind: 'supported', policies: [{ policy: 'host', operations: ['create'] }, { policy: 'provider_accept_edits', operations: ['create'] }] },
        createSession: (openingInput) => {
          const binding = parseAgentSessionBinding({ conversationId: parseAgentProviderConversationId('claude:test') });
          const session = createClaudeSession({
            providerKey, openingInput, sessionId: openingInput.sessionId, tools: options.tools, worker: options.worker, ownedTools: new Set(OWNED), binding,
            model: options.model ?? MODEL,
            approvalPolicy: openingInput.approvalPolicy ? { policy: { kind: openingInput.approvalPolicy.kind }, verification: 'controlled_configuration' } : undefined,
            release: async () => {},
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
    sessionId: parseAgentSessionId('claude-session:1'), workingDirectory: '/work', configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('configuration:1') },
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

export const APPROVE = parseAgentApprovalOptionId('approval:approve-once');
export const DENY = parseAgentApprovalOptionId('approval:deny-once');
export const is = (type: AgentEvent['type']) => (event: AgentEvent) => event.type === type;
export function outcome(events: ReadonlyArray<{ event: AgentEvent }>) {
  const event = events.at(-1)?.event;
  return event?.type === 'turn.completed' ? event.payload.outcome : undefined;
}
export const ran: NodeProviderToolResult = { tool: 'bash', status: 'completed', text: 'exit 0\nhello', isError: false, changes: [],
  command: { reason: 'exited', exitCode: 0, signal: null, durationMs: 3, outputBytes: 6, truncated: false, joined: true } };

/**
 * The broker's command path as observed by a driver: started, one exact approval, then the effect or a denial.
 * `effect` stands for the command itself and runs only on an approval.
 */
export function commandTools(effect?: () => Promise<void>) {
  return scriptedTools(async (call: NodeProviderToolCallInput) => {
    const command = (call.input as { command: string }).command;
    call.observer.started({ kind: 'command', command });
    const decision = await call.observer.approve({ kind: 'command', command }, approvalSignal(call));
    if (decision !== 'approved') return { tool: 'bash', status: call.signal.aborted ? 'canceled' : 'denied', text: 'Command not run.', isError: true, changes: [] };
    await effect?.();
    return ran;
  });
}

export function answer(execution: AgentProviderTurnExecution, request: AgentRequest, optionId: typeof APPROVE) {
  return execution.resolveRequest({ resolution: { requestKind: 'approval', requestId: request.requestId, disposition: 'selected', optionId } });
}

export async function toolCall(worker: ReturnType<typeof scriptedWorker>, command: string) {
  await worker.next('prompt');
  worker.emit({ ...INIT });
  worker.emit({ type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command }, nativeRef: 'toolu_1' });
}