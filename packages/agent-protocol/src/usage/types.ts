// ------------------------------------------------------------------------------------------------
//                types.ts - Token-usage observation contracts - Dependencies: foundation
// ------------------------------------------------------------------------------------------------

import type {
  AgentTurnId,
  AgentUsageObservationId,
  AgentUsagePopulationId,
  AgentUsageScopeId,
  AgentUsageViewId,
} from '../foundation/types.js';

// ------------------------------------------------------------------------------------------------
//                Vocabularies and Bounds
// ------------------------------------------------------------------------------------------------

export const AGENT_TOKEN_USAGE_COUNTERS = [
  'inputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'cacheCreationFiveMinuteInputTokens',
  'cacheCreationOneHourInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'modelCalls',
  'turns',
] as const;

export const AGENT_TOKEN_USAGE_REASONS = [
  'not_reported',
  'unsupported',
  'native_result_incomplete',
  'history_incomplete',
  'origin_unknown',
  'coverage_unknown',
  'observation_interrupted',
  'counter_discontinuity',
] as const;

export const AGENT_TOKEN_USAGE_GAP_REASONS = [
  'not_reported',
  'native_result_incomplete',
  'history_incomplete',
  'origin_unknown',
  'coverage_unknown',
  'observation_interrupted',
  'counter_discontinuity',
] as const;

export const AGENT_TOKEN_USAGE_SCOPE_KINDS = [
  'session',
  'materialization',
  'turn',
  'model_call',
] as const;

export const AGENT_TOKEN_USAGE_ATTRIBUTION_KINDS = ['model', 'unknown', 'mixed'] as const;

/** Inclusive parents and the typed subsets whose known sum may never exceed an exact parent. */
export const AGENT_TOKEN_USAGE_COUNTER_SUBSETS = [
  { parent: 'inputTokens', parts: ['cacheReadInputTokens', 'cacheCreationInputTokens'] },
  {
    parent: 'cacheCreationInputTokens',
    parts: ['cacheCreationFiveMinuteInputTokens', 'cacheCreationOneHourInputTokens'],
  },
  { parent: 'outputTokens', parts: ['reasoningOutputTokens'] },
] as const satisfies readonly Readonly<{
  parent: AgentTokenUsageCounterName;
  parts: readonly AgentTokenUsageCounterName[];
}>[];

export const AGENT_TOKEN_USAGE_LIMITS = Object.freeze({
  identifierLength: 128,
  modelProviderLength: 64,
  modelRows: 8,
  epochsPerScope: 16,
  views: 4,
});

// ------------------------------------------------------------------------------------------------
//                Counts, Reasons, and Coverage
// ------------------------------------------------------------------------------------------------

export type AgentTokenUsageCounterName = (typeof AGENT_TOKEN_USAGE_COUNTERS)[number];
export type AgentTokenUsageReason = (typeof AGENT_TOKEN_USAGE_REASONS)[number];
export type AgentTokenUsageGapReason = (typeof AGENT_TOKEN_USAGE_GAP_REASONS)[number];

/** Nonempty unique subset of the gap reasons, stored in canonical order. */
export type AgentTokenUsageReasons = readonly [
  AgentTokenUsageGapReason,
  ...AgentTokenUsageGapReason[],
];

export type AgentExactTokenCount = Readonly<{ kind: 'exact'; value: number }>;
export type AgentInexactTokenCount =
  | Readonly<{ kind: 'at_least'; value: number; reasons: AgentTokenUsageReasons }>
  | Readonly<{
      kind: 'unavailable';
      reasons: readonly ['unsupported'] | AgentTokenUsageReasons;
    }>;
export type AgentTokenCount = AgentExactTokenCount | AgentInexactTokenCount;

export type AgentTokenUsageCounters<Count extends AgentTokenCount = AgentTokenCount> =
  Readonly<Record<AgentTokenUsageCounterName, Count>>;

export type AgentTokenUsageCoverage =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{ kind: 'partial' | 'unknown'; reasons: AgentTokenUsageReasons }>;

// ------------------------------------------------------------------------------------------------
//                Attribution
// ------------------------------------------------------------------------------------------------

export interface AgentUsageModel {
  readonly modelProvider?: string;
  readonly modelId: string;
}

export type AgentTokenUsageAttributionRow<Count extends AgentTokenCount = AgentTokenCount> =
  Readonly<{ model: AgentUsageModel; counters: AgentTokenUsageCounters<Count> }>;

export type AgentTokenUsageAttribution<Count extends AgentTokenCount = AgentTokenCount> =
  | Readonly<{ kind: 'model'; model: AgentUsageModel }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{
      kind: 'mixed';
      rowCoverage: 'complete' | 'partial';
      rows: readonly AgentTokenUsageAttributionRow<Count>[];
    }>;

export type AgentTokenUsageAttributionKind = AgentTokenUsageAttribution['kind'];

// ------------------------------------------------------------------------------------------------
//                Measurements
// ------------------------------------------------------------------------------------------------

export type AgentTokenUsageCounted =
  | Readonly<{
      coverage: Readonly<{ kind: 'complete' }>;
      counters: AgentTokenUsageCounters;
      attribution: AgentTokenUsageAttribution;
    }>
  | Readonly<{
      coverage: Exclude<AgentTokenUsageCoverage, { kind: 'complete' }>;
      counters: AgentTokenUsageCounters<AgentInexactTokenCount>;
      attribution: AgentTokenUsageAttribution<AgentInexactTokenCount>;
    }>;

export type AgentTokenUsageOriginKind = 'fresh_zero' | 'historical' | 'unknown';
export type AgentTokenUsageLaterEpoch =
  1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

export type AgentTokenUsageEpochOrigin =
  | Readonly<{
      epoch: 0;
      origin: Readonly<{ kind: AgentTokenUsageOriginKind; cause: 'initial' }>;
    }>
  | Readonly<{
      epoch: AgentTokenUsageLaterEpoch;
      origin: Readonly<{
        kind: AgentTokenUsageOriginKind;
        cause: 'native_reset' | 'native_new_origin';
      }>;
    }>;

export type AgentTokenUsageDelta = Readonly<{ kind: 'delta' }> & AgentTokenUsageCounted;

/** Stable means comparable covered history for this counter, not merely an exact numeric report. */
export type AgentTokenUsageComparison =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'stable'; populationId: AgentUsagePopulationId }>;

export type AgentTokenUsageSnapshot = Readonly<{
  kind: 'snapshot';
  revision: number;
  comparison: Readonly<Record<AgentTokenUsageCounterName, AgentTokenUsageComparison>>;
}> &
  AgentTokenUsageEpochOrigin &
  AgentTokenUsageCounted;

export type AgentTokenUsageUnavailable = Readonly<{
  kind: 'unavailable';
  reasons: AgentTokenUsageReasons;
}>;

// ------------------------------------------------------------------------------------------------
//                Views, Scopes, and Observations
// ------------------------------------------------------------------------------------------------

export type AgentTokenUsageAuthority = 'authoritative' | 'detail';
export type AgentTokenUsageAccounting = 'delta' | 'snapshot';
export type AgentTokenUsageInclusion = 'included' | 'excluded' | 'unknown';
export type AgentUsageCountBasis = 'provider_reported' | 'observed' | 'unsupported';

export interface AgentTokenUsageView<
  Authority extends AgentTokenUsageAuthority = AgentTokenUsageAuthority,
  Accounting extends AgentTokenUsageAccounting = AgentTokenUsageAccounting,
> {
  readonly viewId: AgentUsageViewId;
  readonly authority: Authority;
  readonly accounting: Accounting;
  /** modelCalls counts model requests; turns counts entered SDK turns. Native loop steps are neither. */
  readonly countBasis: Readonly<{
    modelCalls: AgentUsageCountBasis;
    turns: AgentUsageCountBasis;
  }>;
  readonly population: Readonly<{
    descendants: AgentTokenUsageInclusion;
    auxiliary: AgentTokenUsageInclusion;
  }>;
}

export type AgentTokenUsageScopeKind = (typeof AGENT_TOKEN_USAGE_SCOPE_KINDS)[number];

export type AgentTokenUsageScope = Readonly<{ scopeId: AgentUsageScopeId }> &
  (
    | Readonly<{ kind: 'session' | 'materialization' }>
    | Readonly<{ kind: 'turn'; turnId: AgentTurnId }>
    | Readonly<{ kind: 'model_call'; turnId?: AgentTurnId }>
  );

export type AgentTokenUsageDetailScope = AgentTokenUsageScope &
  Readonly<{ containedIn?: AgentUsageScopeId }>;

type AgentTokenUsageObservationOf<View, Scope, Measurement> = Readonly<{
  observationId: AgentUsageObservationId;
  view: View;
  scope: Scope;
  measurement: Measurement | AgentTokenUsageUnavailable;
  finality: 'open' | 'final';
}>;

export type AgentTokenUsageObservation =
  | AgentTokenUsageObservationOf<
      AgentTokenUsageView<'authoritative', 'delta'>,
      AgentTokenUsageScope,
      AgentTokenUsageDelta
    >
  | AgentTokenUsageObservationOf<
      AgentTokenUsageView<'authoritative', 'snapshot'>,
      AgentTokenUsageScope,
      AgentTokenUsageSnapshot
    >
  | AgentTokenUsageObservationOf<
      AgentTokenUsageView<'detail', 'delta'>,
      AgentTokenUsageDetailScope,
      AgentTokenUsageDelta
    >
  | AgentTokenUsageObservationOf<
      AgentTokenUsageView<'detail', 'snapshot'>,
      AgentTokenUsageDetailScope,
      AgentTokenUsageSnapshot
    >;

// ------------------------------------------------------------------------------------------------
//                Capability
// ------------------------------------------------------------------------------------------------

export interface AgentTokenUsageViewCapability {
  readonly view: AgentTokenUsageView;
  readonly scopeKind: AgentTokenUsageScopeKind;
  readonly reportedCounters: readonly AgentTokenUsageCounterName[];
  readonly attribution: readonly AgentTokenUsageAttributionKind[];
}

/** capabilities.tokenUsage; at most one listed view is authoritative. */
export type AgentTokenUsageCapability =
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'supported';
      views: readonly [AgentTokenUsageViewCapability, ...AgentTokenUsageViewCapability[]];
    }>;
