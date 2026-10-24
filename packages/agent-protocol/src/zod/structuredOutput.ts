import { z } from 'zod/v4';

import type { AgentJsonObject, AgentJsonValue, ValidationIssue } from '../foundation/types.js';
import {
  AGENT_OUTPUT_SCHEMA_BYTES_LIMIT,
  AGENT_OUTPUT_SCHEMA_DEPTH_LIMIT,
  AGENT_OUTPUT_SCHEMA_DESCRIPTION_MAX_LENGTH,
  AGENT_OUTPUT_SCHEMA_DIALECT,
  AGENT_OUTPUT_SCHEMA_ENUM_VALUES_LIMIT,
  AGENT_OUTPUT_SCHEMA_LENGTH_BOUND_LIMIT,
  AGENT_OUTPUT_SCHEMA_PROFILE,
  AGENT_OUTPUT_SCHEMA_PROPERTIES_LIMIT,
  AGENT_OUTPUT_SCHEMA_PROPERTY_NAME_MAX_LENGTH,
  AGENT_OUTPUT_VALUE_BYTES_LIMIT,
  AGENT_OUTPUT_VALUE_COLLECTION_LIMIT,
  AGENT_OUTPUT_VALUE_DEPTH_LIMIT,
  AGENT_OUTPUT_VALUE_NODES_LIMIT,
  AGENT_STRUCTURED_OUTPUT_ISSUE_CODE_MAX_LENGTH,
  AGENT_STRUCTURED_OUTPUT_ISSUE_MESSAGE_MAX_LENGTH,
  AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_BYTES_LIMIT,
  AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_SEGMENTS_LIMIT,
  AGENT_STRUCTURED_OUTPUT_ISSUES_BYTES_LIMIT,
  AGENT_STRUCTURED_OUTPUT_ISSUES_LIMIT,
} from '../structuredOutput/constants.js';
import { snapshotStructuredOutputJson, type StructuredOutputJsonBounds } from '../structuredOutput/boundedJson.js';
import { safeParseAgentOutputSchema } from '../structuredOutput/parsers.js';
import type {
  AgentOutputNonNullSchema,
  AgentOutputNullSchema,
  AgentOutputSchema,
  AgentOutputSchemaNode,
  AgentStructuredOutputCapability,
  AgentStructuredOutputNonJsonResult,
  AgentStructuredOutputRequest,
  AgentStructuredOutputResult,
} from '../structuredOutput/types.js';

const encoder = new TextEncoder();
const PropertyNameSchema = z.string().regex(new RegExp(`^(?!(?:__proto__|prototype|constructor)(?![\\s\\S]))[\\s\\S]{1,${AGENT_OUTPUT_SCHEMA_PROPERTY_NAME_MAX_LENGTH}}(?![\\s\\S])`, 'u'));
const DescriptionSchema = z.string().regex(new RegExp(`^[\\s\\S]{0,${AGENT_OUTPUT_SCHEMA_DESCRIPTION_MAX_LENGTH}}(?![\\s\\S])`, 'u'));
const LengthBoundSchema = z.number().int().min(0).max(AGENT_OUTPUT_SCHEMA_LENGTH_BOUND_LIMIT);
const objectShape = {
  type: z.literal('object'),
  properties: z.record(PropertyNameSchema, z.lazy(() => AgentOutputSchemaNodePortableSchema)).readonly(),
  required: z.array(PropertyNameSchema).max(AGENT_OUTPUT_SCHEMA_PROPERTIES_LIMIT).readonly(),
  additionalProperties: z.literal(false),
  description: DescriptionSchema.optional(),
};

const NullNodeSchema: z.ZodType<AgentOutputNullSchema> = z.object({
  type: z.literal('null'), description: DescriptionSchema.optional(),
}).strict().readonly();

const NonNullNodeSchema: z.ZodType<AgentOutputNonNullSchema> = z.lazy(() => z.union([
  z.object(objectShape).strict().readonly(),
  z.object({
    type: z.literal('array'),
    items: AgentOutputSchemaNodePortableSchema,
    minItems: LengthBoundSchema.optional(),
    maxItems: LengthBoundSchema.optional(),
    description: DescriptionSchema.optional(),
  }).strict().readonly(),
  z.object({
    type: z.literal('string'),
    enum: z.tuple([z.string()], z.string()).check(z.maxLength(AGENT_OUTPUT_SCHEMA_ENUM_VALUES_LIMIT)).readonly().optional(),
    minLength: LengthBoundSchema.optional(),
    maxLength: LengthBoundSchema.optional(),
    description: DescriptionSchema.optional(),
  }).strict().readonly(),
  z.object({
    type: z.enum(['integer', 'number']),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    description: DescriptionSchema.optional(),
  }).strict().readonly(),
  z.object({ type: z.literal('boolean'), description: DescriptionSchema.optional() }).strict().readonly(),
]));

const NullableNodeSchema = z.union([
  z.object({
    anyOf: z.tuple([NonNullNodeSchema, NullNodeSchema]).readonly(),
    description: DescriptionSchema.optional(),
  }).strict().readonly(),
  z.object({
    anyOf: z.tuple([NullNodeSchema, NonNullNodeSchema]).readonly(),
    description: DescriptionSchema.optional(),
  }).strict().transform((value) => Object.freeze({
    anyOf: Object.freeze([value.anyOf[1], value.anyOf[0]] as const),
    ...(value.description === undefined ? {} : { description: value.description }),
  })),
]);

export const AgentOutputSchemaNodePortableSchema: z.ZodType<AgentOutputSchemaNode> = z.lazy(() => z.union([
  NonNullNodeSchema, NullNodeSchema, NullableNodeSchema,
]));

// Input direction includes either nullable branch ordering; successful full parses canonicalize it.
export const AgentOutputSchemaPortableSchema: z.ZodType<AgentOutputSchema> = z.object({
  ...objectShape,
  $schema: z.literal(AGENT_OUTPUT_SCHEMA_DIALECT).optional(),
}).strict().readonly();

export const AgentOutputSchemaSchema: z.ZodType<AgentOutputSchema> = z.preprocess((input, context) => {
  const parsed = safeParseAgentOutputSchema(input);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.issues) context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  return z.NEVER;
}, AgentOutputSchemaPortableSchema);

export const AgentStructuredOutputCapabilityPortableSchema: z.ZodType<AgentStructuredOutputCapability> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }).strict().readonly(),
  z.object({
    kind: z.literal('supported'),
    mechanism: z.literal('native'),
    schemaProfile: z.literal(AGENT_OUTPUT_SCHEMA_PROFILE),
    scope: z.enum(['turn', 'session']),
    maxSchemaBytes: z.number().int().positive().max(AGENT_OUTPUT_SCHEMA_BYTES_LIMIT),
    maxOutputBytes: z.number().int().positive().max(AGENT_OUTPUT_VALUE_BYTES_LIMIT),
    resume: z.literal(false),
    branch: z.literal(false),
  }).strict().readonly(),
]);

function boundedJsonSchema<Output>(schema: z.ZodType<Output>, bounds: StructuredOutputJsonBounds): z.ZodType<Output> {
  return z.preprocess((input, context) => {
    const parsed = snapshotStructuredOutputJson(input, bounds);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.issues) context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
    return z.NEVER;
  }, schema);
}

export const AgentStructuredOutputCapabilitySchema = boundedJsonSchema(AgentStructuredOutputCapabilityPortableSchema, {
  maxBytes: 1_024, maxDepth: 2, maxNodes: 16, maxCollectionLength: 16,
});

export const AgentStructuredOutputRequestPortableSchema: z.ZodType<AgentStructuredOutputRequest> = z.object({
  kind: z.literal('json_schema'), schema: AgentOutputSchemaPortableSchema,
}).strict().readonly();

export const AgentStructuredOutputRequestSchema: z.ZodType<AgentStructuredOutputRequest> = boundedJsonSchema(z.object({
  kind: z.literal('json_schema'), schema: AgentOutputSchemaSchema,
}).strict().readonly(), {
  maxBytes: AGENT_OUTPUT_SCHEMA_BYTES_LIMIT + 128,
  maxDepth: 3 * AGENT_OUTPUT_SCHEMA_DEPTH_LIMIT + 3,
  maxNodes: AGENT_OUTPUT_SCHEMA_BYTES_LIMIT + 4,
  maxCollectionLength: AGENT_OUTPUT_SCHEMA_PROPERTIES_LIMIT,
});

const JsonValuePortableSchema: z.ZodType<AgentJsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JsonValuePortableSchema).max(AGENT_OUTPUT_VALUE_COLLECTION_LIMIT).readonly(),
  z.record(PropertyNameSchema, JsonValuePortableSchema).readonly(),
]));
const JsonObjectPortableSchema: z.ZodType<AgentJsonObject> = z.record(PropertyNameSchema, JsonValuePortableSchema).readonly();
const IssuePortableSchema: z.ZodType<ValidationIssue> = z.object({
  code: z.string().regex(new RegExp(`^[\\s\\S]{0,${AGENT_STRUCTURED_OUTPUT_ISSUE_CODE_MAX_LENGTH}}(?![\\s\\S])`, 'u')),
  message: z.string().regex(new RegExp(`^[\\s\\S]{0,${AGENT_STRUCTURED_OUTPUT_ISSUE_MESSAGE_MAX_LENGTH}}(?![\\s\\S])`, 'u')),
  path: z.array(z.union([z.string(), z.number().finite()])).max(AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_SEGMENTS_LIMIT).readonly(),
}).strict().readonly();
const NotRequestedSchema = z.object({ kind: z.literal('not_requested') }).strict().readonly();
const SchemaMismatchSchema = z.object({
  kind: z.literal('unavailable'), reason: z.literal('schema_mismatch'),
  issues: z.array(IssuePortableSchema).max(AGENT_STRUCTURED_OUTPUT_ISSUES_LIMIT).readonly().optional(),
}).strict().readonly();
const UnavailableSchema = z.object({
  kind: z.literal('unavailable'),
  reason: z.enum(['refused', 'incomplete', 'missing_output', 'invalid_json', 'output_limit_exceeded', 'native_retries_exhausted', 'provider_error']),
}).strict().readonly();

export const AgentStructuredOutputNonJsonResultPortableSchema: z.ZodType<AgentStructuredOutputNonJsonResult> = z.union([
  NotRequestedSchema, SchemaMismatchSchema, UnavailableSchema,
]);
export const AgentStructuredOutputResultPortableSchema: z.ZodType<AgentStructuredOutputResult> = z.union([
  AgentStructuredOutputNonJsonResultPortableSchema,
  z.object({ kind: z.literal('json'), value: JsonObjectPortableSchema }).strict().readonly(),
]);

const resultBounds = {
  maxBytes: AGENT_OUTPUT_VALUE_BYTES_LIMIT + AGENT_STRUCTURED_OUTPUT_ISSUES_BYTES_LIMIT + 1_024,
  maxDepth: AGENT_OUTPUT_VALUE_DEPTH_LIMIT + 1,
  maxNodes: AGENT_OUTPUT_VALUE_NODES_LIMIT + 128,
  maxCollectionLength: AGENT_OUTPUT_VALUE_COLLECTION_LIMIT,
};

function refineResult(result: AgentStructuredOutputResult, context: z.RefinementCtx): void {
  if (result.kind === 'json') {
    const parsed = snapshotStructuredOutputJson(result.value, {
      maxBytes: AGENT_OUTPUT_VALUE_BYTES_LIMIT,
      maxDepth: AGENT_OUTPUT_VALUE_DEPTH_LIMIT,
      maxNodes: AGENT_OUTPUT_VALUE_NODES_LIMIT,
      maxCollectionLength: AGENT_OUTPUT_VALUE_COLLECTION_LIMIT,
    });
    if (!parsed.success) {
      for (const issue of parsed.issues) context.addIssue({ code: 'custom', path: ['value', ...issue.path], message: issue.message });
    }
  } else if (result.kind === 'unavailable' && result.reason === 'schema_mismatch' && result.issues) {
    if (encoder.encode(JSON.stringify(result.issues)).byteLength > AGENT_STRUCTURED_OUTPUT_ISSUES_BYTES_LIMIT) context.addIssue({ code: 'custom', path: ['issues'], message: 'Structured validation issues exceed their aggregate byte limit.' });
    for (const [index, issue] of result.issues.entries()) {
      if (encoder.encode(JSON.stringify(issue.path)).byteLength > AGENT_STRUCTURED_OUTPUT_ISSUE_PATH_BYTES_LIMIT) context.addIssue({ code: 'custom', path: ['issues', index, 'path'], message: 'Structured validation issue path exceeds its serialized byte limit.' });
    }
  }
}

export const AgentStructuredOutputNonJsonResultSchema: z.ZodType<AgentStructuredOutputNonJsonResult> = boundedJsonSchema(
  AgentStructuredOutputNonJsonResultPortableSchema, resultBounds,
).superRefine(refineResult);
export const AgentStructuredOutputResultSchema: z.ZodType<AgentStructuredOutputResult> = boundedJsonSchema(
  AgentStructuredOutputResultPortableSchema, resultBounds,
).superRefine(refineResult);
