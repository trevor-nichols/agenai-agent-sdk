// ------------------------------------------------------------------------------------------------
//                types.ts - Account allowance observations - Dependencies: protocol foundation
// ------------------------------------------------------------------------------------------------

import type { AgentIsoDateTime } from '../foundation/types.js';

export const AGENT_ACCOUNT_QUOTA_SCHEMA_VERSION = 1 as const;
export const AGENT_ACCOUNT_QUOTA_MAX_WINDOWS = 64;
export const AGENT_ACCOUNT_QUOTA_MAX_BYTES = 65_536;
export const AGENT_ACCOUNT_QUOTA_MAX_LABEL_LENGTH = 160;
export const AGENT_ACCOUNT_QUOTA_MAX_SCOPE_IDS = 32;

export type AgentAccountQuotaApplicability =
  | Readonly<{ kind: 'account' }>
  | Readonly<{ kind: 'product'; productId: string }>
  | Readonly<{ kind: 'models'; modelIds: readonly string[] }>
  | Readonly<{ kind: 'unknown' }>;

export type AgentAccountQuotaPeriod =
  | Readonly<{ kind: 'rolling' | 'fixed' | 'unknown'; durationSeconds?: number }>
  | Readonly<{ kind: 'calendar'; unit: 'day' | 'week' | 'month' | 'year'; timeZone: string }>
  | Readonly<{ kind: 'billing_cycle'; unit: 'month' | 'year' | 'unknown' }>;

export type AgentAccountQuotaMeasurement =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'percentage'; usedPercent: number }>
  | Readonly<{
    kind: 'quantity';
    unit: string;
    used?: number;
    limit?: number;
    remaining?: number;
    usedPercent?: number;
  }>
  | Readonly<{
    kind: 'money';
    currency: string;
    scale: number;
    usedMinorUnits?: number;
    limitMinorUnits?: number;
    remainingMinorUnits?: number;
    usedPercent?: number;
  }>;

export interface AgentAccountQuotaReset {
  readonly at: AgentIsoDateTime;
  readonly precision: 'reported' | 'estimated';
  readonly observedAt: AgentIsoDateTime;
}

export interface AgentAccountQuotaWindow {
  readonly poolId: string;
  readonly windowId: string;
  readonly label: string;
  readonly allowanceKind: 'included' | 'extra' | 'reserve' | 'unknown';
  readonly applicability: AgentAccountQuotaApplicability;
  readonly period: AgentAccountQuotaPeriod;
  readonly measurement: AgentAccountQuotaMeasurement;
  readonly observedAt: AgentIsoDateTime;
  readonly startsAt?: AgentIsoDateTime;
  readonly reset?: AgentAccountQuotaReset;
}

export interface AgentAccountQuotaAllowance {
  readonly included: 'allowed' | 'exhausted' | 'unknown';
  readonly extra: 'allowed' | 'unavailable' | 'unknown';
  readonly reserve: 'allowed' | 'unavailable' | 'unknown';
}

interface AgentAccountQuotaSnapshotBase {
  readonly schemaVersion: typeof AGENT_ACCOUNT_QUOTA_SCHEMA_VERSION;
  readonly sourceId: string;
  readonly observedAt: AgentIsoDateTime;
}

export interface AgentAvailableAccountQuotaSnapshot extends AgentAccountQuotaSnapshotBase {
  readonly state: 'available';
  readonly completeness: 'complete' | 'partial';
  readonly accountLabel?: string;
  readonly planLabel?: string;
  readonly windows: readonly AgentAccountQuotaWindow[];
  readonly allowance: AgentAccountQuotaAllowance;
}

export type AgentAccountQuotaSnapshot =
  | AgentAvailableAccountQuotaSnapshot
  | Readonly<AgentAccountQuotaSnapshotBase & {
    state: 'authentication_required' | 'inapplicable' | 'temporarily_unavailable';
  }>;
