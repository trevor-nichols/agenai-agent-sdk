// ------------------------------------------------------------------------------------------------
//                types.ts - Safe integration inventory contracts - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type { AgentAvailabilityFact, AgentEnvironmentSource } from '../environment/facts.js';

import type {
  AgentIntegrationId,
  AgentIntegrationResourceId,
  AgentIntegrationServerId,
  AgentIntegrationToolId,
  AgentIsoDateTime,
} from '../foundation/index.js';

export const AGENT_INTEGRATION_STATUSES = [
  'starting',
  'ready',
  'degraded',
  'unavailable',
] as const;
export const AGENT_INTEGRATION_KINDS = ['mcp', 'connector'] as const;
export const AGENT_INTEGRATION_NAME_MAX_LENGTH = 200;
export const AGENT_INTEGRATION_DESCRIPTION_MAX_LENGTH = 2_000;
export const AGENT_INTEGRATION_CATALOG_MAX_LENGTH = 128;
export const AGENT_INTEGRATION_SERVERS_MAX_LENGTH = 32;
export const AGENT_INTEGRATION_TOOLS_MAX_LENGTH = 100;
export const AGENT_INTEGRATION_RESOURCES_MAX_LENGTH = 100;
export const AGENT_INTEGRATION_CONTRIBUTIONS_MAX_LENGTH = 4_096;
export const AGENT_INTEGRATION_CATALOG_BYTES_LIMIT = 524_288;

export type AgentIntegrationStatus =
  (typeof AGENT_INTEGRATION_STATUSES)[number];
export type AgentIntegrationKind = (typeof AGENT_INTEGRATION_KINDS)[number];

export interface AgentIntegrationToolDescriptor {
  readonly toolId: AgentIntegrationToolId;
  readonly name: string;
  readonly description?: string;
}

export interface AgentIntegrationResourceDescriptor {
  readonly resourceId: AgentIntegrationResourceId;
  readonly name: string;
  readonly description?: string;
  readonly mediaType?: string;
}

export interface AgentIntegrationServerDescriptor {
  readonly serverId: AgentIntegrationServerId;
  readonly name: string;
  readonly status: AgentIntegrationStatus;
  readonly tools: readonly AgentIntegrationToolDescriptor[];
  readonly resources: readonly AgentIntegrationResourceDescriptor[];
}

export interface AgentMcpIntegrationDescriptor {
  readonly integrationId: AgentIntegrationId;
  readonly revision: number;
  readonly kind: 'mcp';
  readonly name: string;
  readonly status: AgentIntegrationStatus;
  readonly servers: readonly AgentIntegrationServerDescriptor[];
}

export interface AgentConnectorIntegrationDescriptor {
  readonly integrationId: AgentIntegrationId;
  readonly revision: number;
  readonly kind: 'connector';
  readonly name: string;
  readonly description?: string;
  readonly source: AgentEnvironmentSource;
  readonly installation: AgentAvailabilityFact;
  readonly enablement: AgentAvailabilityFact;
  readonly authentication: AgentAvailabilityFact;
  readonly health: AgentIntegrationStatus;
  readonly callability: AgentAvailabilityFact;
  readonly tools?: readonly AgentIntegrationToolDescriptor[];
}

export type AgentIntegrationDescriptor =
  | AgentMcpIntegrationDescriptor
  | AgentConnectorIntegrationDescriptor;

export interface AgentIntegrationCatalog {
  readonly revision: number;
  readonly observedAt: AgentIsoDateTime;
  readonly integrations: readonly AgentIntegrationDescriptor[];
}
