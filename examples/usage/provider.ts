import {
  AGENT_PROTOCOL_VERSION, parseAgentCapabilities, parseAgentProviderConversationId,
} from '@agen-ai/agent-protocol';
import { createAgentEventOutput, validateAgentProviderAdapter, type AgentProviderSession } from '@agen-ai/agent-runtime';
import { notMeasured, turnScope, VIEWS } from './observations.js';

// Caller-owned synthetic provider: no native process, model, credential, network, tool or storage.
// It declares one turn view and legitimately reports that the native result carried no usage.
export const reportingCapabilities = parseAgentCapabilities({
  protocolVersion: AGENT_PROTOCOL_VERSION, providerKey: 'usage-example',
  sessions: { create: true, resume: false, branch: { kind: 'unsupported' } },
  turns: { structuredOutput: { kind: 'unsupported' }, interactionModes: ['default'], interrupt: false, steer: { kind: 'unsupported' } },
  requests: { approval: { kind: 'unsupported' }, elicitation: { kind: 'unsupported' } },
  context: { usage: { kind: 'unsupported' }, compaction: { kind: 'unsupported' } },
  tokenUsage: { kind: 'supported', views: [
    { view: VIEWS.turn, scopeKind: 'turn', reportedCounters: ['inputTokens', 'outputTokens'], attribution: ['model'] },
  ] },
  input: { text: true, images: { kind: 'unsupported' }, contentReferences: { kind: 'unsupported' } },
  output: { streaming: false, plans: false, fileChanges: 'none', artifactKinds: [] },
  configuration: { kind: 'managed' }, operations: { kind: 'unsupported' },
  managedContent: { kind: 'unsupported' }, integrations: { kind: 'unsupported' },
  environment: { instance: { kind: 'unsupported' }, session: { kind: 'unsupported' } },
  collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
  authentication: { kind: 'unsupported' }, versionReporting: false,
});

export function createReportingProvider() {
  const statistics = { starts: 0, sessionCloses: 0 };
  const adapter = validateAgentProviderAdapter(reportingCapabilities, {
    resumption: { kind: 'unsupported' }, branching: { kind: 'unsupported' }, authentication: { kind: 'unsupported' },
    createSession(context): AgentProviderSession {
      const binding = { conversationId: parseAgentProviderConversationId('usage-example:conversation') };
      context.onBindingCreated(binding);
      let closed = false;
      return {
        binding, interruption: { kind: 'unsupported' }, steering: { kind: 'unsupported' },
        configuration: { kind: 'managed' }, operations: { kind: 'unsupported' },
        managedContent: { kind: 'unsupported' }, environment: { kind: 'unsupported' },
        collaboration: { kind: 'unsupported' }, generatedResources: { kind: 'unsupported' },
        startTurn(turn) {
          statistics.starts += 1;
          const base = { protocolVersion: AGENT_PROTOCOL_VERSION, sessionId: context.sessionId, turnId: turn.turnId,
            occurredAt: '2026-11-13T12:00:00.000Z' };
          return {
            turnId: turn.turnId,
            outputs: (async function* () {
              yield createAgentEventOutput({ ...base, type: 'turn.started', payload: {} });
              yield createAgentEventOutput({ ...base, type: 'usage.observed',
                payload: notMeasured(`${turn.turnId}:usage`, turnScope(turn.turnId), ['native_result_incomplete']) });
              yield createAgentEventOutput({ ...base, type: 'turn.completed', payload: {
                outcome: 'completed', structuredOutput: { kind: 'not_requested' },
              } });
            })(),
            async resolveRequest() { throw new Error('The usage example opens no human request.'); },
          };
        },
        async close() {
          if (closed) return;
          closed = true;
          statistics.sessionCloses += 1;
        },
      };
    },
  });
  return { adapter, statistics };
}
