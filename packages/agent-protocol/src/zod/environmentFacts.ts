// ------------------------------------------------------------------------------------------------
//                environmentFacts.ts - Shared environment fact schemas - Dependencies: foundation, Zod 4
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';

import {
  AGENT_ENVIRONMENT_ORIGINS,
  AGENT_ENVIRONMENT_REASONS,
  AGENT_ENVIRONMENT_SCOPES,
  AGENT_INVOCATION_POSTURES,
  type AgentAvailabilityFact,
  type AgentEnvironmentOrigin,
  type AgentEnvironmentReason,
  type AgentEnvironmentScope,
  type AgentEnvironmentSource,
  type AgentInvocationPosture,
  type AgentQualifiedExtensionReference,
} from '../environment/facts.js';
import { AgentExtensionIdSchema } from './foundation.js';

const PositiveSafeIntegerSchema = z.number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const AgentEnvironmentScopeSchema: z.ZodType<AgentEnvironmentScope> =
  z.enum(AGENT_ENVIRONMENT_SCOPES);
export const AgentEnvironmentOriginSchema: z.ZodType<AgentEnvironmentOrigin> =
  z.enum(AGENT_ENVIRONMENT_ORIGINS);
export const AgentInvocationPostureSchema: z.ZodType<AgentInvocationPosture> =
  z.enum(AGENT_INVOCATION_POSTURES);
export const AgentEnvironmentReasonSchema: z.ZodType<AgentEnvironmentReason> =
  z.enum(AGENT_ENVIRONMENT_REASONS);

export const AgentEnvironmentSourceSchema: z.ZodType<AgentEnvironmentSource> =
  z.object({
    scope: AgentEnvironmentScopeSchema,
    origin: AgentEnvironmentOriginSchema,
  }).strict().readonly();

export const AgentAvailabilityFactSchema: z.ZodType<AgentAvailabilityFact> =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('known'),
      value: z.boolean(),
    }).strict().readonly(),
    z.object({
      kind: z.literal('unknown'),
    }).strict().readonly(),
  ]);

export const AgentQualifiedExtensionReferenceSchema:
  z.ZodType<AgentQualifiedExtensionReference> = z.object({
    extensionId: AgentExtensionIdSchema,
    revision: PositiveSafeIntegerSchema,
    catalogRevision: PositiveSafeIntegerSchema,
  }).strict().readonly();
