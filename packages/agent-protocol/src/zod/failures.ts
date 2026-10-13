// ------------------------------------------------------------------------------------------------
//                failures.ts - Bounded operational failure and recovery schemas
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_ERROR_CONTEXT_MAX_LENGTH,
  AGENT_FAILURE_CATEGORIES,
  type AgentError,
  type AgentErrorContext,
  type AgentFailureQuotaReference,
  type AgentRecoveryHint,
} from '../failures/types.js';
import {
  AGENT_PROTOCOL_JSON_BYTES_LIMIT,
  agentProtocolSerializedJsonBytes,
} from '../foundation/types.js';
import { AgentAccountQuotaResetSchema } from './accountQuota.js';
import {
  AgentCanonicalCodeSchema,
  AgentCanonicalIdValueSchema,
  AgentCanonicalNonBlankTextSchema,
  AgentIsoDateTimeSchema,
  createAgentCanonicalNonBlankStringSchema,
} from './foundation.js';

export const AgentFailureCategorySchema = z.enum(AGENT_FAILURE_CATEGORIES);

export const AgentErrorContextSchema: z.ZodType<AgentErrorContext> = z.object({
  operation: createAgentCanonicalNonBlankStringSchema(AGENT_ERROR_CONTEXT_MAX_LENGTH).optional(),
  component: createAgentCanonicalNonBlankStringSchema(AGENT_ERROR_CONTEXT_MAX_LENGTH).optional(),
  status: createAgentCanonicalNonBlankStringSchema(AGENT_ERROR_CONTEXT_MAX_LENGTH).optional(),
}).strict().readonly();

export const AgentFailureQuotaReferenceSchema: z.ZodType<AgentFailureQuotaReference> = z.object({
  sourceId: AgentCanonicalIdValueSchema,
  poolId: AgentCanonicalIdValueSchema,
  windowId: AgentCanonicalIdValueSchema,
  observedAt: AgentIsoDateTimeSchema,
  reset: AgentAccountQuotaResetSchema.optional(),
}).strict().readonly().superRefine((reference, context) => {
  if (reference.reset && Date.parse(reference.reset.observedAt) > Date.parse(reference.observedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['reset', 'observedAt'],
      message: 'Reset evidence cannot be newer than the quota observation.',
    });
  }
});

export const AgentRecoveryHintSchema: z.ZodType<AgentRecoveryHint> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict().readonly(),
  z.object({ kind: z.literal('none') }).strict().readonly(),
  z.object({ kind: z.literal('retry'), notBefore: AgentIsoDateTimeSchema.optional() }).strict().readonly(),
  z.object({ kind: z.literal('wait_for_quota'), quota: AgentFailureQuotaReferenceSchema.optional() }).strict().readonly(),
  z.object({
    kind: z.literal('user_action'),
    action: z.enum(['authenticate', 'review_access', 'change_configuration', 'review_allowance']),
  }).strict().readonly(),
]);

export const AgentErrorSchema: z.ZodType<AgentError> = z.object({
  category: AgentFailureCategorySchema,
  code: AgentCanonicalCodeSchema,
  message: AgentCanonicalNonBlankTextSchema,
  recovery: AgentRecoveryHintSchema,
  context: AgentErrorContextSchema.optional(),
}).strict().readonly().superRefine((error, context) => {
  if (
    error.recovery.kind === 'wait_for_quota'
    && error.recovery.quota !== undefined
    && error.category !== 'rate_limited'
    && error.category !== 'quota_exhausted'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['recovery', 'quota'],
      message: 'Quota references apply only to rate-limited or quota-exhausted failures.',
    });
  }
  if (agentProtocolSerializedJsonBytes(error) > AGENT_PROTOCOL_JSON_BYTES_LIMIT) {
    context.addIssue({
      code: 'custom',
      message: `Agent failures cannot exceed ${AGENT_PROTOCOL_JSON_BYTES_LIMIT} serialized bytes.`,
    });
  }
});
