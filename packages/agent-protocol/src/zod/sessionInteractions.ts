import { z } from 'zod/v4';

import {
  AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
  agentProtocolSerializedJsonBytes,
} from '../foundation/types.js';
import {
  AGENT_SESSION_DECISION_CHOICE_DESCRIPTION_MAX_LENGTH,
  AGENT_SESSION_DECISION_CHOICE_ID_BYTES_LIMIT,
  AGENT_SESSION_DECISION_CHOICES_MAX_LENGTH,
  AGENT_SESSION_DECISION_DESCRIPTION_MAX_LENGTH,
  AGENT_SESSION_DECISION_REQUEST_BYTES_LIMIT,
  AGENT_SESSION_DECISION_RESPONSE_BYTES_LIMIT,
  AGENT_SESSION_DECISION_TITLE_MAX_LENGTH,
  AGENT_SESSION_DECISION_WORKSPACE_PATH_BYTES_LIMIT,
  type AgentSessionDecisionChoiceId,
  type AgentSessionDecisionRequest,
  type AgentSessionDecisionResponse,
} from '../sessionInteractions/types.js';
import {
  AgentIsoDateTimeSchema,
  AgentRequestIdSchema,
  AgentSessionIdSchema,
  createAgentCanonicalNonBlankStringSchema,
  createAgentCanonicalOpaqueStringSchema,
  withAcyclicProtocolInput,
} from './foundation.js';

const encoder = new TextEncoder();
const SingleLineTextSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_SESSION_DECISION_TITLE_MAX_LENGTH,
).regex(/^[^\u0000-\u001F\u007F-\u009F]*$/u);

function descriptionSchema(maxLength: number) {
  return createAgentCanonicalNonBlankStringSchema(maxLength)
    .regex(/^[^\u0000-\u0009\u000B-\u001F\u007F-\u009F]*$/u);
}

// The schema validates the canonical string and byte bound before granting its nominal type.
export const AgentSessionDecisionChoiceIdSchema = createAgentCanonicalOpaqueStringSchema(
  AGENT_SESSION_DECISION_CHOICE_ID_BYTES_LIMIT,
  'Session decision choice IDs must be canonical and contain no control characters.',
).refine(
  (value) => encoder.encode(value).byteLength <= AGENT_SESSION_DECISION_CHOICE_ID_BYTES_LIMIT,
  'Session decision choice ID exceeds its UTF-8 byte limit.',
) as unknown as z.ZodType<AgentSessionDecisionChoiceId>;

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

// Zod array inference does not retain the nonempty tuple proved by min(1).
const ChoicesSchema = z.array(AgentSessionDecisionChoiceSchema)
  .min(1)
  .max(AGENT_SESSION_DECISION_CHOICES_MAX_LENGTH)
  .readonly() as unknown as z.ZodType<AgentSessionDecisionRequest['choices']>;

export const AgentSessionDecisionRequestPortableSchema = z.object({
  kind: z.literal('decision'),
  requestId: AgentRequestIdSchema,
  sessionId: AgentSessionIdSchema,
  title: SingleLineTextSchema,
  description: descriptionSchema(AGENT_SESSION_DECISION_DESCRIPTION_MAX_LENGTH).optional(),
  target: AgentSessionWorkspaceTargetSchema,
  expiresAt: AgentIsoDateTimeSchema,
  choices: ChoicesSchema,
}).strict().readonly();

const inputBounds = {
  maxDepth: AGENT_PROTOCOL_JSON_DEPTH_LIMIT,
  maxCollectionLength: AGENT_SESSION_DECISION_CHOICES_MAX_LENGTH,
  requireJsonData: true,
} as const;

export const AgentSessionDecisionRequestSchema: z.ZodType<AgentSessionDecisionRequest> =
  withAcyclicProtocolInput(AgentSessionDecisionRequestPortableSchema, inputBounds)
    .superRefine((request, context) => {
      if (agentProtocolSerializedJsonBytes(request) > AGENT_SESSION_DECISION_REQUEST_BYTES_LIMIT) {
        context.addIssue({ code: 'custom', message: 'Session decision exceeds its serialized UTF-8 byte limit.' });
      }
      const seen = new Set<AgentSessionDecisionChoiceId>();
      request.choices.forEach((choice, index) => {
        if (seen.has(choice.choiceId)) {
          context.addIssue({
            code: 'custom',
            path: ['choices', index, 'choiceId'],
            message: 'Session decision choices must have unique IDs.',
          });
        }
        seen.add(choice.choiceId);
      });
    });

export const AgentSessionDecisionResponsePortableSchema = z.object({
  choiceId: AgentSessionDecisionChoiceIdSchema,
}).strict().readonly();

export const AgentSessionDecisionResponseSchema: z.ZodType<AgentSessionDecisionResponse> =
  withAcyclicProtocolInput(AgentSessionDecisionResponsePortableSchema, inputBounds)
    .refine(
      (response) => agentProtocolSerializedJsonBytes(response) <= AGENT_SESSION_DECISION_RESPONSE_BYTES_LIMIT,
      'Session decision response exceeds its serialized UTF-8 byte limit.',
    );
