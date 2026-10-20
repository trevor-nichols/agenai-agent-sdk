import { randomUUID } from 'node:crypto';
import {
  parseAgentOperationInvocationId, parseAgentTurnId,
  type AgentOperationDescriptor, type AgentOperationId,
} from '@agen-ai/agent-protocol';
import {
  AgentProviderDelegatedOperationError, isAgentOperationAbortError, throwIfAgentOperationAborted,
  type AgentProviderOutput, type AgentProviderSession,
} from '@agen-ai/agent-runtime';

// The application configures this ID for its selected provider; labels are not semantic identifiers.
export async function invokeConfirmedCompaction(input: {
  session: AgentProviderSession;
  operationId: AgentOperationId;
  signal: AbortSignal;
  confirm: (offer: AgentOperationDescriptor, signal: AbortSignal) => Promise<boolean>;
  acceptOutput: (output: AgentProviderOutput) => Promise<void>;
}) {
  let compactionObserved = false;
  try {
    const operations = input.session.operations;
    if (operations.kind === 'unsupported') return { status: 'unsupported' as const };
    const catalog = await operations.listOperations({ signal: input.signal });
    const offer = catalog.operations.find((entry) => entry.operationId === input.operationId);
    if (!offer) return { status: 'unavailable' as const };
    // This example understands only the explicitly configured, field-free idle operation.
    if (offer.kind !== 'session_control' || offer.context !== 'session'
      || offer.timing !== 'idle_session' || offer.executionMode !== 'immediate'
      || offer.resultKind !== 'canonical_output' || offer.fields.length !== 0) {
      return { status: 'unsupported_descriptor' as const };
    }
    // Explain possible loss of detail, no guaranteed token reduction, and no SDK undo before confirming.
    if (!await input.confirm(offer, input.signal)) return { status: 'declined' as const };
    throwIfAgentOperationAborted(input.signal);
    const result = await operations.invokeOperation({
      invocation: {
        invocationId: parseAgentOperationInvocationId(randomUUID()), operationId: offer.operationId,
        expectedRevision: offer.revision, values: [],
      },
      observationTurnId: parseAgentTurnId(randomUUID()), signal: input.signal,
      async onOutput(output) {
        await input.acceptOutput(output);
        if (output.kind === 'event' && output.event.type === 'item.completed'
          && output.event.payload.itemKind === 'context_compaction'
          && output.event.payload.status === 'completed') compactionObserved = true;
      },
    });
    // Keep the exact result. Completion without an observation does not prove any compaction effect.
    return { status: 'settled' as const, result, compactionObserved };
  } catch (error) {
    // Check started-execution evidence first, even when the user's signal is now aborted.
    if (error instanceof AgentProviderDelegatedOperationError) {
      return { status: 'uncertain' as const, error, compactionObserved };
    }
    if (isAgentOperationAbortError(error)) return { status: 'canceled_before_execution' as const };
    // Stale descriptors, busy sessions and other errors retain their original classification.
    throw error;
  }
}
