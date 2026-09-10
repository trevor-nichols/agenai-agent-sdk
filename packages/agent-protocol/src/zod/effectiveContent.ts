// ------------------------------------------------------------------------------------------------
//                effectiveContent.ts - Effective content schemas - Dependencies: facts, foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
  agentProtocolSerializedJsonBytes,
} from '../foundation/types.js';
import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_EFFECTIVE_CONTENT_CATALOG_BYTES_LIMIT,
  AGENT_EFFECTIVE_CONTENT_CATALOG_MAX_LENGTH,
  AGENT_EFFECTIVE_CONTENT_KINDS,
  AGENT_EFFECTIVE_CONTENT_NAME_MAX_LENGTH,
  AGENT_EFFECTIVE_CONTENT_SUMMARY_MAX_LENGTH,
  AGENT_DEFINITION_MODES,
  type AgentEffectiveContentCatalog,
  type AgentEffectiveContentDescriptor,
} from '../effectiveContent/types.js';
import {
  AgentAvailabilityFactSchema,
  AgentEnvironmentSourceSchema,
  AgentInvocationPostureSchema,
  AgentQualifiedExtensionReferenceSchema,
} from './environmentFacts.js';
import {
  AgentEffectiveContentIdSchema,
  AgentIsoDateTimeSchema,
  createAgentCanonicalNonBlankStringSchema,
  withAcyclicProtocolInput,
} from './foundation.js';

const PositiveSafeIntegerSchema = z.number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const NameSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_EFFECTIVE_CONTENT_NAME_MAX_LENGTH,
);
const SummarySchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_EFFECTIVE_CONTENT_SUMMARY_MAX_LENGTH,
);

export const AgentDefinitionObservationSchema = z.object({
  mode: z.enum(AGENT_DEFINITION_MODES),
  hidden: AgentAvailabilityFactSchema,
}).strict().readonly();

export const AgentEffectiveContentDescriptorPortableSchema = z.object({
  contentId: AgentEffectiveContentIdSchema,
  revision: PositiveSafeIntegerSchema,
  kind: z.enum(AGENT_EFFECTIVE_CONTENT_KINDS),
  name: NameSchema,
  summary: SummarySchema.optional(),
  source: AgentEnvironmentSourceSchema,
  registration: AgentAvailabilityFactSchema,
  enablement: AgentAvailabilityFactSchema,
  invocation: AgentInvocationPostureSchema,
  modelCallability: AgentAvailabilityFactSchema,
  extension: AgentQualifiedExtensionReferenceSchema.optional(),
  agentDefinition: AgentDefinitionObservationSchema.optional(),
}).strict().readonly();

function validateEffectiveContentSemantics(
  descriptor: AgentEffectiveContentDescriptor,
  context: z.RefinementCtx,
): void {
  if (descriptor.agentDefinition && descriptor.kind !== 'agent_definition') {
    context.addIssue({
      code: 'custom',
      path: ['agentDefinition'],
      message: 'Only agent definitions can carry definition observations.',
    });
  }
  const unavailable =
    descriptor.registration.kind === 'known'
    && !descriptor.registration.value
    || descriptor.enablement.kind === 'known'
    && !descriptor.enablement.value;
  const positiveInvocation =
    descriptor.invocation === 'user_and_model'
    || descriptor.invocation === 'user_only'
    || descriptor.invocation === 'model_only';
  if (unavailable && positiveInvocation) {
    context.addIssue({
      code: 'custom',
      path: ['invocation'],
      message: 'Denied registration or enablement cannot advertise a positive invocation posture.',
    });
  }
  if (unavailable
    && descriptor.modelCallability.kind === 'known'
    && descriptor.modelCallability.value) {
    context.addIssue({
      code: 'custom',
      path: ['modelCallability'],
      message: 'Denied registration or enablement cannot be model-callable.',
    });
  }

  if (descriptor.modelCallability.kind !== 'known') return;

  const modelIsIncluded =
    descriptor.invocation === 'user_and_model'
    || descriptor.invocation === 'model_only';
  const modelIsExcluded =
    descriptor.invocation === 'user_only'
    || descriptor.invocation === 'unavailable';
  if (
    (modelIsIncluded && !descriptor.modelCallability.value)
    || (modelIsExcluded && descriptor.modelCallability.value)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['modelCallability'],
      message: 'modelCallability must agree with the explicit invocation posture.',
    });
  }
}

export const AgentEffectiveContentDescriptorSchema:
  z.ZodType<AgentEffectiveContentDescriptor> = withAcyclicProtocolInput(
    AgentEffectiveContentDescriptorPortableSchema,
    {
      maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
      maxCollectionLength: AGENT_EFFECTIVE_CONTENT_CATALOG_MAX_LENGTH,
    },
  ).superRefine(validateEffectiveContentSemantics);

export const AgentEffectiveContentCatalogPortableSchema = z.object({
  revision: PositiveSafeIntegerSchema,
  observedAt: AgentIsoDateTimeSchema,
  content: z.array(AgentEffectiveContentDescriptorPortableSchema)
    .max(AGENT_EFFECTIVE_CONTENT_CATALOG_MAX_LENGTH)
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
        message: 'Effective content IDs must be unique.',
      });
    }
    if (
      index > 0
      && compareStringsByUnicodeCodePoint(values[index - 1]!, value) >= 0
    ) {
      context.addIssue({
        code: 'custom',
        path: [...path, index],
        message: 'Effective content IDs must use canonical order.',
      });
    }
    seen.add(value);
  });
}

export const AgentEffectiveContentCatalogSchema:
  z.ZodType<AgentEffectiveContentCatalog> = withAcyclicProtocolInput(
    AgentEffectiveContentCatalogPortableSchema,
    {
      maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
      maxCollectionLength: AGENT_EFFECTIVE_CONTENT_CATALOG_MAX_LENGTH,
    },
  ).superRefine((catalog, context) => {
    if (
      agentProtocolSerializedJsonBytes(catalog)
      > AGENT_EFFECTIVE_CONTENT_CATALOG_BYTES_LIMIT
    ) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Effective content catalog exceeds its serialized UTF-8 byte limit.',
      });
    }

    addOrderedUniqueIssues(
      catalog.content.map((descriptor) => descriptor.contentId),
      ['content'],
      context,
    );

    catalog.content.forEach((descriptor, descriptorIndex) => {
      const parsed = AgentEffectiveContentDescriptorSchema.safeParse(descriptor);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({
            code: 'custom',
            path: ['content', descriptorIndex, ...issue.path],
            message: issue.message,
          });
        }
      }
    });
  });
