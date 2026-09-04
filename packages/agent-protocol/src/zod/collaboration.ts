// ------------------------------------------------------------------------------------------------
//                collaboration.ts - Collaboration lifecycle schemas - Dependencies: turns, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import { compareStringsByUnicodeCodePoint } from '../foundation/ordering.js';
import {
  AGENT_COLLABORATION_OBJECTIVE_MAX_LENGTH,
  AGENT_COLLABORATION_PROGRESS_MAX_LENGTH,
  AGENT_COLLABORATION_RESULT_REFERENCES_MAX_LENGTH,
  AGENT_COLLABORATION_ROLES,
  AGENT_COLLABORATION_STATUSES,
  AGENT_COLLABORATION_STOP_REASONS,
  AGENT_COLLABORATION_TITLE_MAX_LENGTH,
  AGENT_COLLABORATION_USAGE_FIELDS,
  type AgentCollaborationControlInput,
  type AgentCollaborationNode,
  type AgentCollaborationSpawnInput,
} from '../collaboration/types.js';
import {
  AgentArtifactIdSchema,
  AgentCollaborationIdSchema,
  AgentErrorSchema,
  AgentGeneratedResourceIdSchema,
  AgentIsoDateTimeSchema,
  createAgentCanonicalNonBlankStringSchema,
} from './foundation.js';
import { AgentTurnInputContentSchema } from './turns.js';

const ObjectiveSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_COLLABORATION_OBJECTIVE_MAX_LENGTH,
);
const TitleSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_COLLABORATION_TITLE_MAX_LENGTH,
);
const ProgressSchema = createAgentCanonicalNonBlankStringSchema(
  AGENT_COLLABORATION_PROGRESS_MAX_LENGTH,
);
const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const CollaborationStopReasonSchema = z.enum(AGENT_COLLABORATION_STOP_REASONS);
const AgentCollaborationOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict().readonly(),
  z
    .object({ kind: z.literal('failed'), error: AgentErrorSchema })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('canceled'), reason: CollaborationStopReasonSchema })
    .strict()
    .readonly(),
]);
const AgentCollaborationUsageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unavailable') }).strict().readonly(),
  z
    .object({
      kind: z.literal('reported'),
      inputTokens: NonNegativeSafeIntegerSchema.optional(),
      outputTokens: NonNegativeSafeIntegerSchema.optional(),
      reasoningTokens: NonNegativeSafeIntegerSchema.optional(),
      totalTokens: NonNegativeSafeIntegerSchema.optional(),
      modelCalls: NonNegativeSafeIntegerSchema.optional(),
    })
    .strict()
    .refine(
      (usage) => AGENT_COLLABORATION_USAGE_FIELDS.some(
        (field) => usage[field] !== undefined,
      ),
      { message: 'Reported collaboration usage must include at least one counter.' },
    )
    .readonly(),
]);
const artifactIds = z.array(AgentArtifactIdSchema)
  .min(1)
  .max(AGENT_COLLABORATION_RESULT_REFERENCES_MAX_LENGTH)
  .readonly()
  .optional();
const resourceIds = z.array(AgentGeneratedResourceIdSchema)
  .min(1)
  .max(AGENT_COLLABORATION_RESULT_REFERENCES_MAX_LENGTH)
  .readonly()
  .optional();

export const AgentCollaborationNodePortableSchema = z.object({
  collaborationId: AgentCollaborationIdSchema,
  rootCollaborationId: AgentCollaborationIdSchema,
  parentCollaborationId: AgentCollaborationIdSchema.optional(),
  role: z.enum(AGENT_COLLABORATION_ROLES),
  title: TitleSchema,
  status: z.enum(AGENT_COLLABORATION_STATUSES),
  objective: ObjectiveSchema,
  progress: ProgressSchema.optional(),
  usage: AgentCollaborationUsageSchema,
  outcome: AgentCollaborationOutcomeSchema.optional(),
  createdAt: AgentIsoDateTimeSchema,
  updatedAt: AgentIsoDateTimeSchema,
  terminalAt: AgentIsoDateTimeSchema.optional(),
  closedAt: AgentIsoDateTimeSchema.optional(),
  artifactIds,
  resourceIds,
}).strict().readonly();

export const AgentCollaborationNodeSchema: z.ZodType<AgentCollaborationNode> =
  AgentCollaborationNodePortableSchema.superRefine((node, context) => {
    const terminal = ['completed', 'failed', 'canceled'].includes(node.status);
    if (terminal !== (node.terminalAt !== undefined)) {
      context.addIssue({ code: 'custom', path: ['terminalAt'], message: 'Exactly terminal collaboration nodes must include terminalAt.' });
    }
    if (terminal !== (node.outcome !== undefined)) {
      context.addIssue({ code: 'custom', path: ['outcome'], message: 'Exactly terminal collaboration nodes must include an outcome.' });
    }
    if (
      node.outcome !== undefined
      && node.outcome.kind !== node.status
    ) {
      context.addIssue({ code: 'custom', path: ['outcome'], message: 'Collaboration outcome must match its terminal lifecycle status.' });
    }
    if (!terminal && (node.artifactIds !== undefined || node.resourceIds !== undefined)) {
      context.addIssue({ code: 'custom', path: ['artifactIds'], message: 'Only terminal collaboration nodes may expose result references.' });
    }
    if (node.parentCollaborationId === undefined && node.rootCollaborationId !== node.collaborationId) {
      context.addIssue({ code: 'custom', path: ['rootCollaborationId'], message: 'A root collaboration node must identify itself as root.' });
    }
    if (node.parentCollaborationId === node.collaborationId) {
      context.addIssue({ code: 'custom', path: ['parentCollaborationId'], message: 'A collaboration node cannot parent itself.' });
    }
    if (Date.parse(node.updatedAt) < Date.parse(node.createdAt)) {
      context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Collaboration updatedAt cannot precede createdAt.' });
    }
    if (
      node.terminalAt !== undefined
      && (
        Date.parse(node.terminalAt) < Date.parse(node.createdAt)
        || Date.parse(node.terminalAt) > Date.parse(node.updatedAt)
      )
    ) {
      context.addIssue({ code: 'custom', path: ['terminalAt'], message: 'Collaboration terminalAt must fall within its observed lifetime.' });
    }
    if (
      node.closedAt !== undefined
      && (
        node.terminalAt === undefined
        || Date.parse(node.closedAt) < Date.parse(node.terminalAt)
        || Date.parse(node.closedAt) > Date.parse(node.updatedAt)
      )
    ) {
      context.addIssue({ code: 'custom', path: ['closedAt'], message: 'A collaboration may close only after its terminal outcome.' });
    }
    if (node.artifactIds !== undefined && new Set(node.artifactIds).size !== node.artifactIds.length) {
      context.addIssue({ code: 'custom', path: ['artifactIds'], message: 'Collaboration artifact IDs must be unique.' });
    }
    if (
      node.artifactIds?.some(
        (artifactId, artifactIndex) =>
          artifactIndex > 0
          && compareStringsByUnicodeCodePoint(
            node.artifactIds![artifactIndex - 1]!,
            artifactId,
          ) >= 0,
      )
    ) {
      context.addIssue({ code: 'custom', path: ['artifactIds'], message: 'Collaboration artifact IDs must use canonical order.' });
    }
    if (node.resourceIds !== undefined && new Set(node.resourceIds).size !== node.resourceIds.length) {
      context.addIssue({ code: 'custom', path: ['resourceIds'], message: 'Collaboration resource IDs must be unique.' });
    }
    if (
      node.resourceIds?.some(
        (resourceId, resourceIndex) =>
          resourceIndex > 0
          && compareStringsByUnicodeCodePoint(
            node.resourceIds![resourceIndex - 1]!,
            resourceId,
          ) >= 0,
      )
    ) {
      context.addIssue({ code: 'custom', path: ['resourceIds'], message: 'Collaboration resource IDs must use canonical order.' });
    }
  });

export const AgentCollaborationSpawnInputSchema: z.ZodType<AgentCollaborationSpawnInput> = z
  .object({
    collaborationId: AgentCollaborationIdSchema,
    parentCollaborationId: AgentCollaborationIdSchema.optional(),
    role: z.enum(AGENT_COLLABORATION_ROLES),
    title: TitleSchema,
    objective: ObjectiveSchema,
    createdAt: AgentIsoDateTimeSchema,
  })
  .strict()
  .refine((input) => input.parentCollaborationId !== input.collaborationId, {
    path: ['parentCollaborationId'],
    message: 'A collaboration node cannot parent itself.',
  })
  .readonly();

const SteerPortableSchema = AgentTurnInputContentSchema.and(
  z.object({ action: z.literal('steer'), collaborationId: AgentCollaborationIdSchema }).strict(),
).readonly();

export const AgentCollaborationControlInputSchema: z.ZodType<AgentCollaborationControlInput> =
  z.union([
    SteerPortableSchema,
    z.object({
      action: z.literal('stop'),
      collaborationId: AgentCollaborationIdSchema,
      reason: CollaborationStopReasonSchema,
    }).strict().readonly(),
    z.object({ action: z.literal('close'), collaborationId: AgentCollaborationIdSchema }).strict().readonly(),
    z.object({ action: z.literal('inspect'), collaborationId: AgentCollaborationIdSchema }).strict().readonly(),
  ]);
