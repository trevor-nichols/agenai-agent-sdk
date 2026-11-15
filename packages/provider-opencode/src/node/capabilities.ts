// ------------------------------------------------------------------------------------------------
//                capabilities.ts - The honest neutral capability surface of the owned OpenCode driver
// ------------------------------------------------------------------------------------------------

import { AGENT_PROTOCOL_VERSION, parseAgentCapabilities, type AgentCapabilities, type AgentProviderKey } from '@agen-ai/agent-protocol';
import type { NodeOpenCodeModelProvider } from '../index.js';
import { OPENCODE_REPORTED_COUNTERS, OPENCODE_SESSION_VIEW, OPENCODE_STEP_VIEW } from './usage.js';

function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Fresh sessions, text turns, interruption, once-only exact-action approvals and the route's token usage; nothing else. */
export function openCodeCapabilities(providerKey: AgentProviderKey, route: NodeOpenCodeModelProvider): AgentCapabilities {
  const reportedCounters = OPENCODE_REPORTED_COUNTERS[route];
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
      { view: OPENCODE_SESSION_VIEW, scopeKind: 'session', reportedCounters, attribution: ['unknown'] },
      { view: OPENCODE_STEP_VIEW, scopeKind: 'turn', reportedCounters, attribution: ['model'] },
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
