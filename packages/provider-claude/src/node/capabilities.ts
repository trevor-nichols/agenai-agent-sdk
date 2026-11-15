// ------------------------------------------------------------------------------------------------
//                capabilities.ts - The honest neutral capability surface of the owned Claude driver
// ------------------------------------------------------------------------------------------------

import { AGENT_PROTOCOL_VERSION, parseAgentCapabilities, type AgentCapabilities, type AgentProviderKey } from '@agen-ai/agent-protocol';
import { CLAUDE_QUERY_VIEW, CLAUDE_REPORTED_COUNTERS, CLAUDE_TURN_VIEW } from './usage.js';

function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Fresh sessions, text turns, interruption, once-only exact-action approvals and the two Claude usage
 * views; nothing else.
 */
export function claudeCapabilities(providerKey: AgentProviderKey): AgentCapabilities {
  return freeze(parseAgentCapabilities({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    providerKey,
    sessions: { create: true, resume: false, branch: { kind: 'unsupported' } },
    turns: { structuredOutput: { kind: 'unsupported' }, interactionModes: ['default'], interrupt: true, steer: { kind: 'unsupported' } },
    requests: {
      approval: { kind: 'supported', modes: [{ persistence: 'once', scopeKinds: ['exact_action'] }], providerManagedRemembrance: false },
      elicitation: { kind: 'unsupported' },
    },
    context: { usage: { kind: 'unsupported' }, compaction: { kind: 'unsupported' } },
    tokenUsage: { kind: 'supported', views: [
      { view: CLAUDE_QUERY_VIEW, scopeKind: 'materialization', reportedCounters: CLAUDE_REPORTED_COUNTERS, attribution: ['model', 'mixed'] },
      { view: CLAUDE_TURN_VIEW, scopeKind: 'turn', reportedCounters: CLAUDE_REPORTED_COUNTERS, attribution: ['unknown'] },
    ] },
    input: { text: true, images: { kind: 'unsupported' }, contentReferences: { kind: 'unsupported' } },
    output: { streaming: true, plans: false, fileChanges: 'structured', artifactKinds: [] },
    configuration: { kind: 'managed' },
    operations: { kind: 'unsupported' },
    managedContent: { kind: 'unsupported' },
    integrations: { kind: 'unsupported' },
    environment: { instance: { kind: 'unsupported' }, session: { kind: 'unsupported' } },
    collaboration: { kind: 'unsupported' },
    generatedResources: { kind: 'unsupported' },
    authentication: { kind: 'unsupported' },
    versionReporting: true,
  }));
}
