// ------------------------------------------------------------------------------------------------
//                types.ts - Neutral operational failure and recovery evidence
// ------------------------------------------------------------------------------------------------

import type { AgentAccountQuotaReset } from '../accountQuota/types.js';
import type { AgentIsoDateTime } from '../foundation/types.js';

export const AGENT_FAILURE_CATEGORIES = [
  'rate_limited',
  'quota_exhausted',
  'budget_exhausted',
  'execution_limit',
  'context_limit',
  'authentication',
  'permission',
  'invalid_request',
  'overloaded',
  'transport',
  'provider',
  'protocol',
  'internal',
  'unknown',
] as const;

export type AgentFailureCategory = (typeof AGENT_FAILURE_CATEGORIES)[number];

export const AGENT_ERROR_CONTEXT_MAX_LENGTH = 160;

export interface AgentErrorContext {
  readonly operation?: string;
  readonly component?: string;
  readonly status?: string;
}

/** Immutable quota observation evidence, without account or execution authority. */
export interface AgentFailureQuotaReference {
  readonly sourceId: string;
  readonly poolId: string;
  readonly windowId: string;
  readonly observedAt: AgentIsoDateTime;
  readonly reset?: AgentAccountQuotaReset;
}

/** Recovery describes an applicable next step; it never authorizes effect replay. */
export type AgentRecoveryHint =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'retry'; notBefore?: AgentIsoDateTime }>
  | Readonly<{ kind: 'wait_for_quota'; quota?: AgentFailureQuotaReference }>
  | Readonly<{
    kind: 'user_action';
    action: 'authenticate' | 'review_access' | 'change_configuration' | 'review_allowance';
  }>;

export interface AgentError {
  readonly category: AgentFailureCategory;
  readonly code: string;
  readonly message: string;
  readonly recovery: AgentRecoveryHint;
  readonly context?: AgentErrorContext;
}
