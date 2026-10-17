import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
  agentProtocolSerializedJsonBytes,
} from '../foundation/types.js';
import {
  AGENT_ELICITATION_FIELDS_MAX_LENGTH,
  AGENT_ELICITATION_OPTIONS_MAX_LENGTH,
} from '../requests/types.js';
import {
  AGENT_SESSION_DECISION_CHOICE_DESCRIPTION_MAX_LENGTH,
  AGENT_SESSION_DECISION_CHOICE_ID_BYTES_LIMIT,
  AGENT_SESSION_DECISION_CHOICES_MAX_LENGTH,
  AGENT_SESSION_DECISION_DESCRIPTION_MAX_LENGTH,
  AGENT_SESSION_DECISION_RESPONSE_BYTES_LIMIT,
  AGENT_SESSION_DECISION_TITLE_MAX_LENGTH,
  AGENT_SESSION_DECISION_WORKSPACE_PATH_BYTES_LIMIT,
  AGENT_SESSION_FORM_RESPONSE_BYTES_LIMIT,
  AGENT_SESSION_PLAN_ID_BYTES_LIMIT,
  AGENT_SESSION_PLAN_REVISION_BYTES_LIMIT,
  AGENT_SESSION_PLAN_REVIEW_FEEDBACK_BYTES_LIMIT,
  AGENT_SESSION_PLAN_REVIEW_FEEDBACK_MAX_LENGTH,
  AGENT_SESSION_PLAN_REVIEW_RESPONSE_BYTES_LIMIT,
  AGENT_SESSION_PLAN_TEXT_BYTES_LIMIT,
  AGENT_SESSION_REQUEST_BYTES_LIMIT,
  type AgentSessionDecisionChoiceId,
  type AgentSessionDecisionRequest,
  type AgentSessionDecisionResponse,
  type AgentSessionFormChoice,
  type AgentSessionFormChoiceId,
  type AgentSessionFormRequest,
  type AgentSessionFormResponse,
  type AgentSessionPlanId,
  type AgentSessionPlanRevision,
  type AgentSessionPlanReviewChoice,
  type AgentSessionPlanReviewChoiceId,
  type AgentSessionPlanReviewRequest,
  type AgentSessionPlanReviewResponse,
  type AgentSessionRequest,
  type AgentSessionResponse,
} from '../sessionInteractions/types.js';
import {
  AgentIsoDateTimeSchema,
  AgentRequestIdSchema,
  AgentSessionIdSchema,
  createAgentCanonicalNonBlankStringSchema,
  createAgentCanonicalOpaqueStringSchema,
  withAcyclicProtocolInput,
} from './foundation.js';
import {
  AgentElicitationAnswerSchema,
  AgentElicitationFieldSchema,
  refineAgentElicitationAnswers,
  refineAgentElicitationFields,
} from './requests.js';

const encoder = new TextEncoder();
const inputBounds = {
  maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
  maxCollectionLength: AGENT_ELICITATION_OPTIONS_MAX_LENGTH,
  requireJsonData: true,
} as const;
const SingleLineTextSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_SESSION_DECISION_TITLE_MAX_LENGTH,
).regex(/^[^\u0000-\u001F\u007F-\u009F]*$/u);

function descriptionSchema(maxLength: number) {
  return createAgentCanonicalNonBlankStringSchema(maxLength)
    .regex(/^[^\u0000-\u0009\u000B-\u001F\u007F-\u009F]*$/u);
}

function nominalIdSchema<Id>(byteLimit: number): z.ZodType<Id> {
  // Only a successful canonical string and UTF-8 validation grants the brand.
  return createAgentCanonicalOpaqueStringSchema(
    byteLimit,
    'Session identities must be canonical and contain no control characters.',
  ).refine(
    (value) => encoder.encode(value).byteLength <= byteLimit,
    'Session identity exceeds its UTF-8 byte limit.',
  ) as unknown as z.ZodType<Id>;
}

function nonemptyArraySchema<Schema extends z.ZodType>(schema: Schema, maxLength: number) {
  // min(1) proves the head that Zod array inference does not retain.
  return z.array(schema).min(1).max(maxLength).readonly() as unknown as z.ZodType<
    readonly [z.output<Schema>, ...z.output<Schema>[]]
  >;
}

export const AgentSessionDecisionChoiceIdSchema = nominalIdSchema<AgentSessionDecisionChoiceId>(
  AGENT_SESSION_DECISION_CHOICE_ID_BYTES_LIMIT,
);
export const AgentSessionFormChoiceIdSchema = nominalIdSchema<AgentSessionFormChoiceId>(
  AGENT_SESSION_DECISION_CHOICE_ID_BYTES_LIMIT,
);
export const AgentSessionPlanReviewChoiceIdSchema = nominalIdSchema<AgentSessionPlanReviewChoiceId>(
  AGENT_SESSION_DECISION_CHOICE_ID_BYTES_LIMIT,
);
export const AgentSessionPlanIdSchema = nominalIdSchema<AgentSessionPlanId>(AGENT_SESSION_PLAN_ID_BYTES_LIMIT);
export const AgentSessionPlanRevisionSchema = nominalIdSchema<AgentSessionPlanRevision>(
  AGENT_SESSION_PLAN_REVISION_BYTES_LIMIT,
);

export const AgentSessionWorkspaceTargetSchema = z.object({
  kind: z.literal('workspace'),
  path: createAgentCanonicalNonBlankStringSchema(AGENT_SESSION_DECISION_WORKSPACE_PATH_BYTES_LIMIT)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u)
    .refine(
      (value) => encoder.encode(value).byteLength <= AGENT_SESSION_DECISION_WORKSPACE_PATH_BYTES_LIMIT,
      'Workspace target path exceeds its UTF-8 byte limit.',
    ),
}).strict().readonly();

export const AgentSessionDecisionConsequenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('grant'),
    scope: z.literal('workspace'),
    persistence: z.object({
      kind: z.literal('provider_managed'),
      duration: z.literal('persistent'),
      mayAffectOtherSessions: z.literal(true),
    }).strict().readonly(),
  }).strict().readonly(),
  z.object({
    kind: z.literal('decline'),
    configuration: z.literal('remains_gated'),
  }).strict().readonly(),
]);

export const AgentSessionDecisionChoiceSchema = z.object({
  choiceId: AgentSessionDecisionChoiceIdSchema,
  label: SingleLineTextSchema,
  description: descriptionSchema(AGENT_SESSION_DECISION_CHOICE_DESCRIPTION_MAX_LENGTH),
  consequence: AgentSessionDecisionConsequenceSchema,
}).strict().readonly();

const requestFields = {
  requestId: AgentRequestIdSchema,
  sessionId: AgentSessionIdSchema,
  title: SingleLineTextSchema,
  description: descriptionSchema(AGENT_SESSION_DECISION_DESCRIPTION_MAX_LENGTH).optional(),
  expiresAt: AgentIsoDateTimeSchema.optional(),
};

export const AgentSessionDecisionRequestPortableSchema = z.object({
  ...requestFields,
  kind: z.literal('decision'),
  target: AgentSessionWorkspaceTargetSchema,
  choices: nonemptyArraySchema(AgentSessionDecisionChoiceSchema, AGENT_SESSION_DECISION_CHOICES_MAX_LENGTH),
}).strict().readonly();

const offeredChoiceFields = {
  label: SingleLineTextSchema,
  description: descriptionSchema(AGENT_SESSION_DECISION_CHOICE_DESCRIPTION_MAX_LENGTH).optional(),
};

const AgentSessionFormChoicePortableSchema = z.discriminatedUnion('action', [
  z.object({ ...offeredChoiceFields, choiceId: AgentSessionFormChoiceIdSchema, action: z.literal('submit') }).strict().readonly(),
  z.object({ ...offeredChoiceFields, choiceId: AgentSessionFormChoiceIdSchema, action: z.literal('cancel') }).strict().readonly(),
]);

export const AgentSessionFormChoiceSchema: z.ZodType<AgentSessionFormChoice> =
  withAcyclicProtocolInput(AgentSessionFormChoicePortableSchema, inputBounds);

export const AgentSessionFormRequestPortableSchema = z.object({
  ...requestFields,
  kind: z.literal('form'),
  fields: nonemptyArraySchema(AgentElicitationFieldSchema, AGENT_ELICITATION_FIELDS_MAX_LENGTH),
  choices: nonemptyArraySchema(AgentSessionFormChoicePortableSchema, AGENT_SESSION_DECISION_CHOICES_MAX_LENGTH),
}).strict().readonly();

export const AgentSessionPlanSnapshotPortableSchema = z.object({
  planId: AgentSessionPlanIdSchema,
  revision: AgentSessionPlanRevisionSchema,
  title: SingleLineTextSchema,
  content: z.object({
    kind: z.literal('text'),
    format: z.enum(['plain_text', 'markdown']),
    text: z.string().min(1).max(AGENT_SESSION_PLAN_TEXT_BYTES_LIMIT),
  }).strict().readonly(),
}).strict().readonly();

export const AgentSessionPlanSnapshotSchema = AgentSessionPlanSnapshotPortableSchema.superRefine((plan, context) => {
  if (encoder.encode(plan.content.text).byteLength > AGENT_SESSION_PLAN_TEXT_BYTES_LIMIT) {
    context.addIssue({ code: 'custom', path: ['content', 'text'], message: 'Plan text exceeds its UTF-8 byte limit.' });
  }
});

const AgentSessionPlanReviewChoicePortableSchema = z.object({
  ...offeredChoiceFields,
  choiceId: AgentSessionPlanReviewChoiceIdSchema,
  action: z.enum(['approve', 'revise', 'abandon']),
}).strict().readonly();

export const AgentSessionPlanReviewChoiceSchema: z.ZodType<AgentSessionPlanReviewChoice> =
  withAcyclicProtocolInput(AgentSessionPlanReviewChoicePortableSchema, inputBounds);

export const AgentSessionPlanReviewRequestPortableSchema = z.object({
  ...requestFields,
  kind: z.literal('plan_review'),
  plan: AgentSessionPlanSnapshotPortableSchema,
  choices: nonemptyArraySchema(AgentSessionPlanReviewChoicePortableSchema, AGENT_SESSION_DECISION_CHOICES_MAX_LENGTH),
}).strict().readonly();

export const AgentSessionRequestPortableSchema = z.discriminatedUnion('kind', [
  AgentSessionDecisionRequestPortableSchema,
  AgentSessionFormRequestPortableSchema,
  AgentSessionPlanReviewRequestPortableSchema,
]);

function refineSessionRequest(request: AgentSessionRequest, context: z.RefinementCtx): void {
  if (agentProtocolSerializedJsonBytes(request) > AGENT_SESSION_REQUEST_BYTES_LIMIT) {
    context.addIssue({ code: 'custom', message: 'Session request exceeds its serialized UTF-8 byte limit.' });
  }
  const seenIds = new Set<string>();
  const seenActions = new Set<string>();
  request.choices.forEach((choice, index) => {
    if (seenIds.has(choice.choiceId)) {
      context.addIssue({ code: 'custom', path: ['choices', index, 'choiceId'], message: 'Session choices must have unique IDs.' });
    }
    seenIds.add(choice.choiceId);
    if ('action' in choice) {
      if (seenActions.has(choice.action)) {
        context.addIssue({ code: 'custom', path: ['choices', index, 'action'], message: 'Session choices must have distinct actions.' });
      }
      seenActions.add(choice.action);
    }
  });
  if (request.kind === 'form') {
    refineAgentElicitationFields(request.fields, context);
    if (!seenActions.has('submit')) {
      context.addIssue({ code: 'custom', path: ['choices'], message: 'Session forms must offer exactly one submit choice.' });
    }
  }
  if (request.kind === 'plan_review') {
    const plan = AgentSessionPlanSnapshotSchema.safeParse(request.plan);
    if (!plan.success) {
      for (const issue of plan.error.issues) {
        context.addIssue({ code: 'custom', path: ['plan', ...issue.path], message: issue.message });
      }
    }
  }
}

export const AgentSessionDecisionRequestSchema: z.ZodType<AgentSessionDecisionRequest> =
  withAcyclicProtocolInput(AgentSessionDecisionRequestPortableSchema, inputBounds).superRefine(refineSessionRequest);
export const AgentSessionFormRequestSchema: z.ZodType<AgentSessionFormRequest> =
  withAcyclicProtocolInput(AgentSessionFormRequestPortableSchema, inputBounds).superRefine(refineSessionRequest);
export const AgentSessionPlanReviewRequestSchema: z.ZodType<AgentSessionPlanReviewRequest> =
  withAcyclicProtocolInput(AgentSessionPlanReviewRequestPortableSchema, inputBounds).superRefine(refineSessionRequest);
export const AgentSessionRequestSchema: z.ZodType<AgentSessionRequest> =
  withAcyclicProtocolInput(AgentSessionRequestPortableSchema, inputBounds).superRefine(refineSessionRequest);

export const AgentSessionDecisionResponsePortableSchema = z.object({
  kind: z.literal('decision'),
  choiceId: AgentSessionDecisionChoiceIdSchema,
}).strict().readonly();

export const AgentSessionFormResponsePortableSchema = z.discriminatedUnion('action', [
  z.object({
    kind: z.literal('form'),
    action: z.literal('submit'),
    choiceId: AgentSessionFormChoiceIdSchema,
    answers: z.array(AgentElicitationAnswerSchema).max(AGENT_ELICITATION_FIELDS_MAX_LENGTH).readonly(),
  }).strict().readonly(),
  z.object({
    kind: z.literal('form'),
    action: z.literal('cancel'),
    choiceId: AgentSessionFormChoiceIdSchema,
  }).strict().readonly(),
]);

const planResponseFields = {
  kind: z.literal('plan_review'),
  choiceId: AgentSessionPlanReviewChoiceIdSchema,
  planId: AgentSessionPlanIdSchema,
  revision: AgentSessionPlanRevisionSchema,
};

export const AgentSessionPlanReviewResponsePortableSchema = z.discriminatedUnion('action', [
  z.object({ ...planResponseFields, action: z.enum(['approve', 'abandon']) }).strict().readonly(),
  z.object({
    ...planResponseFields,
    action: z.literal('revise'),
    feedback: z.string().min(1).max(AGENT_SESSION_PLAN_REVIEW_FEEDBACK_MAX_LENGTH).regex(/\S/u, 'Revision feedback must contain non-whitespace content.'),
  }).strict().readonly(),
]);

export const AgentSessionResponsePortableSchema = z.union([
  AgentSessionDecisionResponsePortableSchema,
  AgentSessionFormResponsePortableSchema,
  AgentSessionPlanReviewResponsePortableSchema,
]);

function refineSessionResponse(response: AgentSessionResponse, context: z.RefinementCtx): void {
  const byteLimit = response.kind === 'decision'
    ? AGENT_SESSION_DECISION_RESPONSE_BYTES_LIMIT
    : response.kind === 'form' ? AGENT_SESSION_FORM_RESPONSE_BYTES_LIMIT : AGENT_SESSION_PLAN_REVIEW_RESPONSE_BYTES_LIMIT;
  if (agentProtocolSerializedJsonBytes(response) > byteLimit) {
    context.addIssue({ code: 'custom', message: 'Session response exceeds its serialized UTF-8 byte limit.' });
  }
  if (response.kind === 'form' && response.action === 'submit') {
    refineAgentElicitationAnswers(response.answers, context);
  }
  if (response.kind === 'plan_review' && response.action === 'revise'
    && encoder.encode(response.feedback).byteLength > AGENT_SESSION_PLAN_REVIEW_FEEDBACK_BYTES_LIMIT) {
    context.addIssue({ code: 'custom', path: ['feedback'], message: 'Revision feedback exceeds its UTF-8 byte limit.' });
  }
}

export const AgentSessionDecisionResponseSchema: z.ZodType<AgentSessionDecisionResponse> =
  withAcyclicProtocolInput(AgentSessionDecisionResponsePortableSchema, inputBounds).superRefine(refineSessionResponse);
export const AgentSessionFormResponseSchema: z.ZodType<AgentSessionFormResponse> =
  withAcyclicProtocolInput(AgentSessionFormResponsePortableSchema, inputBounds).superRefine(refineSessionResponse);
export const AgentSessionPlanReviewResponseSchema: z.ZodType<AgentSessionPlanReviewResponse> =
  withAcyclicProtocolInput(AgentSessionPlanReviewResponsePortableSchema, inputBounds).superRefine(refineSessionResponse);
export const AgentSessionResponseSchema: z.ZodType<AgentSessionResponse> =
  withAcyclicProtocolInput(AgentSessionResponsePortableSchema, inputBounds).superRefine(refineSessionResponse);
