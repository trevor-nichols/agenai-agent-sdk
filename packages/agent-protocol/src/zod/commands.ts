// ------------------------------------------------------------------------------------------------
//                commands.ts - Native command schemas - Dependencies: facts, foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
  agentProtocolSerializedJsonBytes,
} from '../foundation/types.js';
import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_COMMAND_CATALOG_BYTES_LIMIT,
  AGENT_COMMAND_CATALOG_MAX_LENGTH,
  AGENT_COMMAND_NAME_MAX_LENGTH,
  AGENT_COMMAND_SUMMARY_MAX_LENGTH,
  type AgentCommandCatalog,
  type AgentCommandDescriptor,
} from '../commands/types.js';
import {
  AgentAvailabilityFactSchema,
  AgentEnvironmentSourceSchema,
} from './environmentFacts.js';
import {
  AgentCommandIdSchema,
  AgentIsoDateTimeSchema,
  AgentOperationIdSchema,
  createAgentCanonicalNonBlankStringSchema,
  withAcyclicProtocolInput,
} from './foundation.js';

const PositiveSafeIntegerSchema = z.number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const NameSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_COMMAND_NAME_MAX_LENGTH,
);
const SummarySchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_COMMAND_SUMMARY_MAX_LENGTH,
);

const AgentCommandOperationReferenceSchema = z.object({
  operationId: AgentOperationIdSchema,
  revision: PositiveSafeIntegerSchema,
  catalogRevision: PositiveSafeIntegerSchema,
}).strict().readonly();

export const AgentCommandDescriptorPortableSchema = z.object({
  commandId: AgentCommandIdSchema,
  revision: PositiveSafeIntegerSchema,
  name: NameSchema,
  summary: SummarySchema.optional(),
  source: AgentEnvironmentSourceSchema,
  availability: AgentAvailabilityFactSchema,
  operation: AgentCommandOperationReferenceSchema.optional(),
}).strict().readonly();

export const AgentCommandDescriptorSchema:
  z.ZodType<AgentCommandDescriptor> = withAcyclicProtocolInput(
    AgentCommandDescriptorPortableSchema,
    {
      maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
      maxCollectionLength: AGENT_COMMAND_CATALOG_MAX_LENGTH,
    },
  );

export const AgentCommandCatalogPortableSchema = z.object({
  revision: PositiveSafeIntegerSchema,
  observedAt: AgentIsoDateTimeSchema,
  commands: z.array(AgentCommandDescriptorPortableSchema)
    .max(AGENT_COMMAND_CATALOG_MAX_LENGTH)
    .readonly(),
}).strict().readonly();

function addOrderedUniqueIssues(
  values: readonly string[],
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [...path, index],
        message: 'Command IDs must be unique.',
      });
    }
    if (
      index > 0
      && compareStringsByUnicodeCodePoint(values[index - 1]!, value) >= 0
    ) {
      context.addIssue({
        code: 'custom',
        path: [...path, index],
        message: 'Command IDs must use canonical order.',
      });
    }
    seen.add(value);
  });
}

export const AgentCommandCatalogSchema: z.ZodType<AgentCommandCatalog> =
  withAcyclicProtocolInput(
    AgentCommandCatalogPortableSchema,
    {
      maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
      maxCollectionLength: AGENT_COMMAND_CATALOG_MAX_LENGTH,
    },
  ).superRefine((catalog, context) => {
    if (
      agentProtocolSerializedJsonBytes(catalog)
      > AGENT_COMMAND_CATALOG_BYTES_LIMIT
    ) {
      context.addIssue({
        code: 'custom',
        path: ['commands'],
        message: 'Command catalog exceeds its serialized UTF-8 byte limit.',
      });
    }

    addOrderedUniqueIssues(
      catalog.commands.map((descriptor) => descriptor.commandId),
      ['commands'],
      context,
    );
    catalog.commands.forEach((descriptor, descriptorIndex) => {
      const parsed = AgentCommandDescriptorSchema.safeParse(descriptor);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({
            code: 'custom',
            path: ['commands', descriptorIndex, ...issue.path],
            message: issue.message,
          });
        }
      }
    });
  });
