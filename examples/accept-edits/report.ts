import type { AgentApprovalPolicySupport, AgentSessionApprovalPolicy } from '@agen-ai/agent-runtime';
import type { AcceptEditsPolicyKind } from './config.js';
import type { AcceptEditsAction, AcceptEditsDecision } from './decisions.js';

export type AcceptEditsStage = 'credential' | 'materialize' | 'discover' | 'open' | 'turn';
export type AcceptEditsStopCode = 'cancelled' | 'deadline' | 'output_limit' | 'tool_item_limit' | 'resolution_not_delivered' | 'approval_options_refused';

export interface AcceptEditsRequestRecord {
  readonly action: AcceptEditsAction | null;
  readonly decision: AcceptEditsDecision;
  readonly exactOnce: boolean;
  readonly receipt: 'delivered' | 'rejected' | 'delivery_uncertain' | 'failed';
}

export interface AcceptEditsReport {
  readonly format: 'agenai.accept-edits-report.v1';
  readonly provider: 'claude' | 'opencode';
  readonly route: 'anthropic' | 'openai';
  readonly model: string;
  readonly requestedPolicy: AcceptEditsPolicyKind;
  status: 'completed' | 'refused' | 'cancelled' | 'failed' | 'cleanup_pending';
  stage: AcceptEditsStage;
  failureCode: string | null;
  stopCode: AcceptEditsStopCode | null;
  readiness: Readonly<{ status: string; version: string | null }> | null;
  support: AgentApprovalPolicySupport | null;
  effectivePolicy: AgentSessionApprovalPolicy | null;
  turnOutcome: string | null;
  interruption: 'not_requested' | 'requested' | 'accepted' | 'failed';
  readonly output: {
    events: number; bytes: number; toolItems: number; fileChanges: Array<Readonly<{ status: string; paths: readonly string[] }>>;
    /** The driver's own categorized refusals of owned calls, from `owned_tool_refused` diagnostics. */
    refusals: Array<Readonly<{ tool: string; refusal: string }>>;
  };
  readonly requests: AcceptEditsRequestRecord[];
  readonly cleanup: { attempts: number; settled: boolean; failures: string[] };
}

/**
 * Cleanup did not settle. The same process keeps the original session, registry and driver owners;
 * `retryCleanup()` retries exactly those owners and never reopens a session or replays the turn.
 */
export class AcceptEditsCleanupPendingError extends Error {
  readonly code = 'cleanup_pending';
  constructor(readonly report: AcceptEditsReport, readonly retryCleanup: () => Promise<AcceptEditsReport>, cause: unknown) {
    super('Accept-edits example cleanup is pending; retain this process and retry its original owners.', { cause });
    this.name = 'AcceptEditsCleanupPendingError';
  }
}

/** The most specific SDK error code in a cause chain; operating-system codes are not SDK contracts. */
export function failureCode(error: unknown): string {
  let found = 'unexpected_failure';
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code)) found = code;
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}
