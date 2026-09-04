// ------------------------------------------------------------------------------------------------
//                operations.ts - Typed operation schemas - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_OPERATION_CATALOG_MAX_LENGTH,
  AGENT_OPERATION_CONTEXTS,
  AGENT_OPERATION_DESCRIPTION_MAX_LENGTH,
  AGENT_OPERATION_EXECUTION_MODES,
  AGENT_OPERATION_FIELDS_MAX_LENGTH,
  AGENT_OPERATION_IDEMPOTENCY_REQUIREMENTS,
  AGENT_OPERATION_KINDS,
  AGENT_OPERATION_OPTIONS_MAX_LENGTH,
  AGENT_OPERATION_OUTPUT_TEXT_MAX_LENGTH,
  AGENT_OPERATION_RESULT_KINDS,
  AGENT_OPERATION_RESULT_REFERENCES_MAX_LENGTH,
  AGENT_OPERATION_TEXT_VALUE_MAX_LENGTH,
  AGENT_OPERATION_TIMINGS,
  AGENT_OPERATION_TITLE_MAX_LENGTH,
  type AgentOperationCatalog,
  type AgentOperationDescriptor,
  type AgentOperationInvocation,
  type AgentOperationResult,
} from '../operations/types.js';
import {
  AgentArtifactIdSchema,
  AgentCanonicalIdValueSchema,
  AgentErrorSchema,
  AgentGeneratedResourceIdSchema,
  AgentOperationIdSchema,
  AgentOperationInvocationIdSchema,
  AgentRequestFieldIdSchema,
  createAgentCanonicalNonBlankStringSchema,
} from './foundation.js';

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const CanonicalTitleSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_OPERATION_TITLE_MAX_LENGTH,
);
const CanonicalDescriptionSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_OPERATION_DESCRIPTION_MAX_LENGTH,
);
const AgentOperationSelectOptionSchema = z
  .object({
    optionId: AgentCanonicalIdValueSchema,
    label: CanonicalTitleSchema,
    description: CanonicalDescriptionSchema.optional(),
  })
  .strict()
  .readonly();

const fieldBase = {
  fieldId: AgentRequestFieldIdSchema,
  label: CanonicalTitleSchema,
  description: CanonicalDescriptionSchema.optional(),
  required: z.boolean(),
  sensitivity: z.enum(['ordinary', 'sensitive']),
} as const;

const SelectOptionsSchema = z
  .array(AgentOperationSelectOptionSchema)
  .min(1)
  .max(AGENT_OPERATION_OPTIONS_MAX_LENGTH)
  .readonly();

export const AgentOperationFieldSchema = z.discriminatedUnion('fieldKind', [
  z.object({
    ...fieldBase,
    fieldKind: z.literal('text'),
    multiline: z.boolean(),
    maxLength: z.number().int().positive().max(AGENT_OPERATION_TEXT_VALUE_MAX_LENGTH),
  }).strict().readonly(),
  z.object({ ...fieldBase, fieldKind: z.literal('boolean') }).strict().readonly(),
  z.object({
    ...fieldBase,
    fieldKind: z.literal('single_select'),
    options: SelectOptionsSchema,
  }).strict().readonly(),
  z.object({
    ...fieldBase,
    fieldKind: z.literal('multi_select'),
    options: SelectOptionsSchema,
    maxSelections: z.number().int().positive().max(AGENT_OPERATION_OPTIONS_MAX_LENGTH),
  }).strict().readonly(),
  z.object({
    ...fieldBase,
    fieldKind: z.literal('integer'),
    minimum: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    maximum: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  }).strict().readonly(),
]);

const AgentOperationDescriptorPortableSchema = z
  .object({
    operationId: AgentOperationIdSchema,
    revision: PositiveSafeIntegerSchema,
    kind: z.enum(AGENT_OPERATION_KINDS),
    title: CanonicalTitleSchema,
    description: CanonicalDescriptionSchema.optional(),
    context: z.enum(AGENT_OPERATION_CONTEXTS),
    timing: z.enum(AGENT_OPERATION_TIMINGS),
    executionMode: z.enum(AGENT_OPERATION_EXECUTION_MODES),
    fields: z.array(AgentOperationFieldSchema).max(AGENT_OPERATION_FIELDS_MAX_LENGTH).readonly(),
    confirmation: z.enum(['none', 'required']),
    idempotency: z.enum(AGENT_OPERATION_IDEMPOTENCY_REQUIREMENTS),
    resultKind: z.enum(AGENT_OPERATION_RESULT_KINDS),
  })
  .strict()
  .readonly();

function addFieldIssues(
  fields: readonly z.output<typeof AgentOperationFieldSchema>[],
  context: z.RefinementCtx,
): void {
  const fieldIds = new Set<string>();
  fields.forEach((field, fieldIndex) => {
    if (fieldIds.has(field.fieldId)) {
      context.addIssue({ code: 'custom', path: ['fields', fieldIndex, 'fieldId'], message: 'Operation field IDs must be unique.' });
    }
    if (
      fieldIndex > 0
      && compareStringsByUnicodeCodePoint(
        fields[fieldIndex - 1]!.fieldId,
        field.fieldId,
      ) >= 0
    ) {
      context.addIssue({ code: 'custom', path: ['fields', fieldIndex, 'fieldId'], message: 'Operation fields must use canonical fieldId order.' });
    }
    fieldIds.add(field.fieldId);
    if (field.fieldKind === 'integer' && field.minimum > field.maximum) {
      context.addIssue({ code: 'custom', path: ['fields', fieldIndex, 'minimum'], message: 'Integer field minimum cannot exceed maximum.' });
    }
    if (field.fieldKind !== 'single_select' && field.fieldKind !== 'multi_select') return;
    const optionIds = new Set<string>();
    field.options.forEach((option, optionIndex) => {
      if (optionIds.has(option.optionId)) {
        context.addIssue({ code: 'custom', path: ['fields', fieldIndex, 'options', optionIndex, 'optionId'], message: 'Operation option IDs must be unique within a field.' });
      }
      if (
        optionIndex > 0
        && compareStringsByUnicodeCodePoint(
          field.options[optionIndex - 1]!.optionId,
          option.optionId,
        ) >= 0
      ) {
        context.addIssue({ code: 'custom', path: ['fields', fieldIndex, 'options', optionIndex, 'optionId'], message: 'Operation options must use canonical optionId order.' });
      }
      optionIds.add(option.optionId);
    });
    if (field.fieldKind === 'multi_select' && field.maxSelections > field.options.length) {
      context.addIssue({ code: 'custom', path: ['fields', fieldIndex, 'maxSelections'], message: 'Maximum selections cannot exceed available options.' });
    }
  });
}

export const AgentOperationDescriptorSchema: z.ZodType<AgentOperationDescriptor> =
  AgentOperationDescriptorPortableSchema.superRefine((descriptor, context) => {
    addFieldIssues(descriptor.fields, context);
  });

export const AgentOperationCatalogPortableSchema = z
  .object({
    revision: PositiveSafeIntegerSchema,
    operations: z.array(AgentOperationDescriptorPortableSchema)
      .max(AGENT_OPERATION_CATALOG_MAX_LENGTH)
      .readonly(),
  })
  .strict()
  .readonly();

export const AgentOperationCatalogSchema: z.ZodType<AgentOperationCatalog> =
  AgentOperationCatalogPortableSchema.superRefine((catalog, context) => {
    let previous = '';
    const operationIds = new Set<string>();
    catalog.operations.forEach((operation, operationIndex) => {
      const parsed = AgentOperationDescriptorSchema.safeParse(operation);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ code: 'custom', path: ['operations', operationIndex, ...issue.path], message: issue.message });
        }
      }
      if (operationIds.has(operation.operationId)) {
        context.addIssue({ code: 'custom', path: ['operations', operationIndex, 'operationId'], message: 'Operation IDs must be unique within a catalog.' });
      }
      if (
        operationIndex > 0
        && compareStringsByUnicodeCodePoint(previous, operation.operationId) >= 0
      ) {
        context.addIssue({ code: 'custom', path: ['operations', operationIndex, 'operationId'], message: 'Operations must be ordered by operationId.' });
      }
      operationIds.add(operation.operationId);
      previous = operation.operationId;
    });
  });

const AgentOperationFieldValueSchema = z.discriminatedUnion('fieldKind', [
  z.object({ fieldId: AgentRequestFieldIdSchema, fieldKind: z.literal('text'), value: z.string().max(AGENT_OPERATION_TEXT_VALUE_MAX_LENGTH) }).strict().readonly(),
  z.object({ fieldId: AgentRequestFieldIdSchema, fieldKind: z.literal('boolean'), value: z.boolean() }).strict().readonly(),
  z.object({ fieldId: AgentRequestFieldIdSchema, fieldKind: z.literal('single_select'), optionId: AgentCanonicalIdValueSchema }).strict().readonly(),
  z.object({ fieldId: AgentRequestFieldIdSchema, fieldKind: z.literal('multi_select'), optionIds: z.array(AgentCanonicalIdValueSchema).min(1).max(AGENT_OPERATION_OPTIONS_MAX_LENGTH).readonly() }).strict().readonly(),
  z.object({ fieldId: AgentRequestFieldIdSchema, fieldKind: z.literal('integer'), value: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) }).strict().readonly(),
]);

export const AgentOperationInvocationPortableSchema = z
  .object({
    invocationId: AgentOperationInvocationIdSchema,
    operationId: AgentOperationIdSchema,
    expectedRevision: PositiveSafeIntegerSchema,
    values: z.array(AgentOperationFieldValueSchema).max(AGENT_OPERATION_FIELDS_MAX_LENGTH).readonly(),
  })
  .strict()
  .readonly();

export const AgentOperationInvocationSchema: z.ZodType<AgentOperationInvocation> =
  AgentOperationInvocationPortableSchema.superRefine((invocation, context) => {
    const fieldIds = new Set<string>();
    invocation.values.forEach((value, valueIndex) => {
      if (fieldIds.has(value.fieldId)) {
        context.addIssue({ code: 'custom', path: ['values', valueIndex, 'fieldId'], message: 'Each operation field may be supplied once.' });
      }
      if (
        valueIndex > 0
        && compareStringsByUnicodeCodePoint(
          invocation.values[valueIndex - 1]!.fieldId,
          value.fieldId,
        ) >= 0
      ) {
        context.addIssue({ code: 'custom', path: ['values', valueIndex, 'fieldId'], message: 'Operation values must use canonical fieldId order.' });
      }
      fieldIds.add(value.fieldId);
      if (value.fieldKind === 'multi_select' && new Set(value.optionIds).size !== value.optionIds.length) {
        context.addIssue({ code: 'custom', path: ['values', valueIndex, 'optionIds'], message: 'Multi-select operation values must be unique.' });
      }
      if (
        value.fieldKind === 'multi_select'
        && value.optionIds.some(
          (optionId, optionIndex) =>
            optionIndex > 0
            && compareStringsByUnicodeCodePoint(
              value.optionIds[optionIndex - 1]!,
              optionId,
            ) >= 0,
        )
      ) {
        context.addIssue({ code: 'custom', path: ['values', valueIndex, 'optionIds'], message: 'Multi-select operation values must use canonical optionId order.' });
      }
    });
  });

export const AgentOperationResultPortableSchema = z
  .object({
    invocationId: AgentOperationInvocationIdSchema,
    status: z.enum(['accepted', 'completed', 'failed', 'canceled', 'waiting_for_request']),
    artifactIds: z.array(AgentArtifactIdSchema).min(1).max(AGENT_OPERATION_RESULT_REFERENCES_MAX_LENGTH).readonly().optional(),
    resourceIds: z.array(AgentGeneratedResourceIdSchema).min(1).max(AGENT_OPERATION_RESULT_REFERENCES_MAX_LENGTH).readonly().optional(),
    outputText: createAgentCanonicalNonBlankStringSchema(AGENT_OPERATION_OUTPUT_TEXT_MAX_LENGTH).optional(),
    error: AgentErrorSchema.optional(),
  })
  .strict()
  .readonly();

export const AgentOperationResultSchema: z.ZodType<AgentOperationResult> =
  AgentOperationResultPortableSchema.superRefine((result, context) => {
    if ((result.status === 'failed') !== (result.error !== undefined)) {
      context.addIssue({ code: 'custom', path: ['error'], message: 'Only failed operation results must include an error.' });
    }
    if (result.status !== 'completed' && (
      result.artifactIds !== undefined
      || result.resourceIds !== undefined
      || result.outputText !== undefined
    )) {
      context.addIssue({ code: 'custom', path: [], message: 'Only completed operation results may expose result values.' });
    }
    for (const [field, values] of [['artifactIds', result.artifactIds], ['resourceIds', result.resourceIds]] as const) {
      if (
        values !== undefined
        && new Set<string>(values as readonly string[]).size !== values.length
      ) {
        context.addIssue({ code: 'custom', path: [field], message: `${field} must be unique.` });
      }
      if (
        values !== undefined
        && values.some(
          (value, valueIndex) =>
            valueIndex > 0
            && compareStringsByUnicodeCodePoint(
              values[valueIndex - 1]!,
              value,
            ) >= 0,
        )
      ) {
        context.addIssue({ code: 'custom', path: [field], message: `${field} must use canonical ID order.` });
      }
    }
  });

export { AgentOperationDescriptorPortableSchema };
