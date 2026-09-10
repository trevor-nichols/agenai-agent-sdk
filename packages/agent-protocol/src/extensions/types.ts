// ------------------------------------------------------------------------------------------------
//                types.ts - Native extension observations - Dependencies: environment, foundation
// ------------------------------------------------------------------------------------------------

import type {
  AgentCommandId,
  AgentEffectiveContentId,
  AgentExtensionId,
  AgentIntegrationId,
} from '../foundation/index.js';
import type {
  AgentAvailabilityFact,
  AgentEnvironmentSource,
} from '../environment/facts.js';
import type { AgentIsoDateTime } from '../foundation/index.js';

export const AGENT_EXTENSION_COMPONENT_KINDS = [
  'skill',
  'rule',
  'prompt',
  'agent_definition',
  'command',
  'mcp_server',
  'connector',
  'hook',
  'lsp_server',
  'scheduled_task',
  'other',
] as const;

export const AGENT_EXTENSION_CATALOG_MAX_LENGTH = 256;
export const AGENT_EXTENSION_COMPONENTS_MAX_LENGTH = 4_096;
export const AGENT_EXTENSION_CATALOG_BYTES_LIMIT = 512 * 1_024;
export const AGENT_EXTENSION_NAME_MAX_LENGTH = 200;
export const AGENT_EXTENSION_SUMMARY_MAX_LENGTH = 2_000;
export const AGENT_EXTENSION_VERSION_MAX_LENGTH = 200;
export const AGENT_EXTENSION_COMPONENT_NAME_MAX_LENGTH = 200;

export type AgentExtensionComponentKind =
  (typeof AGENT_EXTENSION_COMPONENT_KINDS)[number];

export type AgentExtensionContentComponentKind =
  | 'skill'
  | 'rule'
  | 'prompt'
  | 'agent_definition';

export type AgentExtensionContentComponentTarget = Readonly<{
  readonly domain: 'content';
  readonly id: AgentEffectiveContentId;
  readonly revision: number;
  readonly catalogRevision: number;
}>;

export type AgentExtensionCommandComponentTarget = Readonly<{
  readonly domain: 'commands';
  readonly id: AgentCommandId;
  readonly revision: number;
  readonly catalogRevision: number;
}>;

export type AgentExtensionIntegrationComponentTarget = Readonly<{
  readonly domain: 'integrations';
  readonly id: AgentIntegrationId;
  readonly revision: number;
  readonly catalogRevision: number;
}>;

export type AgentExtensionComponentTarget =
  | AgentExtensionContentComponentTarget
  | AgentExtensionCommandComponentTarget
  | AgentExtensionIntegrationComponentTarget;

export type AgentExtensionContentComponent = Readonly<{
  readonly kind: AgentExtensionContentComponentKind;
  readonly name: string;
  readonly target?: AgentExtensionContentComponentTarget;
}>;

export type AgentExtensionCommandComponent = Readonly<{
  readonly kind: 'command';
  readonly name: string;
  readonly target?: AgentExtensionCommandComponentTarget;
}>;

export type AgentExtensionIntegrationComponent = Readonly<{
  readonly kind: 'mcp_server' | 'connector';
  readonly name: string;
  readonly target?: AgentExtensionIntegrationComponentTarget;
}>;

export type AgentExtensionDescriptiveComponent = Readonly<{
  readonly kind: 'hook' | 'lsp_server' | 'scheduled_task' | 'other';
  readonly name: string;
}>;

export type AgentExtensionComponent =
  | AgentExtensionContentComponent
  | AgentExtensionCommandComponent
  | AgentExtensionIntegrationComponent
  | AgentExtensionDescriptiveComponent;

export interface AgentExtensionDescriptor {
  readonly extensionId: AgentExtensionId;
  readonly revision: number;
  readonly name: string;
  readonly summary?: string;
  /**
   * Version text reported by the native harness. It is descriptive metadata;
   * it is not an integrity or trust assertion.
   */
  readonly version?: string;
  readonly installation: AgentAvailabilityFact;
  readonly enablement: AgentAvailabilityFact;
  readonly source: AgentEnvironmentSource;
  readonly components: readonly AgentExtensionComponent[];
}

export interface AgentExtensionCatalog {
  readonly revision: number;
  readonly observedAt: AgentIsoDateTime;
  readonly extensions: readonly AgentExtensionDescriptor[];
}
