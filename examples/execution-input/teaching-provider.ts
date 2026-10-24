import { setImmediate } from 'node:timers/promises';
import {
  parseAgentCapabilities, parseAgentInstanceId, parseAgentProviderConversationId,
} from '@agen-ai/agent-protocol';
import {
  createAgentEventOutput, createAgentProviderReadiness, validateAgentProviderAdapter,
  type AgentExecutionInputMessage, type AgentExecutionInputOutcome, type AgentExecutionInputReceipt,
  type AgentExecutionInputSupport, type AgentProviderOutput, type AgentProviderSession,
  type ValidatedMaterializedAgentProviderInstance,
} from '@agen-ai/agent-runtime';
import { deferred } from './support.js';

export type Scenario = 'accepted-consumed' | 'accepted-unconfirmed' | 'native-rejected'
  | 'delivery-uncertain' | 'unsupported';

const capabilities = parseAgentCapabilities({
  protocolVersion: 13, providerKey: 'example-execution-input',
  sessions: { create: true, resume: false, branch: { kind: 'unsupported' } },
  turns: { structuredOutput: { kind: 'unsupported' }, interactionModes: ['default'], interrupt: false, steer: { kind: 'unsupported' } },
  requests: { approval: { kind: 'unsupported' }, elicitation: { kind: 'unsupported' } },
  context: { usage: { kind: 'unsupported' }, compaction: { kind: 'unsupported' } },
  input: { text: true, images: { kind: 'unsupported' }, contentReferences: { kind: 'unsupported' } },
  output: { streaming: true, plans: false, fileChanges: 'none', artifactKinds: [] },
  configuration: { kind: 'managed' }, operations: { kind: 'unsupported' },
  managedContent: { kind: 'unsupported' }, integrations: { kind: 'unsupported' },
  environment: { instance: { kind: 'unsupported' }, session: { kind: 'unsupported' } },
  collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
  authentication: { kind: 'unsupported' }, versionReporting: false,
});

// Caller-owned teaching provider: no native process, model, credential, network, tool, or storage.
// These gates declare synthetic semantics. They are not evidence for any native provider mapping.
export function createTeachingProvider(scenario: Scenario) {
  const statistics = { starts: 0, outputReaders: 0, inputCalls: 0, producerJoins: 0,
    sessionCloses: 0, instanceDisposals: 0 };
  const submissions: AgentExecutionInputMessage[] = [];
  const support: Extract<AgentExecutionInputSupport, { kind: 'supported' }> = {
    kind: 'supported', delivery: 'current_or_owned_continuation',
    consumptionReporting: scenario === 'accepted-unconfirmed' ? 'unavailable' : 'message_ids',
    input: capabilities.input,
    limits: { maxOutstandingMessages: 1, maxMessagesPerExecution: 1, maxBufferedBytes: 4_096 },
  };
  const sessions: AgentProviderSession[] = [];
  let disposed = false;
  const adapter = validateAgentProviderAdapter(capabilities, {
    ...(scenario === 'unsupported' ? {} : { executionInput: support }),
    resumption: { kind: 'unsupported' }, branching: { kind: 'unsupported' },
    authentication: { kind: 'unsupported' },
    createSession(context): AgentProviderSession {
      const binding = { conversationId: parseAgentProviderConversationId(`teaching:${scenario}:conversation`) };
      context.onBindingCreated(binding);
      const submitted = deferred<AgentExecutionInputMessage | undefined>();
      const receiptReady = deferred<void>();
      const settlement = deferred<AgentExecutionInputOutcome>();
      let producer: AsyncGenerator<AgentProviderOutput, void> | undefined;
      let closed = false;
      const session: AgentProviderSession = {
        binding, interruption: { kind: 'unsupported' }, steering: { kind: 'unsupported' },
        configuration: { kind: 'managed' }, operations: { kind: 'unsupported' },
        managedContent: { kind: 'unsupported' }, environment: { kind: 'unsupported' },
        collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
        startTurn(turn) {
          statistics.starts += 1;
          const base = { protocolVersion: 13 as const, sessionId: context.sessionId, turnId: turn.turnId,
            occurredAt: '2026-10-23T12:00:00.000Z' };
          return {
            turnId: turn.turnId,
            ...(scenario === 'unsupported' ? {} : { input: {
              kind: 'supported' as const, support,
              async sendMessage(message: AgentExecutionInputMessage): Promise<AgentExecutionInputReceipt> {
                statistics.inputCalls += 1;
                submissions.push(message);
                submitted.resolve(message);
                // Output must progress on the same iterator before this authoritative fixture receipt.
                await receiptReady.promise;
                if (scenario === 'native-rejected' || scenario === 'delivery-uncertain') {
                  return { status: scenario === 'native-rejected' ? 'rejected' : 'delivery_uncertain',
                    messageId: message.messageId, error: {
                      category: scenario === 'native-rejected' ? 'permission' : 'transport',
                      code: scenario === 'native-rejected' ? 'teaching_native_refusal' : 'teaching_receipt_lost',
                      message: scenario === 'native-rejected' ? 'The teaching provider refused before native admission.'
                        : 'The teaching provider cannot confirm whether delivery occurred.',
                      recovery: { kind: 'none' },
                    } };
                }
                return { status: 'accepted', messageId: message.messageId, settled: settlement.promise };
              },
            } }),
            outputs: {
              [Symbol.asyncIterator]() {
                statistics.outputReaders += 1;
                producer = (async function* () {
                  try {
                    yield createAgentEventOutput({ ...base, type: 'turn.started', payload: {} });
                    const message = scenario === 'unsupported' ? undefined : await submitted.promise;
                    if (closed) return;
                    yield createAgentEventOutput({ ...base, type: 'item.started', payload: {
                      itemId: 'teaching:message', itemKind: 'assistant_message', status: 'in_progress',
                    } });
                    yield createAgentEventOutput({ ...base, type: 'content.delta', payload: {
                      itemId: 'teaching:message', streamKind: 'assistant_text', delta: 'Original task remains owned.\n',
                    } });
                    receiptReady.resolve();
                    // Hand the receipt back to the caller before the next synthetic output arrives.
                    await setImmediate();
                    yield createAgentEventOutput({ ...base, type: 'content.delta', payload: {
                      itemId: 'teaching:message', streamKind: 'assistant_text', delta: 'Teaching provider completed.\n',
                    } });
                    if (message !== undefined && scenario === 'accepted-consumed') {
                      settlement.resolve({ status: 'consumed', messageId: message.messageId, turnId: turn.turnId,
                        placement: 'owned_native_continuation' });
                    } else if (message !== undefined && scenario === 'accepted-unconfirmed') {
                      settlement.resolve({ status: 'unconfirmed', messageId: message.messageId,
                        reason: 'provider_does_not_report_consumption' });
                    }
                    yield createAgentEventOutput({ ...base, type: 'item.completed', payload: {
                      itemId: 'teaching:message', itemKind: 'assistant_message', status: 'completed',
                    } });
                    yield createAgentEventOutput({ ...base, type: 'turn.completed', payload: {
                      outcome: 'completed', structuredOutput: { kind: 'not_requested' },
                    } });
                  } finally { statistics.producerJoins += 1; }
                })();
                return producer;
              },
            },
            async resolveRequest() { throw new Error('The teaching provider opens no human request.'); },
          };
        },
        async close() {
          if (closed) return;
          closed = true;
          submitted.resolve(undefined);
          receiptReady.resolve();
          const message = submissions[0];
          if (message) settlement.resolve({ status: 'unconfirmed', messageId: message.messageId, reason: 'closed' });
          // Unblock owned waits before joining the actual iterator, even on a failed application path.
          await producer?.return(undefined);
          statistics.sessionCloses += 1;
        },
      };
      sessions.push(session);
      return session;
    },
  });
  const instance: ValidatedMaterializedAgentProviderInstance = {
    instanceId: parseAgentInstanceId(`teaching:${scenario}`), capabilities, adapter,
    accountQuota: { kind: 'unsupported' }, environment: { kind: 'unsupported' },
    checkReadiness: () => createAgentProviderReadiness({ status: 'ready', checkedAt: '2026-10-23T12:00:00.000Z' }),
    async dispose() {
      if (disposed) return;
      // The instance retains every session until its native producer has joined successfully.
      for (const session of sessions) await session.close({ reason: 'shutdown' });
      disposed = true;
      statistics.instanceDisposals += 1;
    },
  };
  return { instance, statistics, submissions };
}
