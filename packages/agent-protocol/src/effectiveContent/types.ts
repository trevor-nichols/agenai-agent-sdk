// ------------------------------------------------------------------------------------------------
//                types.ts - Effective native content contracts - Dependencies: foundation, environment facts
// ------------------------------------------------------------------------------------------------

import type {
  AgentEffectiveContentId,
  AgentIsoDateTime,
} from '../foundation/index.js';
import type {
  AgentAvailabilityFact,
  AgentEnvironmentSource,
  AgentInvocationPosture,
  AgentQualifiedExtensionReference,
} from '../environment/facts.js';

export const AGENT_EFFECTIVE_CONTENT_KINDS = [
  'skill',
  'rule',
  'prompt',
  'agent_definition',
] as const;
export const AGENT_EFFECTIVE_CONTENT_NAME_MAX_LENGTH = 200;
export const AGENT_EFFECTIVE_CONTENT_SUMMARY_MAX_LENGTH = 2_000;
export const AGENT_EFFECTIVE_CONTENT_CATALOG_MAX_LENGTH = 1_024;
export const AGENT_EFFECTIVE_CONTENT_CATALOG_BYTES_LIMIT = 512 * 1024;

export type AgentEffectiveContentKind =
  (typeof AGENT_EFFECTIVE_CONTENT_KINDS)[number];

export const AGENT_DEFINITION_MODES = ['primary', 'subagent', 'all', 'unknown'] as const;
export type AgentDefinitionMode = (typeof AGENT_DEFINITION_MODES)[number];

/** Definition metadata does not grant selection or running-agent authority. */
export interface AgentDefinitionObservation {
  readonly mode: AgentDefinitionMode;
  readonly hidden: AgentAvailabilityFact;
}

export interface AgentEffectiveContentDescriptor {
  readonly contentId: AgentEffectiveContentId;
  readonly revision: number;
  readonly kind: AgentEffectiveContentKind;
  readonly name: string;
  readonly summary?: string;
  readonly source: AgentEnvironmentSource;
  readonly registration: AgentAvailabilityFact;
  readonly enablement: AgentAvailabilityFact;
  readonly invocation: AgentInvocationPosture;
  readonly modelCallability: AgentAvailabilityFact;
  readonly extension?: AgentQualifiedExtensionReference;
  readonly agentDefinition?: AgentDefinitionObservation;
}

export interface AgentEffectiveContentCatalog {
  readonly revision: number;
  readonly observedAt: AgentIsoDateTime;
  readonly content: readonly AgentEffectiveContentDescriptor[];
}
