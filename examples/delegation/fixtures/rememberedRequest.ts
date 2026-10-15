// ------------------------------------------------------------------------------------------------
//                rememberedRequest.ts - Explicit synthetic approval used only by recovery proof
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { parseAgentApprovalRequest, parseAgentRequestResolutionFor } from '@agen-ai/agent-protocol';
import { createAgentEventOutput, type AgentProviderSessionContext, type AgentProviderStartTurnInput,
  type AgentProviderTurnExecution } from '@agen-ai/agent-runtime';
import { createFakeAgentProvider } from '@agen-ai/agent-runtime/testing';
import { eventBase } from './host.js';

export const rememberedOptionId = 'recovery:remember';

export function rememberedProviderOptions() {
  const { capabilities } = createFakeAgentProvider();
  return { capabilities: { ...capabilities, requests: { ...capabilities.requests,
    approval: { kind: 'supported' as const, modes: [{ persistence: 'once' as const, scopeKinds: ['exact_action' as const] }],
      providerManagedRemembrance: true as const } } } };
}

export function rememberedApproval(requestId: string) {
  return parseAgentApprovalRequest({ requestKind: 'approval', requestId, prompt: 'Allow the synthetic edit and ask this provider to remember?',
    subject: { kind: 'tool', title: 'Synthetic file edit', itemId: 'synthetic-edit' },
    options: [
      { optionId: 'recovery:once', label: 'Allow once', decision: 'approved',
        consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } },
      { optionId: rememberedOptionId, label: 'Allow and remember', description: 'Synthetic provider choice for durable recovery qualification.',
        decision: 'approved', consequence: { kind: 'provider_managed_remembrance', duration: { kind: 'unknown' },
          applicability: { kind: 'unknown' }, explanation: 'The provider is asked to remember this decision. Duration and future matching are unspecified. Delivery does not establish persistence or revocation.' } },
    ] });
}

export function rememberedExecution(context: AgentProviderSessionContext, turn: AgentProviderStartTurnInput,
  onAnswer: () => void): AgentProviderTurnExecution {
  const request = rememberedApproval(`recovery-request:${turn.turnId}`);
  return { turnId: turn.turnId,
    outputs: (async function* () {
      const base = eventBase(context, turn.turnId);
      yield createAgentEventOutput({ ...base, type: 'turn.started', payload: {} });
      yield createAgentEventOutput({ ...base, type: 'item.started', payload: { itemId: 'synthetic-edit', itemKind: 'dynamic_tool_call', status: 'in_progress' } });
      yield createAgentEventOutput({ ...base, type: 'request.opened', payload: { request } });
      yield createAgentEventOutput({ ...base, type: 'turn.state_changed', payload: { state: 'waiting_for_request', requestId: request.requestId } });
      // SIGKILL occurs after answer delivery; no terminal continuation is claimed by this fixture.
      await new Promise<void>(() => {});
    })(),
    async resolveRequest(input) {
      input.signal?.throwIfAborted();
      onAnswer();
      const resolution = parseAgentRequestResolutionFor(request, input.resolution);
      assert.deepEqual(resolution, { requestKind: 'approval', requestId: request.requestId,
        disposition: 'selected', optionId: rememberedOptionId });
      return { status: 'delivered' };
    },
  };
}
