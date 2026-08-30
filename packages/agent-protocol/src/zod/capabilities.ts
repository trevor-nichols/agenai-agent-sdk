// ------------------------------------------------------------------------------------------------
//                capabilities.ts - Technical capability schema - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  AGENT_PROTOCOL_VERSION,
} from '../foundation/types.js';
import { AGENT_ARTIFACT_KINDS } from '../artifacts/types.js';
import {
  AGENT_AUTHENTICATION_FLOWS,
  AGENT_FILE_CHANGE_MODES,
  type AgentCapabilities,
} from '../capabilities/types.js';
import {
  AGENT_APPROVAL_PERSISTENCES,
  AGENT_APPROVAL_SCOPE_KINDS,
} from '../requests/types.js';
import {
  AGENT_CONTEXT_COMPACTION_TRIGGERS,
  AGENT_CONTEXT_CUMULATIVE_USAGE_FIELDS,
  AGENT_CONTEXT_MEASUREMENT_SCOPES,
  AGENT_IMAGE_INPUT_MEDIA_TYPES,
  AGENT_IMAGE_INPUT_SOURCE_KINDS,
  AGENT_TURN_INTERACTION_MODES,
} from '../turns/types.js';
import { AgentProviderKeySchema } from './foundation.js';

const AgentCapabilityIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9._:-]*$/u);

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
          z.object({ kind: z.literal('text') }).strict().readonly(),
          z.object({ kind: z.literal('structured') }).strict().readonly(),
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
          fields: z
            .array(
              z
                .object({
                  key: AgentCapabilityIdentifierSchema,
                  optionIds: z
                    .array(AgentCapabilityIdentifierSchema)
                    .min(1)
                    .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
                    .meta({ uniqueItems: true })
                    .readonly(),
                })
                .strict()
                .readonly(),
            )
            .min(1)
            .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
            .readonly(),
        })
        .strict()
        .readonly(),
    ]),
    interactionExtensions: z
      .object({
        slashCommands: z.boolean(),
        mcp: z.boolean(),
        subagents: z.boolean(),
        imageGeneration: z.boolean(),
      })
      .strict()
      .readonly(),
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

    if (capabilities.requests.approval.kind === 'supported') {
      addCanonicalListIssues(
        {
          values: capabilities.requests.approval.modes.map(
            (mode) => mode.persistence,
          ),
          canonicalOrder: AGENT_APPROVAL_PERSISTENCES,
          path: ['requests', 'approval', 'modes'],
          label: 'Approval persistence modes',
        },
        context,
      );
      capabilities.requests.approval.modes.forEach((mode, index) => {
        addCanonicalListIssues(
          {
            values: mode.scopeKinds,
            canonicalOrder: AGENT_APPROVAL_SCOPE_KINDS,
            path: ['requests', 'approval', 'modes', index, 'scopeKinds'],
            label: 'Approval scope kinds',
          },
          context,
        );
      });
    }

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
      const keys = capabilities.configuration.fields.map((field) => field.key);
      addCanonicalListIssues(
        {
          values: keys,
          path: ['configuration', 'fields'],
          label: 'Selectable configuration fields',
        },
        context,
      );
      capabilities.configuration.fields.forEach((field, index) => {
        addCanonicalListIssues(
          {
            values: field.optionIds,
            path: ['configuration', 'fields', index, 'optionIds'],
            label: 'Selectable configuration option IDs',
          },
          context,
        );
      });
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
