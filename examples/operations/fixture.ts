import assert from 'node:assert/strict';
import {
  parseAgentCapabilities, parseAgentConfigurationRevisionId, parseAgentIsoDateTime,
  parseAgentOperationId, parseAgentRequestFieldId, parseAgentSessionId, type AgentOperationDescriptor,
} from '@agen-ai/agent-protocol';
import { createAgentEventOutput, throwIfAgentOperationAborted, validateAgentProviderAdapter, type AgentProviderInvokeOperationInput } from '@agen-ai/agent-runtime';
import { createFakeAgentProvider } from '@agen-ai/agent-runtime/testing';

export const exampleOperationId = parseAgentOperationId('example.compact-context');
export type Scenario = 'unsupported' | 'missing' | 'fields' | 'declined' | 'effect' | 'no_effect'
  | 'pre_abort' | 'entered_abort';

export class OperationExampleCleanupError extends Error {
  constructor(cause: unknown, readonly retryCleanup: () => Promise<void>) {
    super('Operation example cleanup is incomplete; retain this owner and retry cleanup.', { cause });
    this.name = 'OperationExampleCleanupError';
  }
}

// Synthetic public-SPI fixture: no native process, account, network, tool or real compaction.
export async function createOperationExample(scenario: Scenario, cancel: AbortController) {
  const baseline = createFakeAgentProvider();
  const capabilities = parseAgentCapabilities({ ...baseline.capabilities,
    context: { usage: { kind: 'unsupported' }, compaction: {
      kind: 'supported', triggers: ['manual'], sameSessionContinuation: true,
    } },
    operations: scenario === 'unsupported' ? { kind: 'unsupported' } : baseline.capabilities.operations,
  });
  const fake = createFakeAgentProvider({ capabilities });
  const instance = await fake.driver.materialize(fake.definition);
  const steps: string[] = [];
  let dispatches = 0;
  const offer: AgentOperationDescriptor = {
    operationId: exampleOperationId, revision: 3, kind: 'session_control', title: 'Compact context',
    description: 'Summarizes context; detail may be lost. Token reduction and undo are unavailable.',
    context: 'session', timing: 'idle_session', executionMode: 'immediate',
    fields: [], confirmation: 'required', idempotency: 'required', resultKind: 'canonical_output',
  };
  const adapter = validateAgentProviderAdapter(capabilities, { ...instance.adapter,
    async createSession(context) {
      const session = await instance.adapter.createSession(context);
      return { ...session, operations: scenario === 'unsupported' ? { kind: 'unsupported' as const } : {
        kind: 'supported' as const,
        async listOperations() {
          return { revision: 9, operations: scenario === 'missing' ? [] : [{ ...offer,
            fields: scenario === 'fields' ? [{ fieldId: parseAgentRequestFieldId('instructions'), fieldKind: 'text' as const,
              label: 'Instructions', required: false, sensitivity: 'ordinary' as const, multiline: false, maxLength: 100 }] : [],
          }] };
        },
        async invokeOperation(input: AgentProviderInvokeOperationInput) {
          assert.equal(input.invocation.expectedRevision, 3);
          assert.deepEqual(input.invocation.values, []);
          input.onProviderExecutionStarted?.(); dispatches += 1;
          if (scenario === 'entered_abort') {
            cancel.abort(new DOMException('User canceled.', 'AbortError'));
            throwIfAgentOperationAborted(input.signal);
          }
          if (scenario === 'effect') {
            await input.onOutput?.(createAgentEventOutput({ protocolVersion: 12, type: 'item.completed',
              sessionId: context.sessionId, turnId: input.observationTurnId,
              occurredAt: parseAgentIsoDateTime('2026-10-20T12:00:00.000Z'),
              payload: { itemId: 'example:compaction', itemKind: 'context_compaction', status: 'completed',
                details: { trigger: 'manual' } },
            }));
            steps.push('output.returned');
          }
          steps.push('operation.completed');
          return { invocationId: input.invocation.invocationId, status: 'completed' as const, outputText: 'Command completed.' };
        },
      } };
    },
  });
  const session = await adapter.createSession({ sessionId: parseAgentSessionId(`operations:${scenario}`),
    workingDirectory: '/example/workspace', configuration: { kind: 'selected', catalogRevision: 1,
      selections: [], revision: parseAgentConfigurationRevisionId('operations:configuration') }, onBindingCreated() {} });
  async function cleanup(): Promise<void> {
    try {
      // Use a fresh cleanup deadline. Close must succeed before dependencies are disposed.
      await session.close({ reason: 'shutdown', signal: AbortSignal.timeout(5_000) });
      steps.push('session.closed');
      await instance.dispose();
      steps.push('instance.disposed');
    } catch (cause) { throw new OperationExampleCleanupError(cause, cleanup); }
  }
  return { session, steps, dispatches: () => dispatches, turns: () => fake.snapshot().turnIds.length, cleanup };
}
