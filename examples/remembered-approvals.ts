import {
  parseAgentCapabilities,
  parseAgentConfigurationRevisionId,
  parseAgentIsoDateTime,
  parseAgentProviderConversationId,
  parseAgentRequest,
  parseAgentRequestResolutionFor,
  parseAgentSessionId,
} from '@agen-ai/agent-protocol';
import type { AgentApprovalCapability } from '@agen-ai/agent-protocol/capabilities';
import {
  createAgentEventOutput,
  validateAgentProviderAdapter,
  type AgentProviderOutput,
  type AgentProviderSession,
} from '@agen-ai/agent-runtime';
import { exampleGate, independentApprovalProgress, runApprovalWalkthrough, selectDisplayedOption } from './fixtures/approval-walkthrough.js';

// This synthetic adapter has no native process, permission database, filesystem, network or tool effect.
const approval: AgentApprovalCapability = { kind: 'supported', providerManagedRemembrance: true,
  modes: [{ persistence: 'once', scopeKinds: ['exact_action'] }] };
const capabilities = parseAgentCapabilities({
  protocolVersion: 13, providerKey: 'example-remembered-approvals',
  sessions: { create: true, resume: false, branch: { kind: 'unsupported' } },
  turns: { structuredOutput: { kind: 'unsupported' }, interactionModes: ['default'], interrupt: false, steer: { kind: 'unsupported' } },
  requests: { approval, elicitation: { kind: 'unsupported' } },
  context: { usage: { kind: 'unsupported' }, compaction: { kind: 'unsupported' } },
  input: { text: true, images: { kind: 'unsupported' }, contentReferences: { kind: 'unsupported' } },
  output: { streaming: true, plans: false, fileChanges: 'none', artifactKinds: [] },
  configuration: { kind: 'managed' }, operations: { kind: 'unsupported' }, managedContent: { kind: 'unsupported' },
  integrations: { kind: 'unsupported' }, environment: { instance: { kind: 'unsupported' }, session: { kind: 'unsupported' } },
  collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
  authentication: { kind: 'unsupported' }, versionReporting: false,
});
const statistics = { starts: 0, outputReaders: 0, acceptedAnswers: 0, closes: 0, producerJoined: false };
const receiptObserved = exampleGate();
const adapter = validateAgentProviderAdapter(capabilities, {
  resumption: { kind: 'unsupported' }, branching: { kind: 'unsupported' }, authentication: { kind: 'unsupported' },
  createSession(context): AgentProviderSession {
    const binding = { conversationId: parseAgentProviderConversationId('remembered:conversation') };
    context.onBindingCreated(binding);
    const lifetime = new AbortController();
    let producer: AsyncGenerator<AgentProviderOutput, void> | undefined;
    return {
      binding, interruption: { kind: 'unsupported' }, steering: { kind: 'unsupported' },
      configuration: { kind: 'managed' }, operations: { kind: 'unsupported' }, managedContent: { kind: 'unsupported' },
      environment: { kind: 'unsupported' }, collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
      startTurn(input) {
        statistics.starts += 1;
        const signal = AbortSignal.any([lifetime.signal, ...(input.signal ? [input.signal] : [])]);
        signal.addEventListener('abort', receiptObserved.release, { once: true });
        const request = parseAgentRequest({
          requestKind: 'approval', requestId: 'remembered:request', prompt: 'Review this synthetic action and every consequence.',
          subject: { kind: 'tool', itemId: 'remembered:tool', title: 'Synthetic action' },
          options: [
            { optionId: 'remembered:once', label: 'Allow once', decision: 'approved',
              consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } },
            { optionId: 'remembered:allow', label: 'Allow and remember', decision: 'approved', consequence: {
              kind: 'provider_managed_remembrance', duration: { kind: 'unknown' }, applicability: { kind: 'unknown' },
              explanation: 'The synthetic provider accepts a remembered decision. Duration and future matching are unspecified. Delivery does not prove a rule was stored.',
            } },
          ],
        });
        let accepted = false;
        const base = { protocolVersion: 13 as const, sessionId: context.sessionId, turnId: input.turnId,
          occurredAt: parseAgentIsoDateTime('2026-10-14T12:00:00.000Z') };
        async function* outputs(): AsyncGenerator<AgentProviderOutput, void> {
          signal.throwIfAborted();
          yield createAgentEventOutput({ ...base, type: 'turn.started', payload: {} });
          yield createAgentEventOutput({ ...base, type: 'item.started', payload: {
            itemId: 'remembered:tool', itemKind: 'dynamic_tool_call', status: 'in_progress',
          } });
          yield createAgentEventOutput({ ...base, type: 'item.started', payload: {
            itemId: 'remembered:message', itemKind: 'assistant_message', status: 'in_progress',
          } });
          yield createAgentEventOutput({ ...base, type: 'request.opened', payload: { request } });
          yield createAgentEventOutput({ ...base, type: 'content.delta', payload: {
            itemId: 'remembered:message', streamKind: 'assistant_text', delta: independentApprovalProgress,
          } });
          await receiptObserved.promise;
          signal.throwIfAborted();
          if (!accepted) throw new Error('The original reader resumed without an accepted answer.');
          yield createAgentEventOutput({ ...base, type: 'content.delta', payload: {
            itemId: 'remembered:message', streamKind: 'assistant_text', delta: 'The original turn continues; native persistence remains unobserved.',
          } });
          yield createAgentEventOutput({ ...base, type: 'item.completed', payload: {
            itemId: 'remembered:tool', itemKind: 'dynamic_tool_call', status: 'completed',
          } });
          yield createAgentEventOutput({ ...base, type: 'item.completed', payload: {
            itemId: 'remembered:message', itemKind: 'assistant_message', status: 'completed',
          } });
          yield createAgentEventOutput({ ...base, type: 'turn.completed', payload: { structuredOutput: { kind: 'not_requested' }, outcome: 'completed' } });
        }
        return {
          turnId: input.turnId,
          outputs: { [Symbol.asyncIterator]() { statistics.outputReaders += 1; producer = outputs(); return producer; } },
          async resolveRequest(response) {
            signal.throwIfAborted();
            response.signal?.throwIfAborted();
            const resolution = parseAgentRequestResolutionFor(request, response.resolution);
            if (accepted || resolution.requestKind !== 'approval' || resolution.disposition !== 'selected'
              || resolution.optionId !== 'remembered:allow') throw new Error('Expected the exact offered remembered choice once.');
            accepted = true;
            statistics.acceptedAnswers += 1;
            return { status: 'delivered' };
          },
        };
      },
      async close() {
        lifetime.abort();
        receiptObserved.release();
        await producer?.return(undefined);
        statistics.producerJoined = producer !== undefined;
        statistics.closes += 1;
      },
    };
  },
});

const session = await adapter.createSession({
  sessionId: parseAgentSessionId('remembered:session'), workingDirectory: process.cwd(),
  configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('remembered:configuration') },
  onBindingCreated() {},
});
const walkthrough = await runApprovalWalkthrough(session, 'core',
  (request) => selectDisplayedOption(request, 'Allow and remember'), receiptObserved.release);
console.log(JSON.stringify({ example: 'remembered-approvals', evidence: 'synthetic', ...walkthrough,
  ...statistics, nativePersistence: 'unobserved', effect: 'not_performed' }));
