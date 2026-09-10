// ------------------------------------------------------------------------------------------------
//                integrations.ts - Safe integration schemas - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { AgentAvailabilityFactSchema, AgentEnvironmentSourceSchema } from './environmentFacts.js';
import { agentProtocolSerializedJsonBytes } from '../foundation/types.js';

import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_INTEGRATION_DESCRIPTION_MAX_LENGTH,
  AGENT_INTEGRATION_CONTRIBUTIONS_MAX_LENGTH,
  AGENT_INTEGRATION_CATALOG_BYTES_LIMIT,
  AGENT_INTEGRATION_CATALOG_MAX_LENGTH,
  AGENT_INTEGRATION_NAME_MAX_LENGTH,
  AGENT_INTEGRATION_RESOURCES_MAX_LENGTH,
  AGENT_INTEGRATION_SERVERS_MAX_LENGTH,
  AGENT_INTEGRATION_STATUSES,
  AGENT_INTEGRATION_TOOLS_MAX_LENGTH,
  type AgentIntegrationCatalog,
  type AgentIntegrationDescriptor,
  type AgentMcpIntegrationDescriptor,
} from '../integrations/types.js';
import {
  AgentIntegrationIdSchema,
  AgentIntegrationResourceIdSchema,
  AgentIntegrationServerIdSchema,
  AgentIntegrationToolIdSchema,
  AgentIsoDateTimeSchema,
  createAgentCanonicalNonBlankStringSchema,
  withAcyclicProtocolInput,
} from './foundation.js';

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NameSchema = createAgentCanonicalNonBlankStringSchema(AGENT_INTEGRATION_NAME_MAX_LENGTH);
const DescriptionSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_INTEGRATION_DESCRIPTION_MAX_LENGTH,
);
const MediaTypeSchema = z.string().min(1).max(200).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u);

const ToolSchema = z.object({
  toolId: AgentIntegrationToolIdSchema,
  name: NameSchema,
  description: DescriptionSchema.optional(),
}).strict().readonly();

const ResourceSchema = z.object({
  resourceId: AgentIntegrationResourceIdSchema,
  name: NameSchema,
  description: DescriptionSchema.optional(),
  mediaType: MediaTypeSchema.optional(),
}).strict().readonly();

const ServerSchema = z.object({
  serverId: AgentIntegrationServerIdSchema,
  name: NameSchema,
  status: z.enum(AGENT_INTEGRATION_STATUSES),
  tools: z.array(ToolSchema).max(AGENT_INTEGRATION_TOOLS_MAX_LENGTH).readonly(),
  resources: z.array(ResourceSchema).max(AGENT_INTEGRATION_RESOURCES_MAX_LENGTH).readonly(),
}).strict().readonly();

function addOrderedUniqueIssues(
  values: readonly string[],
  path: readonly (string | number)[],
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({ code: 'custom', path: [...path, index], message: `${label} must be unique.` });
    }
    if (
      index > 0
      && compareStringsByUnicodeCodePoint(values[index - 1]!, value) >= 0
    ) {
      context.addIssue({ code: 'custom', path: [...path, index], message: `${label} must use canonical ID order.` });
    }
    seen.add(value);
  });
}

const McpIntegrationSchema = z.object({
  integrationId: AgentIntegrationIdSchema,
  revision: PositiveSafeIntegerSchema,
  kind: z.literal('mcp'),
  name: NameSchema,
  status: z.enum(AGENT_INTEGRATION_STATUSES),
  servers: z.array(ServerSchema).max(AGENT_INTEGRATION_SERVERS_MAX_LENGTH).readonly(),
}).strict().readonly();

const ConnectorIntegrationSchema = z.object({
  integrationId: AgentIntegrationIdSchema,
  revision: PositiveSafeIntegerSchema,
  kind: z.literal('connector'),
  name: NameSchema,
  description: DescriptionSchema.optional(),
  source: AgentEnvironmentSourceSchema,
  installation: AgentAvailabilityFactSchema,
  enablement: AgentAvailabilityFactSchema,
  authentication: AgentAvailabilityFactSchema,
  health: z.enum(AGENT_INTEGRATION_STATUSES),
  callability: AgentAvailabilityFactSchema,
  tools: z.array(ToolSchema).max(AGENT_INTEGRATION_TOOLS_MAX_LENGTH).readonly().optional(),
}).strict().readonly();

const AgentIntegrationDescriptorPortableSchema = z.discriminatedUnion('kind', [
  McpIntegrationSchema,
  ConnectorIntegrationSchema,
]);

function validateIntegrationDescriptor(integration: AgentIntegrationDescriptor, context: z.RefinementCtx): void {
  if (integration.kind === 'connector') {
    addOrderedUniqueIssues((integration.tools ?? []).map((tool) => tool.toolId), ['tools'], 'Connector tool IDs', context);
    if (integration.callability.kind === 'known' && integration.callability.value &&
      [integration.installation, integration.enablement, integration.authentication].some((fact) => fact.kind === 'known' && !fact.value)) {
      context.addIssue({ code: 'custom', path: ['callability'], message: 'A connector cannot be callable when installation, enablement or authentication is denied.' });
    }
    return;
  }
  addOrderedUniqueIssues(integration.servers.map((server) => server.serverId), ['servers'], 'Integration server IDs', context);
  integration.servers.forEach((server, serverIndex) => {
    addOrderedUniqueIssues(server.tools.map((tool) => tool.toolId), ['servers', serverIndex, 'tools'], 'Integration tool IDs', context);
    addOrderedUniqueIssues(server.resources.map((resource) => resource.resourceId), ['servers', serverIndex, 'resources'], 'Integration resource IDs', context);
  });
}

export const AgentIntegrationDescriptorSchema: z.ZodType<AgentIntegrationDescriptor> =
  AgentIntegrationDescriptorPortableSchema.superRefine(validateIntegrationDescriptor);

export const AgentMcpIntegrationDescriptorSchema: z.ZodType<AgentMcpIntegrationDescriptor> =
  McpIntegrationSchema.superRefine(validateIntegrationDescriptor);

export const AgentIntegrationCatalogPortableSchema = z.object({
  revision: PositiveSafeIntegerSchema,
  observedAt: AgentIsoDateTimeSchema,
  integrations: z.array(AgentIntegrationDescriptorPortableSchema)
    .max(AGENT_INTEGRATION_CATALOG_MAX_LENGTH)
    .readonly(),
}).strict().readonly();

export const AgentIntegrationCatalogSchema: z.ZodType<AgentIntegrationCatalog> =
  withAcyclicProtocolInput(AgentIntegrationCatalogPortableSchema, {
    maxDepth: 16,
    maxCollectionLength: AGENT_INTEGRATION_CONTRIBUTIONS_MAX_LENGTH,
  }).superRefine((catalog, context) => {
    const contributions = catalog.integrations.reduce((count, integration) => count + (integration.kind === 'mcp'
      ? integration.servers.reduce((total, server) => total + server.tools.length + server.resources.length, 0)
      : (integration.tools?.length ?? 0)), 0);
    if (contributions > AGENT_INTEGRATION_CONTRIBUTIONS_MAX_LENGTH) {
      context.addIssue({ code: 'custom', path: ['integrations'], message: 'Integration contributions exceed the aggregate limit.' });
    }
    if (agentProtocolSerializedJsonBytes(catalog) > AGENT_INTEGRATION_CATALOG_BYTES_LIMIT) {
      context.addIssue({ code: 'custom', message: 'Integration catalog exceeds its serialized UTF-8 byte limit.' });
    }
    addOrderedUniqueIssues(catalog.integrations.map((integration) => integration.integrationId), ['integrations'], 'Integration IDs', context);
    catalog.integrations.forEach((integration, integrationIndex) => {
      const parsed = AgentIntegrationDescriptorSchema.safeParse(integration);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: 'custom', path: ['integrations', integrationIndex, ...issue.path], message: issue.message });
        }
      }
    });
  });

export { AgentIntegrationDescriptorPortableSchema };
