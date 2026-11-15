import { AGENT_PROTOCOL_VERSION, parseAgentCapabilities, type AgentAuthenticationFlow, type AgentCapabilities, type AgentProviderKey } from '@agen-ai/agent-protocol';
import type { AcpNegotiatedAgent } from './connection/contracts.js';
import type { AcpSessionInteractionSelection } from './sessionInteractions/contracts.js';
import type { AcpPermissionMappingSelection } from './permissions/contracts.js';
import { acpPermissionCapability } from './permissions/selection.js';
import { acpStructuredOutputCapability, type AcpStructuredOutputMappingSelection } from './structuredOutput/mapping.js';
import { CONTROLLED_GROK_PROMPT_VIEW, CONTROLLED_GROK_REPORTED_COUNTERS } from './node/grokPromptUsage.js';

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
  sessionInteractions?: AcpSessionInteractionSelection,
  permissionMapping: AcpPermissionMappingSelection = { mapping: 'once-only-v1' },
  structuredOutputMapping?: AcpStructuredOutputMappingSelection,
  controlledGrok = false,
): AgentCapabilities {
  return freezeCapabilities(parseAgentCapabilities({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    providerKey,
    sessions: { create: true, resume: !controlledGrok && sessionInteractions?.mapping !== 'grok-folder-trust-v1' && (negotiated.agentCapabilities.loadSession === true
      || (negotiated.agentCapabilities.sessionCapabilities as import('@agen-ai/acp-transport').AcpJsonObject | undefined)?.resume != null), branch: { kind: 'unsupported' } },
    turns: { structuredOutput: acpStructuredOutputCapability(structuredOutputMapping), interactionModes: ['default'], interrupt: true, steer: { kind: 'unsupported' } },
    requests: {
      approval: acpPermissionCapability(permissionMapping),
      elicitation: controlledGrok ? { kind: 'unsupported' } : { kind: 'supported', fieldKinds: ['single_select', 'multi_select', 'boolean'], maxFields: 16, sensitiveFields: false },
    },
    context: { usage: { kind: 'unsupported' }, compaction: { kind: 'unsupported' } },
    tokenUsage: controlledGrok ? { kind: 'supported', views: [{ view: CONTROLLED_GROK_PROMPT_VIEW, scopeKind: 'turn',
      reportedCounters: CONTROLLED_GROK_REPORTED_COUNTERS, attribution: ['model', 'unknown', 'mixed'] }] } : { kind: 'unsupported' },
    input: { text: true, images: !controlledGrok && (negotiated.agentCapabilities.promptCapabilities as import('@agen-ai/acp-transport').AcpJsonObject | undefined)?.image === true
      ? { kind: 'supported', sourceKinds: ['base64'], mediaTypes: ['image/png', 'image/jpeg', 'image/webp'], maxImages: 16,
        maxBytesPerImage: 375_000, maxTotalBytes: 750_000, maxWidthPixels: 100_000, maxHeightPixels: 100_000,
        maxPixelsPerImage: 100_000_000, supportsImageOnly: true } : { kind: 'unsupported' }, contentReferences: { kind: 'unsupported' } },
    output: { streaming: true, plans: true, fileChanges: 'structured', artifactKinds: [] },
    configuration: configuration === 'managed' ? { kind: 'managed' } : { kind: 'selectable', fieldKinds: ['boolean', 'single_select'], maxFields: 100 },
    operations: { kind: 'unsupported' },
    managedContent: { kind: 'unsupported' },
    integrations: { kind: 'unsupported' },
    environment: { instance: { kind: 'unsupported' }, session: controlledGrok ? { kind: 'unsupported' } : { kind: 'read_and_watch', domains: ['commands'] } },
    collaboration: { kind: 'unsupported' },
    generatedResources: { kind: 'unsupported' },
    authentication: authenticationFlows.length ? { kind: 'supported', flows: authenticationFlows } : { kind: 'unsupported' },
    versionReporting: negotiated.agentInfo !== undefined,
  }));
}
