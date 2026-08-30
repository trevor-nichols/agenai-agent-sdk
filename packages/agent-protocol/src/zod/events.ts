// ------------------------------------------------------------------------------------------------
//                events.ts - Provider-observed event schemas - Dependencies: semantic schemas
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { AgentArtifactDescriptorSchema } from './artifacts.js';
import {
  AGENT_PROTOCOL_COLLECTION_MAX_LENGTH,
  AGENT_PROTOCOL_EVENT_BYTES_LIMIT,
  AGENT_PROTOCOL_SUMMARY_MAX_LENGTH,
  AGENT_PROTOCOL_TEXT_MAX_LENGTH,
  AGENT_PROTOCOL_VERSION,
  agentProtocolSerializedJsonBytes,
} from '../foundation/types.js';
import type { AgentEvent } from '../events/types.js';
import { AgentRequestPortableSchema, AgentRequestSchema } from './requests.js';
import {
  AGENT_CONTEXT_COMPACTION_STATES,
  AGENT_CONTEXT_MEASUREMENT_SCOPES,
  type AgentContextUsage,
} from '../turns/types.js';
import {
  AgentContentStreamKindSchema,
  AgentDiffSummarySchema,
  AgentItemSnapshotSchema,
  AgentPlanStepSchema,
  AgentTurnCompletedPayloadPortableSchema,
  AgentTurnCompletedPayloadSchema,
} from './turns.js';
import {
  AgentArtifactIdSchema,
  AgentCanonicalCodeSchema,
  AgentCanonicalIdValueSchema,
  AgentCanonicalNonBlankTextSchema,
  AgentErrorContextSchema,
  AgentErrorSchema,
  AgentIsoDateTimeSchema,
  AgentItemIdSchema,
  AgentProviderRefsPortableSchema,
  AgentProviderRefsSchema,
  AgentRequestIdSchema,
  AgentSessionIdSchema,
  AgentTurnIdSchema,
} from './foundation.js';

// ------------------------------------------------------------------------------------------------
//                Event Schema Builders
// ------------------------------------------------------------------------------------------------

const commonFields = {
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  sessionId: AgentSessionIdSchema,
  providerRefs: AgentProviderRefsPortableSchema.optional(),
  occurredAt: AgentIsoDateTimeSchema,
} as const;

function turnEvent<Type extends string, Payload extends z.ZodType>(
  type: Type,
  payload: Payload,
) {
  return z
    .object({
      ...commonFields,
      type: z.literal(type),
      turnId: AgentTurnIdSchema,
      payload,
    })
    .strict()
    .readonly();
}

function optionallyTurnScopedEvent<
  Type extends string,
  Payload extends z.ZodType,
>(type: Type, payload: Payload) {
  return z
    .object({
      ...commonFields,
      type: z.literal(type),
      turnId: AgentTurnIdSchema.optional(),
      payload,
    })
    .strict()
    .readonly();
}

const TurnStateChangedPayloadSchema = z
  .object({
    state: z.enum(['running', 'waiting_for_request']),
    requestId: AgentRequestIdSchema.optional(),
    message: z.string().max(AGENT_PROTOCOL_TEXT_MAX_LENGTH).optional(),
  })
  .strict()
  .readonly();

const ProgressUpdatedPayloadSchema = z
  .object({
    progressId: AgentCanonicalIdValueSchema,
    kind: z.enum(['task', 'hook', 'tool', 'unknown']),
    phase: z.enum(['started', 'updated', 'completed']),
    title: z.string().max(200).optional(),
    message: z.string().max(AGENT_PROTOCOL_TEXT_MAX_LENGTH).optional(),
    current: z.number().int().min(0).optional(),
    total: z.number().int().min(0).optional(),
  })
  .strict()
  .readonly();

const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const AgentContextCumulativeUsageSchema = z
  .object({
    inputTokens: NonNegativeSafeIntegerSchema.optional(),
    outputTokens: NonNegativeSafeIntegerSchema.optional(),
    cachedReadTokens: NonNegativeSafeIntegerSchema.optional(),
    cacheCreationTokens: NonNegativeSafeIntegerSchema.optional(),
    reasoningTokens: NonNegativeSafeIntegerSchema.optional(),
    modelCalls: NonNegativeSafeIntegerSchema.optional(),
    turns: NonNegativeSafeIntegerSchema.optional(),
  })
  .strict()
  .refine((usage) => Object.keys(usage).length > 0, {
    message: 'Cumulative context usage must contain at least one counter.',
  })
  .readonly();

export const AgentContextUsagePortableSchema = z
  .object({
    measurementScope: z.enum(AGENT_CONTEXT_MEASUREMENT_SCOPES),
    usedTokens: NonNegativeSafeIntegerSchema,
    maxTokens: PositiveSafeIntegerSchema,
    cumulative: AgentContextCumulativeUsageSchema.optional(),
    compaction: z
      .object({
        state: z.enum(AGENT_CONTEXT_COMPACTION_STATES),
        thresholdTokens: PositiveSafeIntegerSchema.optional(),
      })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();

export const AgentContextUsageSchema: z.ZodType<AgentContextUsage> =
  AgentContextUsagePortableSchema.superRefine((usage, context) => {
    if (usage.usedTokens > usage.maxTokens) {
      context.addIssue({
        code: 'custom',
        path: ['usedTokens'],
        message: 'Used context tokens cannot exceed the context maximum.',
      });
    }
    if (
      usage.compaction?.thresholdTokens !== undefined
      && usage.compaction.thresholdTokens > usage.maxTokens
    ) {
      context.addIssue({
        code: 'custom',
        path: ['compaction', 'thresholdTokens'],
        message: 'Compaction threshold cannot exceed the context maximum.',
      });
    }
  });

// ------------------------------------------------------------------------------------------------
//                Portable Union and Authoritative Refinements
// ------------------------------------------------------------------------------------------------

export const AgentEventPortableSchema = z.discriminatedUnion('type', [
  turnEvent(
    'turn.started',
    z.object({ message: z.string().max(AGENT_PROTOCOL_TEXT_MAX_LENGTH).optional() })
      .strict()
      .readonly(),
  ),
  turnEvent('turn.state_changed', TurnStateChangedPayloadSchema),
  turnEvent('turn.completed', AgentTurnCompletedPayloadPortableSchema),
  turnEvent('item.started', AgentItemSnapshotSchema),
  turnEvent('item.updated', AgentItemSnapshotSchema),
  turnEvent('item.completed', AgentItemSnapshotSchema),
  turnEvent(
    'content.delta',
    z
      .object({
        itemId: AgentItemIdSchema,
        streamKind: AgentContentStreamKindSchema,
        delta: z.string().max(AGENT_PROTOCOL_TEXT_MAX_LENGTH),
      })
      .strict()
      .readonly(),
  ),
  turnEvent(
    'turn.plan.updated',
    z
      .object({
        explanation: z.string().max(AGENT_PROTOCOL_SUMMARY_MAX_LENGTH).optional(),
        steps: z
          .array(AgentPlanStepSchema)
          .max(AGENT_PROTOCOL_COLLECTION_MAX_LENGTH)
          .readonly(),
      })
      .strict()
      .readonly(),
  ),
  turnEvent(
    'turn.plan.proposed',
    z
      .object({
        artifactId: AgentArtifactIdSchema,
        requestId: AgentRequestIdSchema,
      })
      .strict()
      .readonly(),
  ),
  turnEvent('turn.diff.updated', AgentDiffSummarySchema),
  turnEvent(
    'request.opened',
    z.object({ request: AgentRequestPortableSchema }).strict().readonly(),
  ),
  turnEvent('progress.updated', ProgressUpdatedPayloadSchema),
  turnEvent('context.usage.updated', AgentContextUsagePortableSchema),
  optionallyTurnScopedEvent(
    'artifact.referenced',
    z.object({ artifact: AgentArtifactDescriptorSchema }).strict().readonly(),
  ),
  optionallyTurnScopedEvent(
    'runtime.warning',
    z
      .object({
        code: AgentCanonicalCodeSchema,
        message: AgentCanonicalNonBlankTextSchema,
        retryable: z.boolean().optional(),
        context: AgentErrorContextSchema.optional(),
      })
      .strict()
      .readonly(),
  ),
  optionallyTurnScopedEvent(
    'runtime.error',
    z.object({ error: AgentErrorSchema }).strict().readonly(),
  ),
  optionallyTurnScopedEvent(
    'provider.diagnostic',
    z
      .object({
        code: AgentCanonicalCodeSchema,
        message: AgentCanonicalNonBlankTextSchema,
        context: AgentErrorContextSchema.optional(),
      })
      .strict()
      .readonly(),
  ),
]);

export const AgentEventSchema: z.ZodType<AgentEvent> =
  AgentEventPortableSchema.superRefine((event, context) => {
    if (event.providerRefs !== undefined) {
      const providerRefs = AgentProviderRefsSchema.safeParse(event.providerRefs);
      if (!providerRefs.success) {
        for (const issue of providerRefs.error.issues) {
          context.addIssue({ ...issue, path: ['providerRefs', ...issue.path] });
        }
      }
    }

    if (event.type === 'turn.state_changed') {
      const waiting = event.payload.state === 'waiting_for_request';
      if (waiting !== (event.payload.requestId !== undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['payload', 'requestId'],
          message: 'Only waiting_for_request state requires a requestId.',
        });
      }
    }

    if (event.type === 'turn.completed') {
      const completed = AgentTurnCompletedPayloadSchema.safeParse(event.payload);
      if (!completed.success) {
        for (const issue of completed.error.issues) {
          context.addIssue({ ...issue, path: ['payload', ...issue.path] });
        }
      }
    }

    if (event.type === 'request.opened') {
      const request = AgentRequestSchema.safeParse(event.payload.request);
      if (!request.success) {
        for (const issue of request.error.issues) {
          context.addIssue({
            ...issue,
            path: ['payload', 'request', ...issue.path],
          });
        }
      }
    }

    if (
      event.type === 'progress.updated'
      && event.payload.current !== undefined
      && event.payload.total !== undefined
      && event.payload.current > event.payload.total
    ) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'current'],
        message: 'Progress current cannot exceed total.',
      });
    }

    if (event.type === 'context.usage.updated') {
      const usage = AgentContextUsageSchema.safeParse(event.payload);
      if (!usage.success) {
        for (const issue of usage.error.issues) {
          context.addIssue({
            ...issue,
            path: ['payload', ...issue.path],
          });
        }
      }
    }

    if (agentProtocolSerializedJsonBytes(event) > AGENT_PROTOCOL_EVENT_BYTES_LIMIT) {
      context.addIssue({
        code: 'custom',
        message: `Agent events cannot exceed ${AGENT_PROTOCOL_EVENT_BYTES_LIMIT} serialized bytes.`,
      });
    }
  });
