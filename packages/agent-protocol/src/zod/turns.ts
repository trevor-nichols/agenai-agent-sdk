// ------------------------------------------------------------------------------------------------
//                turns.ts - Turn and item schemas - Dependencies: foundation schemas, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  AGENT_PROTOCOL_SUMMARY_MAX_LENGTH,
  AGENT_PROTOCOL_TEXT_MAX_LENGTH,
  AGENT_PROTOCOL_TURN_INPUT_CONTENT_BYTES_LIMIT,
  agentProtocolSerializedJsonBytes,
} from '../foundation/types.js';
import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_CONTENT_STREAM_KINDS,
  AGENT_FILE_CHANGE_KINDS,
  AGENT_IMAGE_INPUT_MEDIA_TYPES,
  AGENT_ITEM_KINDS,
  AGENT_ITEM_STATUSES,
  AGENT_TURN_INTERACTION_MODES,
  type AgentBrowserActionDetails,
  type AgentCollaborationToolCallDetails,
  type AgentCommandExecutionDetails,
  type AgentComputerActionDetails,
  type AgentDiffSummary,
  type AgentDynamicToolCallDetails,
  type AgentFileChange,
  type AgentFileChangeDetails,
  type AgentImageViewDetails,
  type AgentItemSnapshot,
  type AgentMcpToolCallDetails,
  type AgentPlanStep,
  type AgentReviewDetails,
  type AgentTurnCompletedPayload,
  type AgentTurnInputContent,
  type AgentTurnInterruptionInput,
  type AgentTurnRunInput,
  type AgentWebSearchDetails,
} from '../turns/types.js';
import {
  AgentCanonicalIdValueSchema,
  AgentErrorSchema,
  AgentIsoDateTimeSchema,
  AgentItemIdSchema,
  AgentTurnIdSchema,
  createAgentCanonicalNonBlankStringSchema,
} from './foundation.js';

export const AGENT_PROTOCOL_INLINE_IMAGE_BASE64_MAX_LENGTH = 500_000;

const AGENT_PROTOCOL_IMAGE_BYTE_SIZE_MAX = 100 * 1024 * 1024;
const AGENT_PROTOCOL_IMAGE_DIMENSION_MAX = 100_000;

const AgentImageMediaTypeSchema = z.enum(AGENT_IMAGE_INPUT_MEDIA_TYPES);
const AgentImageByteSizeSchema = z
  .number()
  .int()
  .positive()
  .max(AGENT_PROTOCOL_IMAGE_BYTE_SIZE_MAX);
const AgentImageDimensionSchema = z
  .number()
  .int()
  .positive()
  .max(AGENT_PROTOCOL_IMAGE_DIMENSION_MAX);
const AgentImageSourceMetadataShape = {
  mediaType: AgentImageMediaTypeSchema,
  byteSize: AgentImageByteSizeSchema,
  widthPixels: AgentImageDimensionSchema,
  heightPixels: AgentImageDimensionSchema,
} as const;

// ------------------------------------------------------------------------------------------------
//                Turn Input Schemas
// ------------------------------------------------------------------------------------------------

const AgentTextInputPartSchema = z
  .object({
    type: z.literal('text'),
    text: z
      .string()
      .min(1)
      .max(AGENT_PROTOCOL_TEXT_MAX_LENGTH * 16),
  })
  .strict()
  .readonly();

export const AgentImageInputSourceSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('url'),
      url: z.string().url().max(2_048),
      ...AgentImageSourceMetadataShape,
    })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal('base64'),
      ...AgentImageSourceMetadataShape,
      data: z
        .base64()
        .min(1)
        .max(AGENT_PROTOCOL_INLINE_IMAGE_BASE64_MAX_LENGTH),
    })
    .strict()
    .superRefine((source, context) => {
      const padding = source.data.endsWith('==')
        ? 2
        : source.data.endsWith('=')
          ? 1
          : 0;
      const decodedByteSize = (source.data.length / 4) * 3 - padding;
      if (decodedByteSize !== source.byteSize) {
        context.addIssue({
          code: 'custom',
          path: ['byteSize'],
          message: 'Inline image byteSize must match the decoded base64 data.',
        });
      }
    })
    .readonly(),
  z
    .object({
      type: z.literal('local_file'),
      path: z
        .string()
        .min(2)
        .max(4_096)
        .regex(
          /^(?!.*\/\.\.(?:\/|$))\/(?![\s\S]*[\u0000-\u001F\u007F-\u009F])\S(?:[\s\S]*\S)?$/u,
          'Local image paths must be absolute, traversal-free POSIX paths without control characters.',
        ),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      ...AgentImageSourceMetadataShape,
    })
    .strict()
    .readonly(),
]);

const AgentImageInputPartSchema = z
  .object({
    type: z.literal('image'),
    source: AgentImageInputSourceSchema,
  })
  .strict()
  .readonly();

export const AgentTurnInputPartSchema = z.discriminatedUnion('type', [
  AgentTextInputPartSchema,
  AgentImageInputPartSchema,
]);

export const AgentTurnInteractionModeSchema = z.enum(
  AGENT_TURN_INTERACTION_MODES,
);

const AgentTurnInputContentShape = {
  parts: z
    .array(AgentTurnInputPartSchema)
    .min(1)
    .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
    .readonly(),
  summary: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
} as const;

const AgentTurnInputContentObjectSchema = z
  .object(AgentTurnInputContentShape)
  .strict();

const AgentTurnInputContentRefinedSchema =
  AgentTurnInputContentObjectSchema.superRefine((input, context) => {
    const content = {
      parts: input.parts,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    };
    if (
      agentProtocolSerializedJsonBytes(content) <=
      AGENT_PROTOCOL_TURN_INPUT_CONTENT_BYTES_LIMIT
    ) {
      return;
    }
    context.addIssue({
      code: 'custom',
      message: `Turn input content cannot exceed ${AGENT_PROTOCOL_TURN_INPUT_CONTENT_BYTES_LIMIT} serialized bytes.`,
    });
  });

/**
 * Explicit Zod composition surface for private protocols that must add
 * transport-owned fields while retaining the canonical input refinements.
 */
export const AgentTurnInputContentCompositionSchema =
  AgentTurnInputContentRefinedSchema;

export const AgentTurnInputContentSchema: z.ZodType<AgentTurnInputContent> =
  AgentTurnInputContentRefinedSchema;

export const AgentTurnRunInputPortableSchema = z
  .object({
    turnId: AgentTurnIdSchema,
    interactionMode: AgentTurnInteractionModeSchema,
    ...AgentTurnInputContentShape,
    deadlineAt: AgentIsoDateTimeSchema.optional(),
  })
  .strict()
  .readonly();

export const AgentTurnRunInputSchema: z.ZodType<AgentTurnRunInput> =
  AgentTurnInputContentRefinedSchema.safeExtend({
    turnId: AgentTurnIdSchema,
    interactionMode: AgentTurnInteractionModeSchema,
    deadlineAt: AgentIsoDateTimeSchema.optional(),
  })
    .strict()
    .readonly();

export const AgentTurnInterruptionInputSchema: z.ZodType<AgentTurnInterruptionInput> =
  z
    .object({
      turnId: AgentTurnIdSchema,
      reason: z.enum([
        'user_requested',
        'timeout',
        'shutdown',
        'superseded',
        'other',
      ]),
      requestedAt: AgentIsoDateTimeSchema.optional(),
    })
    .strict()
    .readonly();

// ------------------------------------------------------------------------------------------------
//                Observation Primitive Schemas
// ------------------------------------------------------------------------------------------------

const DisplayPathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(
    /^(?![\\/]|[A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))(?![\s\S]*[\u0000-\u001F\u007F-\u009F])\S(?:[\s\S]*\S)?$/u,
    'Display paths must be canonical, relative, traversal-free, and contain no control characters.',
  );

const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const DetailSummarySchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_PROTOCOL_SUMMARY_MAX_LENGTH,
);
const DetailNameSchema = createAgentCanonicalNonBlankStringSchema(160);
const ReviewTextSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_PROTOCOL_TEXT_MAX_LENGTH,
);
const TruncatedShape = { truncated: z.literal(true).optional() } as const;

export const AgentCommandExecutionDetailsSchema: z.ZodType<AgentCommandExecutionDetails> =
  z
    .object({
      commandSummary: DetailSummarySchema.optional(),
      workingPath: DisplayPathSchema.optional(),
      exitCode: SafeIntegerSchema.optional(),
      durationMs: NonNegativeSafeIntegerSchema.optional(),
      ...TruncatedShape,
    })
    .strict()
    .superRefine((details, context) => {
      if (
        details.commandSummary === undefined &&
        details.workingPath === undefined &&
        details.exitCode === undefined &&
        details.durationMs === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Command details require a command summary, working path, exit code, or duration.',
        });
      }
    })
    .readonly();

export const AgentFileChangeSchema: z.ZodType<AgentFileChange> = z
  .object({
    path: DisplayPathSchema,
    changeKind: z.enum(AGENT_FILE_CHANGE_KINDS),
  })
  .strict()
  .readonly();

export const AgentFileChangeDetailsSchema: z.ZodType<AgentFileChangeDetails> = z
  .object({
    changes: z
      .array(AgentFileChangeSchema)
      .min(1)
      .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
      .readonly(),
    ...TruncatedShape,
  })
  .strict()
  .superRefine((details, context) => {
    const seenPaths = new Set<string>();
    for (const [index, change] of details.changes.entries()) {
      if (seenPaths.has(change.path)) {
        context.addIssue({
          code: 'custom',
          path: ['changes', index, 'path'],
          message: 'File change paths must be unique.',
        });
      }
      seenPaths.add(change.path);

      const previous = details.changes[index - 1];
      if (
        previous
        && compareStringsByUnicodeCodePoint(previous.path, change.path) >= 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['changes', index, 'path'],
          message:
            'File changes must be sorted in ascending code-point order by path.',
        });
      }
    }
  })
  .readonly();

export const AgentMcpToolCallDetailsSchema: z.ZodType<AgentMcpToolCallDetails> =
  z
    .object({
      serverName: DetailNameSchema.optional(),
      toolName: DetailNameSchema.optional(),
      actionSummary: DetailSummarySchema.optional(),
      durationMs: NonNegativeSafeIntegerSchema.optional(),
      ...TruncatedShape,
    })
    .strict()
    .superRefine((details, context) => {
      if (
        details.serverName === undefined &&
        details.toolName === undefined &&
        details.actionSummary === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'MCP tool details require a server name, tool name, or action summary.',
        });
      }
    })
    .readonly();

export const AgentDynamicToolCallDetailsSchema: z.ZodType<AgentDynamicToolCallDetails> =
  z
    .object({
      toolName: DetailNameSchema.optional(),
      actionSummary: DetailSummarySchema.optional(),
      durationMs: NonNegativeSafeIntegerSchema.optional(),
      success: z.boolean().optional(),
      ...TruncatedShape,
    })
    .strict()
    .superRefine((details, context) => {
      if (
        details.toolName === undefined &&
        details.actionSummary === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Dynamic tool details require a tool name or action summary.',
        });
      }
    })
    .readonly();

export const AgentCollaborationToolCallDetailsSchema: z.ZodType<AgentCollaborationToolCallDetails> =
  z
    .object({
      toolName: DetailNameSchema.optional(),
      actionSummary: DetailSummarySchema.optional(),
      ...TruncatedShape,
    })
    .strict()
    .superRefine((details, context) => {
      if (
        details.toolName === undefined &&
        details.actionSummary === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Collaboration tool details require a tool name or action summary.',
        });
      }
    })
    .readonly();

export const AgentWebSearchDetailsSchema: z.ZodType<AgentWebSearchDetails> = z
  .object({
    querySummary: DetailSummarySchema.optional(),
    actionSummary: DetailSummarySchema.optional(),
    ...TruncatedShape,
  })
  .strict()
  .superRefine((details, context) => {
    if (
      details.querySummary === undefined &&
      details.actionSummary === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Web search details require a query or action summary.',
      });
    }
  })
  .readonly();

export const AgentBrowserActionDetailsSchema: z.ZodType<AgentBrowserActionDetails> =
  z
    .object({
      actionSummary: DetailSummarySchema,
      ...TruncatedShape,
    })
    .strict()
    .readonly();

export const AgentComputerActionDetailsSchema: z.ZodType<AgentComputerActionDetails> =
  z
    .object({
      actionSummary: DetailSummarySchema,
      ...TruncatedShape,
    })
    .strict()
    .readonly();

export const AgentImageViewDetailsSchema: z.ZodType<AgentImageViewDetails> = z
  .object({
    filePath: DisplayPathSchema.optional(),
    actionSummary: DetailSummarySchema.optional(),
    ...TruncatedShape,
  })
  .strict()
  .superRefine((details, context) => {
    if (details.filePath === undefined && details.actionSummary === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Image view details require a file path or action summary.',
      });
    }
  })
  .readonly();

export const AgentReviewDetailsSchema: z.ZodType<AgentReviewDetails> =
  z.discriminatedUnion('phase', [
    z
      .object({
        phase: z.literal('entered'),
        target: ReviewTextSchema,
        ...TruncatedShape,
      })
      .strict()
      .readonly(),
    z
      .object({
        phase: z.literal('exited'),
        report: ReviewTextSchema,
        ...TruncatedShape,
      })
      .strict()
      .readonly(),
  ]);

const AgentItemSnapshotCommonShape = {
  itemId: AgentItemIdSchema,
  status: z.enum(AGENT_ITEM_STATUSES),
  title: z.string().max(200).optional(),
  summary: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
} as const;

function itemWithoutDetails<Kind extends (typeof AGENT_ITEM_KINDS)[number]>(
  itemKind: Kind,
) {
  return z
    .object({
      ...AgentItemSnapshotCommonShape,
      itemKind: z.literal(itemKind),
    })
    .strict()
    .readonly();
}

export const AgentItemSnapshotSchema: z.ZodType<AgentItemSnapshot> =
  z.discriminatedUnion('itemKind', [
    itemWithoutDetails('user_message'),
    itemWithoutDetails('assistant_message'),
    itemWithoutDetails('reasoning'),
    itemWithoutDetails('plan'),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('command_execution'),
        details: AgentCommandExecutionDetailsSchema.optional(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('file_change'),
        details: AgentFileChangeDetailsSchema.optional(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('mcp_tool_call'),
        details: AgentMcpToolCallDetailsSchema.optional(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('dynamic_tool_call'),
        details: AgentDynamicToolCallDetailsSchema.optional(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('collaboration_tool_call'),
        details: AgentCollaborationToolCallDetailsSchema.optional(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('web_search'),
        details: AgentWebSearchDetailsSchema.optional(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('browser_action'),
        details: AgentBrowserActionDetailsSchema.optional(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('computer_action'),
        details: AgentComputerActionDetailsSchema.optional(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('image_view'),
        details: AgentImageViewDetailsSchema.optional(),
      })
      .strict()
      .readonly(),
    z
      .object({
        ...AgentItemSnapshotCommonShape,
        itemKind: z.literal('review'),
        details: AgentReviewDetailsSchema,
      })
      .strict()
      .readonly(),
    itemWithoutDetails('context_compaction'),
    itemWithoutDetails('unknown'),
  ]);

export const AgentContentStreamKindSchema = z.enum(AGENT_CONTENT_STREAM_KINDS);

export const AgentPlanStepSchema: z.ZodType<AgentPlanStep> = z
  .object({
    stepId: AgentCanonicalIdValueSchema,
    text: z.string().max(AGENT_PROTOCOL_TEXT_MAX_LENGTH),
    status: z.enum(['pending', 'in_progress', 'completed', 'canceled']),
    priority: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict()
  .readonly();

export const AgentDiffSummarySchema: z.ZodType<AgentDiffSummary> = z
  .object({
    summary: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH),
    fileCount: z.number().int().min(0),
    byteSize: z.number().int().min(0),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    binary: z.boolean().optional(),
    malformed: z.boolean().optional(),
    truncated: z.boolean().optional(),
  })
  .strict()
  .readonly();

export const AgentTurnCompletedPayloadPortableSchema = z
  .object({
    outcome: z.enum(['completed', 'failed', 'canceled', 'expired']),
    reason: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
    error: AgentErrorSchema.optional(),
  })
  .strict()
  .readonly();

export const AgentTurnCompletedPayloadSchema: z.ZodType<AgentTurnCompletedPayload> =
  AgentTurnCompletedPayloadPortableSchema.superRefine((payload, context) => {
    if (payload.outcome === 'failed' && payload.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Failed turns require an error.',
      });
    }
    if (payload.outcome !== 'failed' && payload.error !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Only failed turns may contain an error.',
      });
    }
  });
