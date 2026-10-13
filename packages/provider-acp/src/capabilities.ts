import { parseAgentCapabilities, type AgentAuthenticationFlow, type AgentCapabilities, type AgentProviderKey } from '@agen-ai/agent-protocol';
import type { AcpNegotiatedAgent } from './connection/contracts.js';

function freezeCapabilities<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeCapabilities(child);
    Object.freeze(value);
  }
  return value;
}

export function acpProviderCapabilities(
  providerKey: AgentProviderKey,
  negotiated: AcpNegotiatedAgent,
  configuration: 'managed' | 'selectable' = 'managed',
  authenticationFlows: readonly AgentAuthenticationFlow[] = [],
): AgentCapabilities {
  return freezeCapabilities(parseAgentCapabilities({
    protocolVersion: 10,
    providerKey,
    sessions: { create: true, resume: negotiated.agentCapabilities.loadSession === true
      || (negotiated.agentCapabilities.sessionCapabilities as import('@agen-ai/acp-transport').AcpJsonObject | undefined)?.resume != null, branch: { kind: 'unsupported' } },
    turns: { interactionModes: ['default'], interrupt: true, steer: { kind: 'unsupported' } },
    requests: {
      approval: { kind: 'supported', modes: [{ persistence: 'once', scopeKinds: ['exact_action'] }] },
      elicitation: { kind: 'supported', fieldKinds: ['single_select', 'multi_select', 'boolean'], maxFields: 16, sensitiveFields: false },
    },
    context: { usage: { kind: 'unsupported' }, compaction: { kind: 'unsupported' } },
    input: { text: true, images: (negotiated.agentCapabilities.promptCapabilities as import('@agen-ai/acp-transport').AcpJsonObject | undefined)?.image === true
      ? { kind: 'supported', sourceKinds: ['base64'], mediaTypes: ['image/png', 'image/jpeg', 'image/webp'], maxImages: 16,
        maxBytesPerImage: 375_000, maxTotalBytes: 750_000, maxWidthPixels: 100_000, maxHeightPixels: 100_000,
        maxPixelsPerImage: 100_000_000, supportsImageOnly: true } : { kind: 'unsupported' }, contentReferences: { kind: 'unsupported' } },
    output: { streaming: true, plans: true, fileChanges: 'structured', artifactKinds: [] },
    configuration: configuration === 'managed' ? { kind: 'managed' } : { kind: 'selectable', fieldKinds: ['boolean', 'single_select'], maxFields: 100 },
    operations: { kind: 'unsupported' },
    managedContent: { kind: 'unsupported' },
    integrations: { kind: 'unsupported' },
    environment: { instance: { kind: 'unsupported' }, session: { kind: 'read_and_watch', domains: ['commands'] } },
    collaboration: { kind: 'unsupported' },
    generatedResources: { kind: 'unsupported' },
    authentication: authenticationFlows.length ? { kind: 'supported', flows: authenticationFlows } : { kind: 'unsupported' },
    versionReporting: negotiated.agentInfo !== undefined,
  }));
}
