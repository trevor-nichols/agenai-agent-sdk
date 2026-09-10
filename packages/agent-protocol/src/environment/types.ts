// ------------------------------------------------------------------------------------------------
//                types.ts - Agent environment observations and capabilities - Dependencies: domains, facts
// ------------------------------------------------------------------------------------------------

import type { AgentCommandCatalog } from '../commands/index.js';
import type { AgentEffectiveContentCatalog } from '../effectiveContent/index.js';
import type { AgentExtensionCatalog } from '../extensions/index.js';
import type { AgentIntegrationCatalog } from '../integrations/index.js';
import type { AgentEnvironmentId } from '../foundation/index.js';
import type { AgentEnvironmentReason } from './facts.js';

export const AGENT_ENVIRONMENT_SCHEMA_VERSION = 1 as const;
export const AGENT_ENVIRONMENT_DOMAINS = [
  'content',
  'commands',
  'extensions',
  'integrations',
] as const;
export const AGENT_ENVIRONMENT_EVIDENCE_EXTENTS = [
  'workspace_discovery',
  'session',
] as const;
export const AGENT_ENVIRONMENT_COMPLETENESSES = ['complete', 'partial'] as const;
export const AGENT_ENVIRONMENT_DOMAIN_CATALOG_BYTES_LIMIT = 512 * 1_024;
export const AGENT_ENVIRONMENT_SNAPSHOT_BYTES_LIMIT = 2 * 1_024 * 1_024;
export const AGENT_ENVIRONMENT_EFFECTIVE_ENTRIES_MAX_LENGTH = 1_024;
export const AGENT_ENVIRONMENT_INTEGRATION_CONTRIBUTIONS_MAX_LENGTH = 4_096;

export type AgentEnvironmentDomain = (typeof AGENT_ENVIRONMENT_DOMAINS)[number];
export type AgentEnvironmentEvidenceExtent =
  (typeof AGENT_ENVIRONMENT_EVIDENCE_EXTENTS)[number];
export type AgentEnvironmentCompleteness =
  (typeof AGENT_ENVIRONMENT_COMPLETENESSES)[number];

export type AgentEnvironmentAvailableDomainResult<Catalog> = Readonly<{
  readonly kind: 'available';
  readonly catalog: Catalog;
  readonly extent: AgentEnvironmentEvidenceExtent;
  readonly completeness: AgentEnvironmentCompleteness;
  readonly reasons: readonly AgentEnvironmentReason[];
}>;

export type AgentEnvironmentUnavailableDomainResult = Readonly<{
  readonly kind: 'unsupported' | 'not_initialized' | 'unavailable';
  readonly reasons: readonly AgentEnvironmentReason[];
}>;

export type AgentEnvironmentDomainResult<Catalog> =
  | AgentEnvironmentAvailableDomainResult<Catalog>
  | AgentEnvironmentUnavailableDomainResult;

export type AgentEnvironmentContentResult = AgentEnvironmentDomainResult<
  AgentEffectiveContentCatalog
>;
export type AgentEnvironmentCommandsResult = AgentEnvironmentDomainResult<
  AgentCommandCatalog
>;
export type AgentEnvironmentExtensionsResult = AgentEnvironmentDomainResult<
  AgentExtensionCatalog
>;
export type AgentEnvironmentIntegrationsResult = AgentEnvironmentDomainResult<
  AgentIntegrationCatalog
>;

export interface AgentEnvironmentSnapshot {
  readonly schemaVersion: typeof AGENT_ENVIRONMENT_SCHEMA_VERSION;
  readonly environmentId: AgentEnvironmentId;
  readonly revision: number;
  readonly content: AgentEnvironmentContentResult;
  readonly commands: AgentEnvironmentCommandsResult;
  readonly extensions: AgentEnvironmentExtensionsResult;
  readonly integrations: AgentEnvironmentIntegrationsResult;
}

export interface AgentEnvironmentInvalidation {
  readonly environmentId: AgentEnvironmentId;
  readonly domains: readonly AgentEnvironmentDomain[];
}

/** The serializable capability advertised by a provider instance or session. */
export type AgentEnvironmentReadCapability =
  | Readonly<{ readonly kind: 'unsupported' }>
  | Readonly<{
      readonly kind: 'read';
      readonly domains: readonly AgentEnvironmentDomain[];
    }>
  | Readonly<{
      readonly kind: 'read_and_watch';
      readonly domains: readonly AgentEnvironmentDomain[];
    }>;

export interface AgentEnvironmentCapability {
  readonly instance: AgentEnvironmentReadCapability;
  readonly session: AgentEnvironmentReadCapability;
}
