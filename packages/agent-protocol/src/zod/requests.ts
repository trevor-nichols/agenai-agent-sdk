// ------------------------------------------------------------------------------------------------
//                requests.ts - Approval and elicitation schemas - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_SUMMARY_MAX_LENGTH,
  AGENT_PROTOCOL_TEXT_MAX_LENGTH,
} from '../foundation/types.js';
import type {
  AgentApprovalRequest,
  AgentApprovalResolution,
  AgentElicitationRequest,
  AgentRequest,
  AgentRequestResolution,
} from '../requests/types.js';
import {
  AGENT_APPROVAL_DESCRIPTION_MAX_LENGTH,
  AGENT_APPROVAL_LABEL_MAX_LENGTH,
  AGENT_APPROVAL_OPTIONS_MAX_LENGTH,
  AGENT_APPROVAL_PERSISTENCES,
  AGENT_APPROVAL_SCOPE_KINDS,
  AGENT_ELICITATION_FIELDS_MAX_LENGTH,
  AGENT_ELICITATION_OPTIONS_MAX_LENGTH,
  AGENT_ELICITATION_TEXT_VALUE_MAX_LENGTH,
} from '../requests/types.js';
import {
  AgentApprovalOptionIdSchema,
  AgentArtifactIdSchema,
  AgentCanonicalIdValueSchema,
  AgentItemIdSchema,
  AgentIsoDateTimeSchema,
  AgentRequestFieldIdSchema,
  AgentRequestIdSchema,
} from './foundation.js';

// ------------------------------------------------------------------------------------------------
//                Requests
// ------------------------------------------------------------------------------------------------

const AgentApprovalLabelSchema = z
  .string()
  .min(1)
  .max(AGENT_APPROVAL_LABEL_MAX_LENGTH)
  .regex(/^(?:\S|\S[\s\S]*\S)$/u);
const AgentApprovalDescriptionSchema = z
  .string()
  .min(1)
  .max(AGENT_APPROVAL_DESCRIPTION_MAX_LENGTH)
  .regex(/^(?:\S|\S[\s\S]*\S)$/u);
const AgentApprovalPromptSchema = z
  .string()
  .min(1)
  .max(AGENT_PROTOCOL_TEXT_MAX_LENGTH)
  .regex(/^(?:\S|\S[\s\S]*\S)$/u);

const AgentApprovalOptionSchema = z
  .object({
    optionId: AgentApprovalOptionIdSchema,
    label: AgentApprovalLabelSchema,
    description: AgentApprovalDescriptionSchema.optional(),
    decision: z.enum(['approved', 'denied']),
    persistence: z.enum(AGENT_APPROVAL_PERSISTENCES),
    scope: z
      .object({ kind: z.enum(AGENT_APPROVAL_SCOPE_KINDS) })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export const AgentApprovalRequestPortableSchema = z
  .object({
    requestKind: z.literal('approval'),
    requestId: AgentRequestIdSchema,
    prompt: AgentApprovalPromptSchema,
    subject: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('plan'),
          title: AgentApprovalLabelSchema,
          description: AgentApprovalDescriptionSchema.optional(),
          artifactId: AgentArtifactIdSchema,
        })
        .strict()
        .readonly(),
      z
        .object({
          kind: z.enum(['command', 'file_change', 'tool', 'other']),
          title: AgentApprovalLabelSchema,
          description: AgentApprovalDescriptionSchema.optional(),
          itemId: AgentItemIdSchema,
        })
        .strict()
        .readonly(),
    ]),
    options: z
      .array(AgentApprovalOptionSchema)
      .min(1)
      .max(AGENT_APPROVAL_OPTIONS_MAX_LENGTH)
      .readonly(),
    expiresAt: AgentIsoDateTimeSchema.optional(),
  })
  .strict()
  .readonly();

export const AgentApprovalRequestSchema: z.ZodType<AgentApprovalRequest> =
  AgentApprovalRequestPortableSchema.superRefine((request, context) => {
    const optionIds = new Set<string>();
    request.options.forEach((option, optionIndex) => {
      if (optionIds.has(option.optionId)) {
        context.addIssue({
          code: 'custom',
          path: ['options', optionIndex, 'optionId'],
          message: 'Approval option IDs must be unique within a request.',
        });
      }
      optionIds.add(option.optionId);
    });
  });

const AgentRequestChoiceValueSchema = AgentCanonicalIdValueSchema.and(
  z.string().max(160),
);

const AgentRequestChoiceSchema = z
  .object({
    value: AgentRequestChoiceValueSchema,
    label: z.string().min(1).max(200),
    description: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
  })
  .strict()
  .readonly();

const AgentElicitationFieldBase = {
  fieldId: AgentRequestFieldIdSchema,
  label: z.string().min(1).max(200),
  description: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
  required: z.boolean(),
  sensitivity: z.enum(['ordinary', 'sensitive']),
} as const;

const AgentElicitationOptionsSchema = z
  .array(AgentRequestChoiceSchema)
  .min(1)
  .max(AGENT_ELICITATION_OPTIONS_MAX_LENGTH)
  .readonly();

const AgentElicitationFieldSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...AgentElicitationFieldBase,
      kind: z.literal('text'),
      multiline: z.boolean(),
      maxLength: z
        .number()
        .int()
        .positive()
        .max(AGENT_ELICITATION_TEXT_VALUE_MAX_LENGTH),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...AgentElicitationFieldBase,
      kind: z.literal('single_select'),
      options: AgentElicitationOptionsSchema,
      allowOther: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...AgentElicitationFieldBase,
      kind: z.literal('multi_select'),
      options: AgentElicitationOptionsSchema,
      allowOther: z.boolean(),
      maxSelections: z
        .number()
        .int()
        .positive()
        .max(AGENT_ELICITATION_OPTIONS_MAX_LENGTH),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...AgentElicitationFieldBase,
      kind: z.literal('boolean'),
    })
    .strict()
    .readonly(),
  z
    .object({
      ...AgentElicitationFieldBase,
      kind: z.literal('confirmation'),
      confirmLabel: z.string().min(1).max(200),
    })
    .strict()
    .readonly(),
]);

export const AgentElicitationRequestPortableSchema = z
  .object({
    requestKind: z.literal('elicitation'),
    requestId: AgentRequestIdSchema,
    prompt: z.string().min(1).max(AGENT_PROTOCOL_TEXT_MAX_LENGTH),
    fields: z
      .array(AgentElicitationFieldSchema)
      .min(1)
      .max(AGENT_ELICITATION_FIELDS_MAX_LENGTH)
      .readonly(),
    expiresAt: AgentIsoDateTimeSchema.optional(),
  })
  .strict()
  .readonly();

export const AgentElicitationRequestSchema: z.ZodType<AgentElicitationRequest> =
  AgentElicitationRequestPortableSchema.superRefine((request, context) => {
    const fieldIds = new Set<string>();
    request.fields.forEach((field, fieldIndex) => {
      if (fieldIds.has(field.fieldId)) {
        context.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'fieldId'],
          message: 'Request field IDs must be unique.',
        });
      }
      fieldIds.add(field.fieldId);
      if (field.kind !== 'single_select' && field.kind !== 'multi_select') {
        return;
      }
      const optionValues = new Set<string>();
      field.options.forEach((option, optionIndex) => {
        if (optionValues.has(option.value)) {
          context.addIssue({
            code: 'custom',
            path: ['fields', fieldIndex, 'options', optionIndex, 'value'],
            message: 'Choice option values must be unique within a field.',
          });
        }
        optionValues.add(option.value);
      });
      if (
        field.kind === 'multi_select'
        && field.maxSelections > field.options.length + (field.allowOther ? 1 : 0)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['fields', fieldIndex, 'maxSelections'],
          message: 'Maximum selections cannot exceed the available choices.',
        });
      }
    });
  });

export const AgentRequestPortableSchema = z.discriminatedUnion('requestKind', [
  AgentApprovalRequestPortableSchema,
  AgentElicitationRequestPortableSchema,
]);

export const AgentRequestSchema: z.ZodType<AgentRequest> =
  AgentRequestPortableSchema.superRefine((request, context) => {
    const parsed = request.requestKind === 'approval'
      ? AgentApprovalRequestSchema.safeParse(request)
      : AgentElicitationRequestSchema.safeParse(request);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
    }
  });

// ------------------------------------------------------------------------------------------------
//                Resolutions
// ------------------------------------------------------------------------------------------------

const AgentElicitationFreeformAnswerSchema = z
  .string()
  .max(AGENT_ELICITATION_TEXT_VALUE_MAX_LENGTH)
  .regex(/\S/u, 'Free-form answers must contain non-whitespace content.');

const AgentElicitationAnswerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      fieldId: AgentRequestFieldIdSchema,
      kind: z.literal('text'),
      value: AgentElicitationFreeformAnswerSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      fieldId: AgentRequestFieldIdSchema,
      kind: z.literal('single_select'),
      value: AgentRequestChoiceValueSchema.optional(),
      other: AgentElicitationFreeformAnswerSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      fieldId: AgentRequestFieldIdSchema,
      kind: z.literal('multi_select'),
      values: z
        .array(AgentRequestChoiceValueSchema)
        .max(AGENT_ELICITATION_OPTIONS_MAX_LENGTH)
        .readonly(),
      other: AgentElicitationFreeformAnswerSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      fieldId: AgentRequestFieldIdSchema,
      kind: z.literal('boolean'),
      value: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      fieldId: AgentRequestFieldIdSchema,
      kind: z.literal('confirmation'),
      confirmed: z.boolean(),
    })
    .strict()
    .readonly(),
]);

export const AgentApprovalResolutionSchema: z.ZodType<AgentApprovalResolution> =
  z.discriminatedUnion('disposition', [
    z
      .object({
        requestKind: z.literal('approval'),
        requestId: AgentRequestIdSchema,
        disposition: z.literal('selected'),
        optionId: AgentApprovalOptionIdSchema,
      })
      .strict()
      .readonly(),
    z
      .object({
        requestKind: z.literal('approval'),
        requestId: AgentRequestIdSchema,
        disposition: z.literal('canceled'),
      })
      .strict()
      .readonly(),
  ]);

export const AgentRequestResolutionPortableSchema = z.union([
  AgentApprovalResolutionSchema,
  z
    .object({
      requestKind: z.literal('elicitation'),
      requestId: AgentRequestIdSchema,
      disposition: z.literal('answered'),
      answers: z
        .array(AgentElicitationAnswerSchema)
        .max(AGENT_ELICITATION_FIELDS_MAX_LENGTH)
        .readonly(),
    })
    .strict()
    .readonly(),
  z
    .object({
      requestKind: z.literal('elicitation'),
      requestId: AgentRequestIdSchema,
      disposition: z.literal('canceled'),
    })
    .strict()
    .readonly(),
]);

export const AgentRequestResolutionSchema: z.ZodType<AgentRequestResolution> =
  AgentRequestResolutionPortableSchema.superRefine((resolution, context) => {
    if (
      resolution.requestKind !== 'elicitation'
      || resolution.disposition !== 'answered'
    ) {
      return;
    }
    resolution.answers.forEach((answer, answerIndex) => {
      if (
        answer.kind === 'multi_select'
        && new Set(answer.values).size !== answer.values.length
      ) {
        context.addIssue({
          code: 'custom',
          path: ['answers', answerIndex, 'values'],
          message: 'Multi-select answers cannot select the same option more than once.',
        });
      }
      if (
        answer.kind === 'single_select'
        && (answer.value === undefined) === (answer.other === undefined)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['answers', answerIndex],
          message: 'Single-select answers require exactly one declared or custom choice.',
        });
      }
    });
  });
