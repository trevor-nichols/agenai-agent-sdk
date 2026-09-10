// ------------------------------------------------------------------------------------------------
//                facts.ts - Shared environment observation facts - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type { AgentExtensionId } from '../foundation/index.js';

// ------------------------------------------------------------------------------------------------
//                Closed Vocabulary
// ------------------------------------------------------------------------------------------------

export const AGENT_ENVIRONMENT_SCOPES = [
  'workspace',
  'project',
  'user',
  'system',
  'remote',
  'unknown',
] as const;

export const AGENT_ENVIRONMENT_ORIGINS = [
  'managed',
  'workspace',
  'user',
  'bundled',
  'plugin',
  'remote',
  'unknown',
] as const;

export const AGENT_INVOCATION_POSTURES = [
  'user_and_model',
  'user_only',
  'model_only',
  'unavailable',
  'unknown',
] as const;

export const AGENT_ENVIRONMENT_REASONS = [
  'missing_metadata',
  'native_ambiguity',
  'permission_denied',
  'authentication_required',
  'source_changed',
  'capacity_exceeded',
  'transient_failure',
] as const;

export type AgentEnvironmentScope = (typeof AGENT_ENVIRONMENT_SCOPES)[number];
export type AgentEnvironmentOrigin = (typeof AGENT_ENVIRONMENT_ORIGINS)[number];
export type AgentInvocationPosture = (typeof AGENT_INVOCATION_POSTURES)[number];
export type AgentEnvironmentReason = (typeof AGENT_ENVIRONMENT_REASONS)[number];

/** A source's location scope and provenance are separate observations. */
export interface AgentEnvironmentSource {
  readonly scope: AgentEnvironmentScope;
  readonly origin: AgentEnvironmentOrigin;
}

/** A native fact is explicit when the provider cannot establish a boolean value. */
export type AgentAvailabilityFact =
  | Readonly<{
      readonly kind: 'known';
      readonly value: boolean;
    }>
  | Readonly<{
      readonly kind: 'unknown';
    }>;

/** A relationship to an observed extension is valid only at an exact package generation. */
export interface AgentQualifiedExtensionReference {
  readonly extensionId: AgentExtensionId;
  readonly revision: number;
  readonly catalogRevision: number;
}
