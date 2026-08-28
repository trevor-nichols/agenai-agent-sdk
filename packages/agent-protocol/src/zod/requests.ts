// ------------------------------------------------------------------------------------------------
//                requests.ts - Approval and elicitation schemas - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  AGENT_PROTOCOL_SUMMARY_MAX_LENGTH,
  AGENT_PROTOCOL_TEXT_MAX_LENGTH,
} from '../foundation/types.js';
import type {
  AgentElicitationRequest,
  AgentRequest,
  AgentRequestResolution,
} from '../requests/types.js';
import {
  AgentArtifactIdSchema,
  AgentCanonicalIdValueSchema,
  AgentIsoDateTimeSchema,
  AgentRequestFieldIdSchema,
  AgentRequestIdSchema,
} from './foundation.js';

// ------------------------------------------------------------------------------------------------
//                Requests
// ------------------------------------------------------------------------------------------------

const AgentApprovalRequestSchema = z
  .object({
    requestKind: z.literal('approval'),
    requestId: AgentRequestIdSchema,
    prompt: z.string().min(1).max(AGENT_PROTOCOL_TEXT_MAX_LENGTH),
    subject: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('plan'),
          title: z.string().min(1).max(200),
          description: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
          artifactId: AgentArtifactIdSchema,
        })
        .strict()
        .readonly(),
      z
        .object({
          kind: z.enum(['command', 'file_change', 'tool', 'other']),
          title: z.string().min(1).max(200),
          description: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
        })
        .strict()
        .readonly(),
    ]),
    expiresAt: AgentIsoDateTimeSchema.optional(),
  })
  .strict()
  .readonly();

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

const AgentElicitationFieldSchema = z.discriminatedUnion('kind', [
  z
    .object({
      fieldId: AgentRequestFieldIdSchema,
      label: z.string().min(1).max(200),
      description: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
      required: z.boolean(),
      kind: z.literal('text'),
      multiline: z.boolean().optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      fieldId: AgentRequestFieldIdSchema,
      label: z.string().min(1).max(200),
      description: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
      required: z.boolean(),
      kind: z.literal('choice'),
      options: z
        .array(AgentRequestChoiceSchema)
        .min(1)
        .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
        .readonly(),
      multiple: z.boolean(),
      allowOther: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      fieldId: AgentRequestFieldIdSchema,
      label: z.string().min(1).max(200),
      description: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
      required: z.boolean(),
      kind: z.literal('boolean'),
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
      .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
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
      if (field.kind !== 'choice') return;
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
    });
  });

export const AgentRequestPortableSchema = z.discriminatedUnion('requestKind', [
  AgentApprovalRequestSchema,
  AgentElicitationRequestPortableSchema,
]);

export const AgentRequestSchema: z.ZodType<AgentRequest> =
  AgentRequestPortableSchema.superRefine((request, context) => {
    if (request.requestKind !== 'elicitation') return;
    const parsed = AgentElicitationRequestSchema.safeParse(request);
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
  .max(AGENT_PROTOCOL_TEXT_MAX_LENGTH)
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
      kind: z.literal('choice'),
      values: z
        .array(AgentRequestChoiceValueSchema)
        .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
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
]);

export const AgentRequestResolutionPortableSchema = z.union([
  z
    .object({
      requestKind: z.literal('approval'),
      requestId: AgentRequestIdSchema,
      decision: z.enum(['approved', 'denied', 'canceled']),
    })
    .strict()
    .readonly(),
  z
    .object({
      requestKind: z.literal('elicitation'),
      requestId: AgentRequestIdSchema,
      disposition: z.literal('answered'),
      answers: z
        .array(AgentElicitationAnswerSchema)
        .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
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
        answer.kind === 'choice'
        && new Set(answer.values).size !== answer.values.length
      ) {
        context.addIssue({
          code: 'custom',
          path: ['answers', answerIndex, 'values'],
          message: 'Choice answers cannot select the same option more than once.',
        });
      }
    });
  });
