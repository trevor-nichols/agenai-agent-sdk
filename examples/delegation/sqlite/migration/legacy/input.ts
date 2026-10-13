// Frozen input-schema closure from 21e972faae5f16038e64d423c840def150dfdebb. No current protocol parsers.
import { z } from 'zod/v4';
const AGENT_PROTOCOL_TEXT_MAX_LENGTH = 4_000;
const AGENT_PROTOCOL_SUMMARY_MAX_LENGTH = 2_000;
const AGENT_PROTOCOL_COLLECTION_MAX_LENGTH = 100;
const AGENT_PROTOCOL_TURN_INPUT_CONTENT_BYTES_LIMIT = 1_064_960;
const AGENT_CONTENT_REFERENCES_MAX_LENGTH = 16;
const AGENT_CONTENT_REFERENCE_ARGUMENT_BYTES_LIMIT = 4_096;
const AGENT_IMAGE_INPUT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const AgentEnvironmentIdSchema = z.string().min(1).max(256).regex(/^(?![\s\S]*[\u0000-\u001F\u007F-\u009F])\S(?:[\s\S]*\S)?$/u);
const AgentEffectiveContentIdSchema = AgentEnvironmentIdSchema;
const agentProtocolSerializedJsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
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

const ContentReferenceRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const AgentContentReferenceInputPartSchema = z.object({
  type: z.literal('content_reference'),
  environmentId: AgentEnvironmentIdSchema,
  environmentRevision: ContentReferenceRevisionSchema,
  contentCatalogRevision: ContentReferenceRevisionSchema,
  contentId: AgentEffectiveContentIdSchema,
  contentRevision: ContentReferenceRevisionSchema,
  arguments: z.string().max(AGENT_CONTENT_REFERENCE_ARGUMENT_BYTES_LIMIT).optional(),
}).strict().superRefine((part, context) => {
  if (part.arguments !== undefined && new TextEncoder().encode(part.arguments).byteLength > AGENT_CONTENT_REFERENCE_ARGUMENT_BYTES_LIMIT) {
    context.addIssue({ code: 'custom', path: ['arguments'], message: 'Content reference arguments exceed their UTF-8 byte limit.' });
  }
}).readonly();

export const AgentTurnInputPartSchema = z.discriminatedUnion('type', [
  AgentTextInputPartSchema,
  AgentImageInputPartSchema,
  AgentContentReferenceInputPartSchema,
]);



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
    const references = input.parts.filter((part) => part.type === 'content_reference');
    if (references.length > AGENT_CONTENT_REFERENCES_MAX_LENGTH) {
      context.addIssue({ code: 'custom', path: ['parts'], message: 'Too many content references.' });
    }
    const identities = new Set<string>();
    input.parts.forEach((part, index) => {
      if (part.type !== 'content_reference') return;
      const identity = JSON.stringify([part.environmentId, part.contentId]);
      if (identities.has(identity)) {
        context.addIssue({ code: 'custom', path: ['parts', index], message: 'Content references must be unique.' });
      }
      identities.add(identity);
    });
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

export const AgentTurnInputContentSchema =
  AgentTurnInputContentRefinedSchema;
