import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentProviderKey, parseAgentSessionId, parseAgentTurnId,
  type AgentEvent, type AgentTokenUsageObservation,
} from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, type AgentProviderSession, type AgentProviderTurnExecution } from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver } from '../../src/node/index.js';

// A scripted ACP peer over in-memory pipes. It answers each `session/prompt` from its own script and
// never stands in for native Grok behavior; native shapes are recorded in the MS005 source evidence.

export const NATIVE_SESSION_ID = 'bac753c8-754b-43f4-85eb-d40fc91145e7';
const instanceId = parseAgentInstanceId('controlled:usage');
const providerKey = parseAgentProviderKey('controlled-grok-usage');
const configOptions: AcpJsonValue[] = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'grok-4.6',
  options: [{ value: 'grok-4.6', name: 'Grok 4.6' }] }, { id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level',
  type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] }];
const opening: AcpJsonObject = { sessionId: NATIVE_SESSION_ID, models: { currentModelId: 'grok-4.6',
  availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6' }] }, configOptions,
_meta: { currentWorkingDirectory: '/workspace/work', 'x.ai/sessionDetail': {
  sessionId: NATIVE_SESSION_ID, cwd: '/workspace/work', currentModelId: 'grok-4.6', kind: 'build' } } };

type Reply = Readonly<{ result: AcpJsonObject }> | Readonly<{ error: AcpJsonObject }>;
/** Frames sent after the prompt arrives, then its reply; without a reply the peer waits for `session/cancel`. */
export type PromptScript = Readonly<{ before?: readonly AcpJsonObject[]; reply?: Reply; onCancel?: Reply; repeatReply?: boolean }>;

/** A native whole-prompt usage record shaped like the pinned 1.0.77 `PromptUsage`. */
export function promptUsage(values: Readonly<Record<string, AcpJsonValue>>): AcpJsonObject {
  return { apiDurationMs: 900, costUsdTicks: 8_996_400, ...values };
}
export const notification = (method: string, update: AcpJsonObject): AcpJsonObject =>
  ({ method, params: { sessionId: NATIVE_SESSION_ID, update } });
export const agentText = (text: string) => notification('session/update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

export async function controlledUsagePeer(t: TestContext, prompts: readonly PromptScript[], options: { dialect?: boolean } = {}) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const methods: string[] = [];
  let partial = '';
  let prompt = 0;
  let pending: { id: AcpJsonValue; script: PromptScript } | undefined;
  let releases = 0;
  const send = (value: AcpJsonObject) => { stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); };
  const reply = (id: AcpJsonValue, value: Reply) => send({ id, ...value });
  stdin.on('data', (chunk: Buffer) => {
    partial += chunk.toString('utf8');
    let end: number;
    while ((end = partial.indexOf('\n')) >= 0) {
      const frame = JSON.parse(partial.slice(0, end)) as AcpJsonObject;
      partial = partial.slice(end + 1);
      if (typeof frame.method === 'string') methods.push(frame.method);
      if (frame.method === 'initialize') send({ id: frame.id!, result: { protocolVersion: 1, agentCapabilities: { loadSession: true },
        _meta: { agentVersion: '1.0.77', grokShell: true, currentWorkingDirectory: '/workspace/work', modelState: { currentModelId: 'grok-4.6' } } } });
      else if (frame.method === 'session/new') send({ id: frame.id!, result: opening });
      else if (frame.method === 'session/prompt') {
        const script = prompts[prompt++] ?? {};
        for (const before of script.before ?? []) send(before);
        if (script.reply) {
          reply(frame.id!, script.reply);
          if (script.repeatReply) reply(frame.id!, script.reply);
        } else pending = { id: frame.id!, script };
      } else if (frame.method === 'session/cancel' && pending) {
        const { id, script } = pending;
        pending = undefined;
        reply(id, script.onCancel ?? { result: { stopReason: 'cancelled' } });
      }
    }
  });
  const driver = createNodeAcpProviderDriver({ providerKey, launch: { executable: '/opt/agenai/bin/launch-grok', cwd: '/workspace/work' },
    executionBoundary: { reserve() {
      let released = false;
      return { start() { return { stdin, stdout }; }, release() {
        if (!released) { releases += 1; released = true; stdin.destroy(); stdout.destroy(); }
      } };
    } },
    ...(options.dialect === false ? {} : { protocolDialect: {
      mapping: 'grok-build-1.0.77-controlled-shell-v1' as const, instanceId, nativeSessionId: NATIVE_SESSION_ID, policy: 'host' as const } }),
  });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [{ providerKey, instanceId, driverConfiguration: {} }] });
  t.after(() => registry.dispose());
  const instance = registry.requireInstance(instanceId);
  const session = await instance.adapter.createSession({ sessionId: parseAgentSessionId('controlled:usage:session'),
    workingDirectory: '/workspace/work', onBindingCreated() {},
    configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('controlled:configuration') } });
  return { session, capabilities: instance.capabilities, methods, releases: () => releases };
}

export const startText = (session: AgentProviderSession, turn: string): AgentProviderTurnExecution => session.startTurn({
  turnId: parseAgentTurnId(turn), interactionMode: 'default', parts: [{ type: 'text', text: 'Answer briefly.' }] });

/** Every event of one validated turn read to its end. */
export async function readTurn(execution: AgentProviderTurnExecution): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const output of execution.outputs) if (output.kind === 'event') events.push(output.event);
  return events;
}
export const usageOf = (events: readonly AgentEvent[]): AgentTokenUsageObservation[] =>
  events.flatMap((event) => event.type === 'usage.observed' ? [event.payload] : []);
export const outcomeOf = (events: readonly AgentEvent[]): string[] => events.flatMap((event) => event.type === 'turn.completed'
  ? [event.payload.reason ? `${event.payload.outcome}: ${event.payload.reason}` : event.payload.outcome] : []);
