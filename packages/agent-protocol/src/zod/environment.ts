// ------------------------------------------------------------------------------------------------
//                environment.ts - Agent environment observation schemas - Dependencies: domain schemas, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  agentProtocolSerializedJsonBytes,
  type AgentCommandId,
  type AgentEffectiveContentId,
} from '../foundation/types.js';
import type {
  AgentEnvironmentCapability,
  AgentEnvironmentCommandsResult,
  AgentEnvironmentContentResult,
  AgentEnvironmentExtensionsResult,
  AgentEnvironmentIntegrationsResult,
  AgentEnvironmentInvalidation,
  AgentEnvironmentSnapshot,
} from '../environment/types.js';
import {
  AGENT_ENVIRONMENT_COMPLETENESSES,
  AGENT_ENVIRONMENT_DOMAIN_CATALOG_BYTES_LIMIT,
  AGENT_ENVIRONMENT_DOMAINS,
  AGENT_ENVIRONMENT_EVIDENCE_EXTENTS,
  AGENT_ENVIRONMENT_EFFECTIVE_ENTRIES_MAX_LENGTH,
  AGENT_ENVIRONMENT_INTEGRATION_CONTRIBUTIONS_MAX_LENGTH,
  AGENT_ENVIRONMENT_SCHEMA_VERSION,
  AGENT_ENVIRONMENT_SNAPSHOT_BYTES_LIMIT,
} from '../environment/types.js';
import {
  AgentCommandCatalogPortableSchema,
  AgentCommandCatalogSchema,
} from '../zod/commands.js';
import {
  AgentEffectiveContentCatalogPortableSchema,
  AgentEffectiveContentCatalogSchema,
} from '../zod/effectiveContent.js';
import {
  AgentExtensionCatalogPortableSchema,
  AgentExtensionCatalogSchema,
} from './extensions.js';
import {
  AgentIntegrationCatalogPortableSchema,
  AgentIntegrationCatalogSchema,
} from './integrations.js';
import {
  AgentEnvironmentReasonSchema,
} from './environmentFacts.js';
import {
  AgentEnvironmentIdSchema,
  withAcyclicProtocolInput,
} from './foundation.js';

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const DomainSchema = z.enum(AGENT_ENVIRONMENT_DOMAINS);
const ReasonSchema = AgentEnvironmentReasonSchema;
const ReasonListBaseSchema = z.array(ReasonSchema).max(16);
const ReasonListSchema = ReasonListBaseSchema.readonly();
const NonEmptyReasonListSchema = ReasonListBaseSchema.min(1).readonly();

function addUniqueIssues(
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
    seen.add(value);
  });
}

const AvailableDomainResultBaseSchema = z.object({
  kind: z.literal('available'),
  extent: z.enum(AGENT_ENVIRONMENT_EVIDENCE_EXTENTS),
  completeness: z.enum(AGENT_ENVIRONMENT_COMPLETENESSES),
  reasons: ReasonListSchema,
}).strict();

const UnavailableDomainResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported'), reasons: ReasonListSchema })
    .strict().readonly(),
  z.object({ kind: z.literal('not_initialized'), reasons: ReasonListSchema })
    .strict().readonly(),
  z.object({ kind: z.literal('unavailable'), reasons: NonEmptyReasonListSchema })
    .strict().readonly(),
]);

function availableDomainResultSchema<CatalogSchema extends z.ZodType>(
  catalog: CatalogSchema,
) {
  return AvailableDomainResultBaseSchema.extend({ catalog })
    .strict()
    .superRefine((result, context) => {
    if (result.completeness === 'complete' && result.reasons.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['reasons'],
        message: 'Complete environment results cannot carry reasons.',
      });
    }
    if (result.completeness === 'partial' && result.reasons.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['reasons'],
        message: 'Partial environment results require at least one reason.',
      });
    }
    })
    .readonly();
}

function domainResultSchema<CatalogSchema extends z.ZodType>(catalog: CatalogSchema) {
  return z.union([
    availableDomainResultSchema(catalog),
    UnavailableDomainResultSchema,
  ]);
}

const ContentResultPortableSchema = domainResultSchema(
  AgentEffectiveContentCatalogPortableSchema,
);
const CommandsResultPortableSchema = domainResultSchema(AgentCommandCatalogPortableSchema);
const ExtensionsResultPortableSchema = domainResultSchema(AgentExtensionCatalogPortableSchema);
const IntegrationsResultPortableSchema = domainResultSchema(AgentIntegrationCatalogPortableSchema);

export const AgentEnvironmentContentResultPortableSchema = ContentResultPortableSchema;
export const AgentEnvironmentCommandsResultPortableSchema = CommandsResultPortableSchema;
export const AgentEnvironmentExtensionsResultPortableSchema = ExtensionsResultPortableSchema;
export const AgentEnvironmentIntegrationsResultPortableSchema = IntegrationsResultPortableSchema;

const ContentResultSchema = domainResultSchema(AgentEffectiveContentCatalogSchema);
const CommandsResultSchema = domainResultSchema(AgentCommandCatalogSchema);
const ExtensionsResultSchema = domainResultSchema(AgentExtensionCatalogSchema);
const IntegrationsResultSchema = domainResultSchema(AgentIntegrationCatalogSchema);

export const AgentEnvironmentContentResultSchema: z.ZodType<AgentEnvironmentContentResult> =
  withAcyclicProtocolInput(ContentResultSchema, {
    maxDepth: 16,
    maxCollectionLength: AGENT_ENVIRONMENT_EFFECTIVE_ENTRIES_MAX_LENGTH * 8,
  });
export const AgentEnvironmentCommandsResultSchema: z.ZodType<AgentEnvironmentCommandsResult> =
  withAcyclicProtocolInput(CommandsResultSchema, {
    maxDepth: 16,
    maxCollectionLength: AGENT_ENVIRONMENT_EFFECTIVE_ENTRIES_MAX_LENGTH * 8,
  });
export const AgentEnvironmentExtensionsResultSchema: z.ZodType<AgentEnvironmentExtensionsResult> =
  withAcyclicProtocolInput(ExtensionsResultSchema, {
    maxDepth: 16,
    maxCollectionLength: 16_384,
  });
export const AgentEnvironmentIntegrationsResultSchema: z.ZodType<AgentEnvironmentIntegrationsResult> =
  withAcyclicProtocolInput(IntegrationsResultSchema, {
    maxDepth: 16,
    maxCollectionLength: 16_384,
  });

function addDomainByteBound(
  value: unknown,
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  if (agentProtocolSerializedJsonBytes(value) > AGENT_ENVIRONMENT_DOMAIN_CATALOG_BYTES_LIMIT) {
    context.addIssue({
      code: 'custom',
      path: [...path],
      message: 'Environment domain exceeds its serialized UTF-8 byte limit.',
    });
  }
}

function validateAvailableDomainBytes(
  result: unknown,
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  if (typeof result !== 'object' || result === null || !('kind' in result)) return;
  if ((result as { kind?: unknown }).kind !== 'available') return;
  addDomainByteBound(result, path, context);
}

const SnapshotBaseSchema = z.object({
  schemaVersion: z.literal(AGENT_ENVIRONMENT_SCHEMA_VERSION),
  environmentId: AgentEnvironmentIdSchema,
  revision: PositiveSafeIntegerSchema,
}).strict();

export const AgentEnvironmentSnapshotPortableSchema = SnapshotBaseSchema.extend({
  content: ContentResultPortableSchema,
  commands: CommandsResultPortableSchema,
  extensions: ExtensionsResultPortableSchema,
  integrations: IntegrationsResultPortableSchema,
}).strict().readonly();

function findContent(
  result: AgentEnvironmentContentResult,
  id: AgentEffectiveContentId,
  revision: number,
): { readonly kind: string } | null {
  if (result.kind !== 'available') return null;
  const entry = result.catalog.content.find((candidate) => candidate.contentId === id);
  return entry && entry.revision === revision ? entry : null;
}

function findCommand(
  result: AgentEnvironmentCommandsResult,
  id: AgentCommandId,
  revision: number,
): unknown | null {
  if (result.kind !== 'available') return null;
  const entry = result.catalog.commands.find((candidate) => candidate.commandId === id);
  return entry && entry.revision === revision ? entry : null;
}

function findIntegration(
  result: AgentEnvironmentIntegrationsResult,
  id: string,
  revision: number,
): { readonly kind: string } | null {
  if (result.kind !== 'available') return null;
  const entry = result.catalog.integrations.find((candidate) => candidate.integrationId === id);
  return entry && entry.revision === revision ? entry : null;
}

function findExtension(
  result: AgentEnvironmentExtensionsResult,
  id: string,
  revision: number,
): unknown | null {
  if (result.kind !== 'available') return null;
  const entry = result.catalog.extensions.find((candidate) => candidate.extensionId === id);
  return entry && entry.revision === revision ? entry : null;
}

function validateContentExtensionReferences(
  snapshot: AgentEnvironmentSnapshot,
  context: z.RefinementCtx,
): void {
  if (snapshot.content.kind !== 'available') return;
  snapshot.content.catalog.content.forEach((descriptor, descriptorIndex) => {
    const reference = descriptor.extension;
    if (reference === undefined) return;
    const path = ['content', 'catalog', 'content', descriptorIndex, 'extension'];
    const entry = findExtension(
      snapshot.extensions,
      reference.extensionId,
      reference.revision,
    );
    if (snapshot.extensions.kind !== 'available'
      || snapshot.extensions.catalog.revision !== reference.catalogRevision
      || entry === null) {
      context.addIssue({
        code: 'custom',
        path,
        message: 'Content extension reference must resolve in the exact catalog revision.',
      });
    }
  });
}

function validateComponentReferences(
  snapshot: AgentEnvironmentSnapshot,
  context: z.RefinementCtx,
): void {
  if (snapshot.extensions.kind !== 'available') return;
  snapshot.extensions.catalog.extensions.forEach((extension, extensionIndex) => {
    extension.components.forEach((component, componentIndex) => {
      if (!('target' in component) || component.target === undefined) return;
      const target = component.target;
      const path: (string | number)[] = [
        'extensions',
        'catalog',
        'extensions',
        extensionIndex,
        'components',
        componentIndex,
        'target',
      ];
      if (component.kind === 'skill' || component.kind === 'rule'
        || component.kind === 'prompt' || component.kind === 'agent_definition') {
        if (target.domain !== 'content') {
          context.addIssue({ code: 'custom', path: [...path, 'domain'], message: 'Content components require a content target.' });
          return;
        }
        const entry = findContent(snapshot.content, target.id, target.revision);
        if (snapshot.content.kind !== 'available'
          || snapshot.content.catalog.revision !== target.catalogRevision
          || entry === null) {
          context.addIssue({ code: 'custom', path, message: 'Content target must resolve in the exact catalog revision.' });
          return;
        }
        if (entry.kind !== component.kind) {
          context.addIssue({ code: 'custom', path, message: 'Content target kind contradicts the component kind.' });
        }
        return;
      }
      if (component.kind === 'command') {
        if (target.domain !== 'commands') {
          context.addIssue({ code: 'custom', path: [...path, 'domain'], message: 'Command components require a commands target.' });
          return;
        }
        const entry = findCommand(snapshot.commands, target.id, target.revision);
        if (snapshot.commands.kind !== 'available'
          || snapshot.commands.catalog.revision !== target.catalogRevision
          || entry === null) {
          context.addIssue({ code: 'custom', path, message: 'Command target must resolve in the exact catalog revision.' });
        }
        return;
      }
      if (component.kind === 'mcp_server' || component.kind === 'connector') {
        if (target.domain !== 'integrations') {
          context.addIssue({ code: 'custom', path: [...path, 'domain'], message: 'Integration components require an integrations target.' });
          return;
        }
        const entry = findIntegration(snapshot.integrations, target.id, target.revision);
        if (snapshot.integrations.kind !== 'available'
          || snapshot.integrations.catalog.revision !== target.catalogRevision
          || entry === null) {
          context.addIssue({ code: 'custom', path, message: 'Integration target must resolve in the exact catalog revision.' });
          return;
        }
        const expectedKind = component.kind === 'mcp_server' ? 'mcp' : 'connector';
        if (entry.kind !== expectedKind) {
          context.addIssue({ code: 'custom', path, message: 'Integration target kind contradicts the component kind.' });
        }
      }
    });
  });
}

export const AgentEnvironmentSnapshotSchema: z.ZodType<AgentEnvironmentSnapshot> =
  withAcyclicProtocolInput(
    SnapshotBaseSchema.extend({
      content: ContentResultSchema,
      commands: CommandsResultSchema,
      extensions: ExtensionsResultSchema,
      integrations: IntegrationsResultSchema,
    }).strict().readonly(),
    {
      maxDepth: 16,
      maxCollectionLength: 32_768,
    },
  ).superRefine((snapshot, context) => {
    validateAvailableDomainBytes(snapshot.content, ['content'], context);
    validateAvailableDomainBytes(snapshot.commands, ['commands'], context);
    validateAvailableDomainBytes(snapshot.extensions, ['extensions'], context);
    validateAvailableDomainBytes(snapshot.integrations, ['integrations'], context);

    const contentCount = snapshot.content.kind === 'available'
      ? snapshot.content.catalog.content.length
      : 0;
    const commandCount = snapshot.commands.kind === 'available'
      ? snapshot.commands.catalog.commands.length
      : 0;
    if (contentCount + commandCount > AGENT_ENVIRONMENT_EFFECTIVE_ENTRIES_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Effective content and command entries exceed the aggregate limit.',
      });
    }

    const integrationContributions = snapshot.integrations.kind === 'available'
      ? snapshot.integrations.catalog.integrations.reduce((total, integration) => (
        total + (integration.kind === 'mcp'
          ? integration.servers.reduce((serverTotal, server) => (
            serverTotal + server.tools.length + server.resources.length
          ), 0)
          : (integration.tools?.length ?? 0))
      ), 0)
      : 0;
    if (integrationContributions > AGENT_ENVIRONMENT_INTEGRATION_CONTRIBUTIONS_MAX_LENGTH) {
      context.addIssue({
        code: 'custom',
        path: ['integrations'],
        message: 'Integration tools and resources exceed the aggregate limit.',
      });
    }

    validateContentExtensionReferences(snapshot, context);
    validateComponentReferences(snapshot, context);
    if (agentProtocolSerializedJsonBytes(snapshot) > AGENT_ENVIRONMENT_SNAPSHOT_BYTES_LIMIT) {
      context.addIssue({
        code: 'custom',
        message: 'Environment snapshot exceeds its serialized UTF-8 byte limit.',
      });
    }
  });

export const AgentEnvironmentInvalidationSchema: z.ZodType<AgentEnvironmentInvalidation> =
  withAcyclicProtocolInput(z.object({
    environmentId: AgentEnvironmentIdSchema,
    domains: z.array(DomainSchema).min(1).max(AGENT_ENVIRONMENT_DOMAINS.length).readonly(),
  }).strict().readonly(), {
    maxDepth: 4,
    maxCollectionLength: AGENT_ENVIRONMENT_DOMAINS.length + 2,
  }).superRefine((invalidation, context) => {
    addUniqueIssues(invalidation.domains, ['domains'], 'Invalidation domains', context);
  });

const EnvironmentReadCapabilitySchema = z.union([
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z.object({
    kind: z.literal('read'),
    domains: z.array(DomainSchema).min(1).max(AGENT_ENVIRONMENT_DOMAINS.length).readonly(),
  }).strict().readonly(),
  z.object({
    kind: z.literal('read_and_watch'),
    domains: z.array(DomainSchema).min(1).max(AGENT_ENVIRONMENT_DOMAINS.length).readonly(),
  }).strict().readonly(),
]);

export const AgentEnvironmentReadCapabilitySchema = withAcyclicProtocolInput(
  EnvironmentReadCapabilitySchema,
  { maxDepth: 4, maxCollectionLength: AGENT_ENVIRONMENT_DOMAINS.length + 2 },
).superRefine((capability, context) => {
  if (capability.kind === 'unsupported') return;
  addUniqueIssues(capability.domains, ['domains'], 'Environment capability domains', context);
});

export const AgentEnvironmentCapabilitySchema: z.ZodType<AgentEnvironmentCapability> =
  withAcyclicProtocolInput(z.object({
    instance: AgentEnvironmentReadCapabilitySchema,
    session: AgentEnvironmentReadCapabilitySchema,
  }).strict().readonly(), {
    maxDepth: 6,
    maxCollectionLength: AGENT_ENVIRONMENT_DOMAINS.length * 2 + 4,
  });
