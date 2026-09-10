// ------------------------------------------------------------------------------------------------
//                extensions.ts - Native extension observation schemas - Dependencies: environment, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  type AgentExtensionCatalog,
  type AgentExtensionComponent,
  type AgentExtensionDescriptor,
} from '../extensions/types.js';
import { agentProtocolSerializedJsonBytes } from '../foundation/types.js';
import {
  AGENT_EXTENSION_CATALOG_BYTES_LIMIT,
  AGENT_EXTENSION_CATALOG_MAX_LENGTH,
  AGENT_EXTENSION_COMPONENT_NAME_MAX_LENGTH,
  AGENT_EXTENSION_COMPONENTS_MAX_LENGTH,
  AGENT_EXTENSION_NAME_MAX_LENGTH,
  AGENT_EXTENSION_SUMMARY_MAX_LENGTH,
  AGENT_EXTENSION_VERSION_MAX_LENGTH,
} from '../extensions/types.js';
import {
  AgentAvailabilityFactSchema,
  AgentEnvironmentSourceSchema,
} from './environmentFacts.js';
import {
  AgentCommandIdSchema,
  AgentEffectiveContentIdSchema,
  AgentExtensionIdSchema,
  AgentIntegrationIdSchema,
  AgentIsoDateTimeSchema,
  createAgentCanonicalNonBlankStringSchema,
  withAcyclicProtocolInput,
} from './foundation.js';

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const NameSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_EXTENSION_NAME_MAX_LENGTH,
);
const SummarySchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_EXTENSION_SUMMARY_MAX_LENGTH,
);
const VersionSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_EXTENSION_VERSION_MAX_LENGTH,
);
const ComponentNameSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_EXTENSION_COMPONENT_NAME_MAX_LENGTH,
);

const ContentTargetSchema = z.object({
  domain: z.literal('content'),
  id: AgentEffectiveContentIdSchema,
  revision: PositiveSafeIntegerSchema,
  catalogRevision: PositiveSafeIntegerSchema,
}).strict().readonly();

const CommandTargetSchema = z.object({
  domain: z.literal('commands'),
  id: AgentCommandIdSchema,
  revision: PositiveSafeIntegerSchema,
  catalogRevision: PositiveSafeIntegerSchema,
}).strict().readonly();

const IntegrationTargetSchema = z.object({
  domain: z.literal('integrations'),
  id: AgentIntegrationIdSchema,
  revision: PositiveSafeIntegerSchema,
  catalogRevision: PositiveSafeIntegerSchema,
}).strict().readonly();

const ContentComponentKinds = [
  'skill',
  'rule',
  'prompt',
  'agent_definition',
] as const;
const NonTargetedComponentKinds = [
  'hook',
  'lsp_server',
  'scheduled_task',
  'other',
] as const;

const ContentComponentSchema = z.object({
  kind: z.enum(ContentComponentKinds),
  name: ComponentNameSchema,
  target: ContentTargetSchema.optional(),
}).strict().readonly();

const CommandComponentSchema = z.object({
  kind: z.literal('command'),
  name: ComponentNameSchema,
  target: CommandTargetSchema.optional(),
}).strict().readonly();

const IntegrationComponentSchema = z.object({
  kind: z.enum(['mcp_server', 'connector']),
  name: ComponentNameSchema,
  target: IntegrationTargetSchema.optional(),
}).strict().readonly();

const DescriptiveComponentSchema = z.object({
  kind: z.enum(NonTargetedComponentKinds),
  name: ComponentNameSchema,
}).strict().readonly();

export const AgentExtensionComponentPortableSchema = z.discriminatedUnion('kind', [
  ContentComponentSchema,
  CommandComponentSchema,
  IntegrationComponentSchema,
  DescriptiveComponentSchema,
]);

export const AgentExtensionDescriptorPortableSchema = z.object({
  extensionId: AgentExtensionIdSchema,
  revision: PositiveSafeIntegerSchema,
  name: NameSchema,
  summary: SummarySchema.optional(),
  version: VersionSchema.optional(),
  installation: AgentAvailabilityFactSchema,
  enablement: AgentAvailabilityFactSchema,
  source: AgentEnvironmentSourceSchema,
  components: z.array(AgentExtensionComponentPortableSchema)
    .max(AGENT_EXTENSION_COMPONENTS_MAX_LENGTH)
    .readonly(),
}).strict().readonly();

function addUniqueAndOrderedIssues(
  values: readonly string[],
  path: readonly (string | number)[],
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [...path, index],
        message: `${label} must be unique.`,
      });
    }
    if (
      index > 0
      && compareStringsByUnicodeCodePoint(values[index - 1]!, value) >= 0
    ) {
      context.addIssue({
        code: 'custom',
        path: [...path, index],
        message: `${label} must use canonical ID order.`,
      });
    }
    seen.add(value);
  });
}

function validateComponent(
  component: AgentExtensionComponent,
  index: number,
  context: z.RefinementCtx,
): void {
  const target = 'target' in component ? component.target : undefined;
  if (
    (component.kind === 'hook'
      || component.kind === 'lsp_server'
      || component.kind === 'scheduled_task'
      || component.kind === 'other')
    && target !== undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['components', index, 'target'],
      message: 'Descriptive extension components cannot carry a qualified target.',
    });
  }
}

export const AgentExtensionDescriptorSchema: z.ZodType<AgentExtensionDescriptor> =
  withAcyclicProtocolInput(AgentExtensionDescriptorPortableSchema, {
    maxDepth: 16,
    maxCollectionLength: AGENT_EXTENSION_COMPONENTS_MAX_LENGTH * 4,
  }).superRefine((descriptor, context) => {
    descriptor.components.forEach((component, index) => {
      validateComponent(component, index, context);
    });
  });

export const AgentExtensionCatalogPortableSchema = z.object({
  revision: PositiveSafeIntegerSchema,
  observedAt: AgentIsoDateTimeSchema,
  extensions: z.array(AgentExtensionDescriptorPortableSchema)
    .max(AGENT_EXTENSION_CATALOG_MAX_LENGTH)
    .readonly(),
}).strict().readonly();

export const AgentExtensionCatalogSchema: z.ZodType<AgentExtensionCatalog> =
  withAcyclicProtocolInput(AgentExtensionCatalogPortableSchema, {
    maxDepth: 16,
    // The preflight counts object properties as well as array members. Leave
    // room for the fixed descriptor fields while retaining a finite bound.
    maxCollectionLength: AGENT_EXTENSION_COMPONENTS_MAX_LENGTH * 4,
  }).superRefine((catalog, context) => {
    addUniqueAndOrderedIssues(
      catalog.extensions.map((extension) => extension.extensionId),
      ['extensions'],
      'Extension IDs',
      context,
    );
    let components = 0;
    catalog.extensions.forEach((extension, extensionIndex) => {
      const parsed = AgentExtensionDescriptorSchema.safeParse(extension);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({
            code: 'custom',
            path: ['extensions', extensionIndex, ...issue.path],
            message: issue.message,
          });
        }
      }
      components += extension.components.length;
    });
    if (components > AGENT_EXTENSION_COMPONENTS_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        path: ['extensions'],
        message: 'Extension components exceed the aggregate limit.',
      });
    }
    if (agentProtocolSerializedJsonBytes(catalog) > AGENT_EXTENSION_CATALOG_BYTES_LIMIT) {
      context.addIssue({
        code: 'custom',
        message: 'Extension catalog exceeds its serialized UTF-8 byte limit.',
      });
    }
  });
