// ------------------------------------------------------------------------------------------------
//                capabilities.ts - Technical capability schema - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_VERSION,
} from '../foundation/types.js';
import { AGENT_ARTIFACT_KINDS } from '../artifacts/types.js';
import {
  AGENT_AUTHENTICATION_FLOWS,
  AGENT_FILE_CHANGE_MODES,
  type AgentCapabilities,
} from '../capabilities/types.js';
import {
  AGENT_COLLABORATION_CONTROL_ACTIONS,
  AGENT_COLLABORATION_GRAPH_LIMITS,
  AGENT_COLLABORATION_ROLES,
} from '../collaboration/types.js';
import {
  AGENT_CONFIGURATION_FIELD_KINDS,
  AGENT_CONFIGURATION_FIELDS_MAX_LENGTH,
} from '../configuration/types.js';
import {
  AGENT_INTEGRATION_KINDS,
  AGENT_INTEGRATION_RESOURCES_MAX_LENGTH,
  AGENT_INTEGRATION_CATALOG_MAX_LENGTH,
  AGENT_INTEGRATION_SERVERS_MAX_LENGTH,
  AGENT_INTEGRATION_TOOLS_MAX_LENGTH,
} from '../integrations/types.js';
import {
  AGENT_MANAGED_CONTENT_CATALOG_MAX_LENGTH,
  AGENT_MANAGED_CONTENT_KINDS,
} from '../managedContent/types.js';
import {
  AGENT_OPERATION_CATALOG_MAX_LENGTH,
  AGENT_OPERATION_EXECUTION_MODES,
  AGENT_OPERATION_FIELDS_MAX_LENGTH,
  AGENT_OPERATION_FIELD_KINDS,
  AGENT_OPERATION_KINDS,
} from '../operations/types.js';
import {
  AGENT_APPROVAL_PERSISTENCES,
  AGENT_APPROVAL_SCOPE_KINDS,
  AGENT_ELICITATION_FIELD_KINDS,
  AGENT_ELICITATION_FIELDS_MAX_LENGTH,
} from '../requests/types.js';
import { AGENT_GENERATED_RESOURCE_KINDS } from '../resources/types.js';
import {
  AGENT_CONTEXT_COMPACTION_TRIGGERS,
  AGENT_CONTEXT_CUMULATIVE_USAGE_FIELDS,
  AGENT_CONTEXT_MEASUREMENT_SCOPES,
  AGENT_IMAGE_INPUT_MEDIA_TYPES,
  AGENT_IMAGE_INPUT_SOURCE_KINDS,
  AGENT_TURN_INTERACTION_MODES,
} from '../turns/types.js';
import { AgentProviderKeySchema } from './foundation.js';

function addCanonicalListIssues(
  input: {
    readonly values: readonly string[];
    readonly canonicalOrder?: readonly string[];
    readonly path: readonly (string | number)[];
    readonly label: string;
  },
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  let previousOrder = -1;
  input.values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [...input.path, index],
        message: `${input.label} must be unique.`,
      });
    }
    seen.add(value);

    const order = input.canonicalOrder
      ? input.canonicalOrder.indexOf(value)
      : index === 0 || input.values[index - 1]! < value
        ? index
        : previousOrder;
    if (index > 0 && order <= previousOrder) {
      context.addIssue({
        code: 'custom',
        path: [...input.path, index],
        message: `${input.label} must use canonical order.`,
      });
    }
    previousOrder = order;
  });
}

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

function boundedPositiveSafeInteger(maximum: number): z.ZodNumber {
  return z.number().int().positive().max(maximum);
}

export const AgentApprovalCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      modes: z
        .array(
          z
            .object({
              persistence: z.enum(AGENT_APPROVAL_PERSISTENCES),
              scopeKinds: z
                .array(z.enum(AGENT_APPROVAL_SCOPE_KINDS))
                .min(1)
                .max(AGENT_APPROVAL_SCOPE_KINDS.length)
                .meta({ uniqueItems: true })
                .readonly(),
            })
            .strict()
            .readonly(),
        )
        .min(1)
        .max(AGENT_APPROVAL_PERSISTENCES.length)
        .readonly(),
    })
    .strict()
    .superRefine((capability, context) => {
      addCanonicalListIssues(
        {
          values: capability.modes.map((mode) => mode.persistence),
          canonicalOrder: AGENT_APPROVAL_PERSISTENCES,
          path: ['modes'],
          label: 'Approval persistence modes',
        },
        context,
      );
      capability.modes.forEach((mode, index) => {
        addCanonicalListIssues(
          {
            values: mode.scopeKinds,
            canonicalOrder: AGENT_APPROVAL_SCOPE_KINDS,
            path: ['modes', index, 'scopeKinds'],
            label: 'Approval scope kinds',
          },
          context,
        );
      });
    })
    .readonly(),
]);

const AgentContextUsageCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      measurementScopes: z
        .array(z.enum(AGENT_CONTEXT_MEASUREMENT_SCOPES))
        .min(1)
        .max(AGENT_CONTEXT_MEASUREMENT_SCOPES.length)
        .meta({ uniqueItems: true })
        .readonly(),
      cumulativeFields: z
        .array(z.enum(AGENT_CONTEXT_CUMULATIVE_USAGE_FIELDS))
        .max(AGENT_CONTEXT_CUMULATIVE_USAGE_FIELDS.length)
        .meta({ uniqueItems: true })
        .readonly(),
    })
    .strict()
    .readonly(),
]);

const AgentContextCompactionCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      triggers: z
        .array(z.enum(AGENT_CONTEXT_COMPACTION_TRIGGERS))
        .min(1)
        .max(AGENT_CONTEXT_COMPACTION_TRIGGERS.length)
        .meta({ uniqueItems: true })
        .readonly(),
      sameSessionContinuation: z.boolean(),
    })
    .strict()
    .readonly(),
]);

export const AgentImageInputCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      sourceKinds: z
        .array(z.enum(AGENT_IMAGE_INPUT_SOURCE_KINDS))
        .min(1)
        .max(AGENT_IMAGE_INPUT_SOURCE_KINDS.length)
        .meta({ uniqueItems: true })
        .readonly(),
      mediaTypes: z
        .array(z.enum(AGENT_IMAGE_INPUT_MEDIA_TYPES))
        .min(1)
        .max(AGENT_IMAGE_INPUT_MEDIA_TYPES.length)
        .meta({ uniqueItems: true })
        .readonly(),
      maxImages: PositiveSafeIntegerSchema,
      maxBytesPerImage: PositiveSafeIntegerSchema,
      maxTotalBytes: PositiveSafeIntegerSchema,
      maxWidthPixels: PositiveSafeIntegerSchema,
      maxHeightPixels: PositiveSafeIntegerSchema,
      maxPixelsPerImage: PositiveSafeIntegerSchema,
      supportsImageOnly: z.boolean(),
    })
    .strict()
    .superRefine((capability, context) => {
      addCanonicalListIssues(
        {
          values: capability.sourceKinds,
          canonicalOrder: AGENT_IMAGE_INPUT_SOURCE_KINDS,
          path: ['sourceKinds'],
          label: 'Image input source kinds',
        },
        context,
      );
      addCanonicalListIssues(
        {
          values: capability.mediaTypes,
          canonicalOrder: AGENT_IMAGE_INPUT_MEDIA_TYPES,
          path: ['mediaTypes'],
          label: 'Image input media types',
        },
        context,
      );
      if (capability.maxTotalBytes < capability.maxBytesPerImage) {
        context.addIssue({
          code: 'custom',
          path: ['maxTotalBytes'],
          message: 'Image input aggregate bytes must admit one maximum-size image.',
        });
      }
      if (
        capability.maxTotalBytes
        > capability.maxBytesPerImage * capability.maxImages
      ) {
        context.addIssue({
          code: 'custom',
          path: ['maxTotalBytes'],
          message: 'Image input aggregate bytes cannot exceed the count and per-image maximum.',
        });
      }
      if (
        capability.maxPixelsPerImage
        > capability.maxWidthPixels * capability.maxHeightPixels
      ) {
        context.addIssue({
          code: 'custom',
          path: ['maxPixelsPerImage'],
          message: 'Image input pixel maximum cannot exceed the dimension maximums.',
        });
      }
    })
    .readonly(),
]);

export const AgentOperationInputCapabilitySchema = z
  .object({
    text: z.literal(true),
    images: AgentImageInputCapabilitySchema,
  })
  .strict()
  .readonly();

const AgentOperationsCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      operationKinds: z
        .array(z.enum(AGENT_OPERATION_KINDS))
        .min(1)
        .max(AGENT_OPERATION_KINDS.length)
        .meta({ uniqueItems: true })
        .readonly(),
      fieldKinds: z
        .array(z.enum(AGENT_OPERATION_FIELD_KINDS))
        .min(1)
        .max(AGENT_OPERATION_FIELD_KINDS.length)
        .meta({ uniqueItems: true })
        .readonly(),
      executionModes: z
        .array(z.enum(AGENT_OPERATION_EXECUTION_MODES))
        .min(1)
        .max(AGENT_OPERATION_EXECUTION_MODES.length)
        .meta({ uniqueItems: true })
        .readonly(),
      maxOperations: boundedPositiveSafeInteger(
        AGENT_OPERATION_CATALOG_MAX_LENGTH,
      ),
      maxFieldsPerOperation: boundedPositiveSafeInteger(
        AGENT_OPERATION_FIELDS_MAX_LENGTH,
      ),
    })
    .strict()
    .readonly(),
]);

const AgentManagedContentCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      contentKinds: z
        .array(z.enum(AGENT_MANAGED_CONTENT_KINDS))
        .min(1)
        .max(AGENT_MANAGED_CONTENT_KINDS.length)
        .meta({ uniqueItems: true })
        .readonly(),
      maxEntries: boundedPositiveSafeInteger(
        AGENT_MANAGED_CONTENT_CATALOG_MAX_LENGTH,
      ),
    })
    .strict()
    .readonly(),
]);

const AgentIntegrationsCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      integrationKinds: z
        .array(z.enum(AGENT_INTEGRATION_KINDS))
        .min(1)
        .max(AGENT_INTEGRATION_KINDS.length)
        .meta({ uniqueItems: true })
        .readonly(),
      maxIntegrations: boundedPositiveSafeInteger(
        AGENT_INTEGRATION_CATALOG_MAX_LENGTH,
      ),
      maxServersPerIntegration: boundedPositiveSafeInteger(
        AGENT_INTEGRATION_SERVERS_MAX_LENGTH,
      ),
      maxToolsPerServer: boundedPositiveSafeInteger(
        AGENT_INTEGRATION_TOOLS_MAX_LENGTH,
      ),
      maxResourcesPerServer: boundedPositiveSafeInteger(
        AGENT_INTEGRATION_RESOURCES_MAX_LENGTH,
      ),
    })
    .strict()
    .readonly(),
]);

const AgentCollaborationCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      roles: z
        .array(z.enum(AGENT_COLLABORATION_ROLES))
        .min(1)
        .max(AGENT_COLLABORATION_ROLES.length)
        .meta({ uniqueItems: true })
        .readonly(),
      controlActions: z
        .array(z.enum(AGENT_COLLABORATION_CONTROL_ACTIONS))
        .min(1)
        .max(AGENT_COLLABORATION_CONTROL_ACTIONS.length)
        .meta({ uniqueItems: true })
        .readonly(),
      maxDepth: boundedPositiveSafeInteger(AGENT_COLLABORATION_GRAPH_LIMITS.maxDepth),
      maxChildrenPerNode: boundedPositiveSafeInteger(
        AGENT_COLLABORATION_GRAPH_LIMITS.maxChildrenPerNode,
      ),
      maxActiveNodes: boundedPositiveSafeInteger(
        AGENT_COLLABORATION_GRAPH_LIMITS.maxActiveNodes,
      ),
    })
    .strict()
    .readonly(),
]);

const AgentGeneratedResourcesCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z
    .object({
      kind: z.literal('supported'),
      resourceKinds: z
        .array(z.enum(AGENT_GENERATED_RESOURCE_KINDS))
        .min(1)
        .max(AGENT_GENERATED_RESOURCE_KINDS.length)
        .meta({ uniqueItems: true })
        .readonly(),
      maxResourcesPerTurn: boundedPositiveSafeInteger(100),
      maxBytesPerResource: boundedPositiveSafeInteger(1_073_741_824),
    })
    .strict()
    .readonly(),
]);

export const AgentCapabilitiesPortableSchema = z
  .object({
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    providerKey: AgentProviderKeySchema,
    sessions: z
      .object({
        create: z.literal(true),
        resume: z.boolean(),
        branch: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('unsupported') }).strict().readonly(),
          z.object({ kind: z.literal('through_turn') }).strict().readonly(),
        ]),
      })
      .strict()
      .readonly(),
    turns: z
      .object({
        interactionModes: z
          .array(z.enum(AGENT_TURN_INTERACTION_MODES))
          .min(1)
          .max(AGENT_TURN_INTERACTION_MODES.length)
          .meta({ uniqueItems: true })
          .readonly(),
        interrupt: z.boolean(),
        steer: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('unsupported') }).strict().readonly(),
          z
            .object({
              kind: z.literal('supported'),
              input: AgentOperationInputCapabilitySchema,
            })
            .strict()
            .readonly(),
        ]),
      })
      .strict()
      .readonly(),
    requests: z
      .object({
        approval: AgentApprovalCapabilitySchema,
        elicitation: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('unsupported') }).strict().readonly(),
          z
            .object({
              kind: z.literal('supported'),
              fieldKinds: z
                .array(z.enum(AGENT_ELICITATION_FIELD_KINDS))
                .min(1)
                .max(AGENT_ELICITATION_FIELD_KINDS.length)
                .meta({ uniqueItems: true })
                .readonly(),
              maxFields: boundedPositiveSafeInteger(
                AGENT_ELICITATION_FIELDS_MAX_LENGTH,
              ),
              sensitiveFields: z.boolean(),
            })
            .strict()
            .readonly(),
        ]),
      })
      .strict()
      .readonly(),
    context: z
      .object({
        usage: AgentContextUsageCapabilitySchema,
        compaction: AgentContextCompactionCapabilitySchema,
      })
      .strict()
      .readonly(),
    input: AgentOperationInputCapabilitySchema,
    output: z
      .object({
        streaming: z.boolean(),
        plans: z.boolean(),
        fileChanges: z.enum(AGENT_FILE_CHANGE_MODES),
        artifactKinds: z
          .array(z.enum(AGENT_ARTIFACT_KINDS))
          .max(AGENT_ARTIFACT_KINDS.length)
          .meta({ uniqueItems: true })
          .readonly(),
      })
      .strict()
      .readonly(),
    configuration: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('managed') }).strict().readonly(),
      z
        .object({
          kind: z.literal('selectable'),
          fieldKinds: z
            .array(z.enum(AGENT_CONFIGURATION_FIELD_KINDS))
            .min(1)
            .max(AGENT_CONFIGURATION_FIELD_KINDS.length)
            .meta({ uniqueItems: true })
            .readonly(),
          maxFields: boundedPositiveSafeInteger(
            AGENT_CONFIGURATION_FIELDS_MAX_LENGTH,
          ),
        })
        .strict()
        .readonly(),
    ]),
    operations: AgentOperationsCapabilitySchema,
    managedContent: AgentManagedContentCapabilitySchema,
    integrations: AgentIntegrationsCapabilitySchema,
    collaboration: AgentCollaborationCapabilitySchema,
    generatedResources: AgentGeneratedResourcesCapabilitySchema,
    authentication: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('unsupported') }).strict().readonly(),
      z
        .object({
          kind: z.literal('supported'),
          flows: z
            .array(z.enum(AGENT_AUTHENTICATION_FLOWS))
            .min(1)
            .max(AGENT_AUTHENTICATION_FLOWS.length)
            .meta({ uniqueItems: true })
            .readonly(),
        })
        .strict()
        .readonly(),
    ]),
    versionReporting: z.boolean(),
  })
  .strict()
  .readonly();

export const AgentCapabilitiesSchema: z.ZodType<AgentCapabilities> =
  AgentCapabilitiesPortableSchema.superRefine((capabilities, context) => {
    addCanonicalListIssues(
      {
        values: capabilities.turns.interactionModes,
        canonicalOrder: AGENT_TURN_INTERACTION_MODES,
        path: ['turns', 'interactionModes'],
        label: 'Turn interaction modes',
      },
      context,
    );

    if (capabilities.context.usage.kind === 'supported') {
      addCanonicalListIssues(
        {
          values: capabilities.context.usage.measurementScopes,
          canonicalOrder: AGENT_CONTEXT_MEASUREMENT_SCOPES,
          path: ['context', 'usage', 'measurementScopes'],
          label: 'Context measurement scopes',
        },
        context,
      );
      addCanonicalListIssues(
        {
          values: capabilities.context.usage.cumulativeFields,
          canonicalOrder: AGENT_CONTEXT_CUMULATIVE_USAGE_FIELDS,
          path: ['context', 'usage', 'cumulativeFields'],
          label: 'Context cumulative usage fields',
        },
        context,
      );
    }

    if (capabilities.context.compaction.kind === 'supported') {
      addCanonicalListIssues(
        {
          values: capabilities.context.compaction.triggers,
          canonicalOrder: AGENT_CONTEXT_COMPACTION_TRIGGERS,
          path: ['context', 'compaction', 'triggers'],
          label: 'Context compaction triggers',
        },
        context,
      );
    }

    addCanonicalListIssues(
      {
        values: capabilities.output.artifactKinds,
        canonicalOrder: AGENT_ARTIFACT_KINDS,
        path: ['output', 'artifactKinds'],
        label: 'Artifact kinds',
      },
      context,
    );

    if (capabilities.configuration.kind === 'selectable') {
      addCanonicalListIssues(
        {
          values: capabilities.configuration.fieldKinds,
          canonicalOrder: AGENT_CONFIGURATION_FIELD_KINDS,
          path: ['configuration', 'fieldKinds'],
          label: 'Selectable configuration field kinds',
        },
        context,
      );
    }

    if (capabilities.requests.elicitation.kind === 'supported') {
      addCanonicalListIssues(
        {
          values: capabilities.requests.elicitation.fieldKinds,
          canonicalOrder: AGENT_ELICITATION_FIELD_KINDS,
          path: ['requests', 'elicitation', 'fieldKinds'],
          label: 'Elicitation field kinds',
        },
        context,
      );
    }

    if (capabilities.operations.kind === 'supported') {
      for (const [values, canonicalOrder, path, label] of [
        [capabilities.operations.operationKinds, AGENT_OPERATION_KINDS, ['operations', 'operationKinds'], 'Operation kinds'],
        [capabilities.operations.fieldKinds, AGENT_OPERATION_FIELD_KINDS, ['operations', 'fieldKinds'], 'Operation field kinds'],
        [capabilities.operations.executionModes, AGENT_OPERATION_EXECUTION_MODES, ['operations', 'executionModes'], 'Operation execution modes'],
      ] as const) {
        addCanonicalListIssues({ values, canonicalOrder, path, label }, context);
      }
    }

    if (capabilities.managedContent.kind === 'supported') {
      addCanonicalListIssues(
        {
          values: capabilities.managedContent.contentKinds,
          canonicalOrder: AGENT_MANAGED_CONTENT_KINDS,
          path: ['managedContent', 'contentKinds'],
          label: 'Managed content kinds',
        },
        context,
      );
    }

    if (capabilities.integrations.kind === 'supported') {
      addCanonicalListIssues(
        {
          values: capabilities.integrations.integrationKinds,
          canonicalOrder: AGENT_INTEGRATION_KINDS,
          path: ['integrations', 'integrationKinds'],
          label: 'Integration kinds',
        },
        context,
      );
    }

    if (capabilities.collaboration.kind === 'supported') {
      addCanonicalListIssues(
        {
          values: capabilities.collaboration.roles,
          canonicalOrder: AGENT_COLLABORATION_ROLES,
          path: ['collaboration', 'roles'],
          label: 'Collaboration roles',
        },
        context,
      );
      addCanonicalListIssues(
        {
          values: capabilities.collaboration.controlActions,
          canonicalOrder: AGENT_COLLABORATION_CONTROL_ACTIONS,
          path: ['collaboration', 'controlActions'],
          label: 'Collaboration control actions',
        },
        context,
      );
    }

    if (capabilities.generatedResources.kind === 'supported') {
      addCanonicalListIssues(
        {
          values: capabilities.generatedResources.resourceKinds,
          canonicalOrder: AGENT_GENERATED_RESOURCE_KINDS,
          path: ['generatedResources', 'resourceKinds'],
          label: 'Generated resource kinds',
        },
        context,
      );
    }

    if (capabilities.authentication.kind === 'supported') {
      addCanonicalListIssues(
        {
          values: capabilities.authentication.flows,
          canonicalOrder: AGENT_AUTHENTICATION_FLOWS,
          path: ['authentication', 'flows'],
          label: 'Authentication flows',
        },
        context,
      );
    }
  });
