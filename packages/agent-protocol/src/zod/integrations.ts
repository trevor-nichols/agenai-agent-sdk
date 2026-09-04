// ------------------------------------------------------------------------------------------------
//                integrations.ts - Safe integration schemas - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_INTEGRATION_DESCRIPTION_MAX_LENGTH,
  AGENT_INTEGRATION_CATALOG_MAX_LENGTH,
  AGENT_INTEGRATION_NAME_MAX_LENGTH,
  AGENT_INTEGRATION_RESOURCES_MAX_LENGTH,
  AGENT_INTEGRATION_SERVERS_MAX_LENGTH,
  AGENT_INTEGRATION_STATUSES,
  AGENT_INTEGRATION_TOOLS_MAX_LENGTH,
  type AgentIntegrationCatalog,
  type AgentIntegrationDescriptor,
} from '../integrations/types.js';
import {
  AgentIntegrationIdSchema,
  AgentIntegrationResourceIdSchema,
  AgentIntegrationServerIdSchema,
  AgentIntegrationToolIdSchema,
  AgentIsoDateTimeSchema,
  createAgentCanonicalNonBlankStringSchema,
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

const AgentIntegrationDescriptorPortableSchema = z.object({
  integrationId: AgentIntegrationIdSchema,
  revision: PositiveSafeIntegerSchema,
  kind: z.literal('mcp'),
  name: NameSchema,
  status: z.enum(AGENT_INTEGRATION_STATUSES),
  servers: z.array(ServerSchema).max(AGENT_INTEGRATION_SERVERS_MAX_LENGTH).readonly(),
}).strict().readonly();

export const AgentIntegrationDescriptorSchema: z.ZodType<AgentIntegrationDescriptor> =
  AgentIntegrationDescriptorPortableSchema.superRefine((integration, context) => {
    addOrderedUniqueIssues(integration.servers.map((server) => server.serverId), ['servers'], 'Integration server IDs', context);
    integration.servers.forEach((server, serverIndex) => {
      addOrderedUniqueIssues(server.tools.map((tool) => tool.toolId), ['servers', serverIndex, 'tools'], 'Integration tool IDs', context);
      addOrderedUniqueIssues(server.resources.map((resource) => resource.resourceId), ['servers', serverIndex, 'resources'], 'Integration resource IDs', context);
    });
  });

export const AgentIntegrationCatalogPortableSchema = z.object({
  revision: PositiveSafeIntegerSchema,
  observedAt: AgentIsoDateTimeSchema,
  integrations: z.array(AgentIntegrationDescriptorPortableSchema)
    .max(AGENT_INTEGRATION_CATALOG_MAX_LENGTH)
    .readonly(),
}).strict().readonly();

export const AgentIntegrationCatalogSchema: z.ZodType<AgentIntegrationCatalog> =
  AgentIntegrationCatalogPortableSchema.superRefine((catalog, context) => {
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
