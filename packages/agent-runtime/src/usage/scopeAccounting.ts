// ------------------------------------------------------------------------------------------------
//                scopeAccounting.ts - Delta and snapshot scope state transitions - Dependencies: counts
// ------------------------------------------------------------------------------------------------

import {
  AGENT_TOKEN_USAGE_COUNTERS,
  AGENT_TOKEN_USAGE_LIMITS,
  type AgentTokenUsageAttribution,
  type AgentTokenUsageCounterName,
  type AgentTokenUsageCounters,
  type AgentTokenUsageDelta,
  type AgentTokenUsageObservation,
  type AgentTokenUsageReason,
  type AgentTokenUsageSnapshot,
} from "@agen-ai/agent-protocol";

import {
  aggregateAttribution,
  combineAttribution,
  modelKey,
  UNKNOWN_ATTRIBUTION,
} from "./attribution.js";
import {
  addCounts,
  assertSubsetsHold,
  checkedAdd,
  combineCounters,
  knownValue,
  lowerBound,
  mapCounters,
  markDiscontinuous,
  overlapCounts,
  reasonsOf,
  unavailableCounters,
  unionReasons,
  ZERO_COUNTERS,
} from "./counts.js";
import { rejectUsage } from "./rejection.js";
import type {
  AgentTokenUsageAggregateAttribution,
  AgentTokenUsageAggregateCount,
  AgentTokenUsageAggregateCounters,
} from "./types.js";

type Counter = AgentTokenUsageCounterName;
type Count = AgentTokenUsageAggregateCount;
type Counters = AgentTokenUsageAggregateCounters;
type Attribution = AgentTokenUsageAggregateAttribution;
type ReasonList = readonly AgentTokenUsageReason[];
type KnownCounts = Readonly<Record<Counter, number | null>>;
type Measurement = AgentTokenUsageObservation["measurement"];

// ------------------------------------------------------------------------------------------------
//                State
// ------------------------------------------------------------------------------------------------

/** What one scope adds to its view; attribution is null until measured evidence exists. */
export interface ScopeContribution {
  readonly total: Counters;
  readonly newWork: Counters;
  readonly attribution: Attribution | null;
  readonly newWorkAttribution: Attribution | null;
  readonly disjoint: boolean;
}

interface DeltaAccounting {
  readonly kind: "delta";
  readonly total: Counters;
  readonly attribution: Attribution | null;
}

interface EpochAccounting {
  readonly epoch: number;
  readonly origin: AgentTokenUsageSnapshot["origin"];
  readonly revision: number;
  readonly baseline: Counters;
  readonly baselineAttribution: AgentTokenUsageAttribution;
  readonly baselineComparison: AgentTokenUsageSnapshot["comparison"];
  readonly comparable: Readonly<Record<Counter, boolean>>;
  readonly latest: AgentTokenUsageCounters;
  readonly maxKnown: KnownCounts;
  readonly models: ReadonlyMap<string, KnownCounts>;
  readonly attribution: AgentTokenUsageAttribution;
  readonly stale: ReasonList;
}

interface SnapshotAccounting {
  readonly kind: "snapshot";
  readonly epochs: readonly EpochAccounting[];
  readonly unavailable: ReasonList;
}

export type ScopeAccounting = DeltaAccounting | SnapshotAccounting;

const NOTHING_KNOWN: KnownCounts = mapCounters(() => null);

// ------------------------------------------------------------------------------------------------
//                Delta Scopes
// ------------------------------------------------------------------------------------------------

function applyDelta(prior: DeltaAccounting | undefined, measurement: AgentTokenUsageDelta | Extract<Measurement, { kind: "unavailable" }>): DeltaAccounting {
  const added = measurement.kind === "unavailable" ? unavailableCounters(measurement.reasons) : measurement.counters;
  const priorAttribution = prior?.attribution ?? null;
  return {
    kind: "delta",
    total: prior === undefined ? added : combineCounters(prior.total, added, addCounts),
    attribution: measurement.kind === "unavailable"
      ? priorAttribution
      : combineAttribution(priorAttribution, aggregateAttribution(measurement.attribution)),
  };
}

// ------------------------------------------------------------------------------------------------
//                Snapshot Scopes
// ------------------------------------------------------------------------------------------------

function advanceKnown(previous: KnownCounts, next: AgentTokenUsageCounters): KnownCounts {
  return mapCounters((name) => {
    const count = next[name];
    const value = count.kind === "unavailable" ? null : count.value;
    const prior = previous[name];
    if (value !== null && prior !== null && value < prior) {
      rejectUsage("usage_counter_regression", `${name} decreased within one counter epoch without an explicit native boundary.`);
    }
    return value ?? prior;
  });
}

function advanceModels(previous: ReadonlyMap<string, KnownCounts>, snapshot: AgentTokenUsageSnapshot): ReadonlyMap<string, KnownCounts> {
  const { attribution } = snapshot;
  const rows = attribution.kind === "model"
    ? [{ model: attribution.model, counters: snapshot.counters }]
    : attribution.kind === "mixed" ? attribution.rows : [];
  const complete = attribution.kind === "model" || (attribution.kind === "mixed" && attribution.rowCoverage === "complete");
  const present = new Set(rows.map((row) => modelKey(row.model)));
  if (complete) {
    for (const [key, counts] of previous) {
      if (!present.has(key) && Object.values(counts).some((count) => count !== null && count > 0)) {
        rejectUsage("usage_scope_mismatch", "A complete cumulative model partition cannot omit earlier attributed work.");
      }
    }
  }
  const next = new Map(previous);
  for (const row of rows) {
    const key = modelKey(row.model);
    next.set(key, advanceKnown(next.get(key) ?? NOTHING_KNOWN, row.counters));
  }
  if (next.size > AGENT_TOKEN_USAGE_LIMITS.modelRows) {
    rejectUsage("usage_capacity_exceeded", "The counter epoch exceeds its retained model capacity.");
  }
  for (const name of AGENT_TOKEN_USAGE_COUNTERS) {
    const total = snapshot.counters[name];
    if (total.kind !== "exact") continue;
    let retained = 0;
    for (const counts of next.values()) retained = checkedAdd(retained, counts[name] ?? 0);
    if (retained > total.value) rejectUsage("usage_counter_regression", "Retained model counts exceed the cumulative total.");
  }
  return next;
}

const sameOrigin = (left: EpochAccounting["origin"], right: EpochAccounting["origin"]): boolean =>
  left.kind === right.kind && left.cause === right.cause;

function applySnapshot(
  prior: SnapshotAccounting = { kind: "snapshot", epochs: [], unavailable: [] },
  measurement: AgentTokenUsageSnapshot | Extract<Measurement, { kind: "unavailable" }>,
): SnapshotAccounting {
  const latest = prior.epochs.at(-1);
  const earlier = prior.epochs.slice(0, -1);
  if (measurement.kind === "unavailable") {
    if (latest === undefined) {
      return { kind: "snapshot", epochs: [], unavailable: unionReasons(prior.unavailable, measurement.reasons) };
    }
    const stale = unionReasons(latest.stale, measurement.reasons);
    return { kind: "snapshot", epochs: [...earlier, { ...latest, stale }], unavailable: [] };
  }
  if (latest !== undefined && measurement.epoch === latest.epoch) {
    if (!sameOrigin(measurement.origin, latest.origin)) rejectUsage("usage_scope_mismatch", "A counter epoch cannot change its origin.");
    if (measurement.revision <= latest.revision) {
      rejectUsage("usage_sequence_invalid", "A snapshot revision must be newer than the latest admitted revision.");
    }
    const next: EpochAccounting = {
      ...latest,
      revision: measurement.revision,
      latest: measurement.counters,
      maxKnown: advanceKnown(latest.maxKnown, measurement.counters),
      comparable: mapCounters((name) => {
        const comparison = measurement.comparison[name];
        const baseline = latest.baselineComparison[name];
        return latest.comparable[name] && comparison.kind === "stable" && baseline.kind === "stable"
          && comparison.populationId === baseline.populationId;
      }),
      models: advanceModels(latest.models, measurement),
      attribution: measurement.attribution,
      stale: [],
    };
    return { kind: "snapshot", epochs: [...earlier, next], unavailable: [] };
  }
  if (measurement.epoch !== (latest === undefined ? 0 : latest.epoch + 1)) {
    rejectUsage("usage_sequence_invalid", "Snapshot epochs start at 0 and advance by one explicit native boundary.");
  }
  const epoch: EpochAccounting = {
    epoch: measurement.epoch,
    origin: measurement.origin,
    revision: measurement.revision,
    baseline: measurement.origin.kind === "fresh_zero" ? ZERO_COUNTERS : measurement.counters,
    baselineAttribution: measurement.attribution,
    baselineComparison: measurement.comparison,
    comparable: mapCounters((name) => measurement.comparison[name].kind === "stable"),
    latest: measurement.counters,
    maxKnown: advanceKnown(NOTHING_KNOWN, measurement.counters),
    models: advanceModels(new Map(), measurement),
    attribution: measurement.attribution,
    stale: [],
  };
  return { kind: "snapshot", epochs: [...prior.epochs, epoch], unavailable: [] };
}

/** Latest values, degraded to lower bounds while an unavailable revision leaves the epoch stale. */
function effectiveCounters(epoch: EpochAccounting): Counters {
  return mapCounters((name) => {
    const latest = epoch.latest[name];
    const maximum = epoch.maxKnown[name];
    if (latest.kind === "unavailable") {
      return maximum === null ? latest : lowerBound(maximum, latest.reasons, epoch.stale);
    }
    return epoch.stale.length === 0 ? latest : lowerBound(latest.value, reasonsOf(latest), epoch.stale);
  });
}

function sinceBaseline(current: Count, baseline: Count, epoch: EpochAccounting, comparable: boolean): Count {
  if (current.kind === "unavailable" || epoch.origin.kind === "fresh_zero") return current;
  if (epoch.origin.kind === "unknown") return { kind: "unavailable", reasons: ["origin_unknown"] };
  if (!comparable || baseline.kind !== "exact" || current.kind !== "exact") {
    return { kind: "unavailable", reasons: ["history_incomplete"] };
  }
  return { kind: "exact", value: current.value - baseline.value };
}

function epochContribution(epoch: EpochAccounting): ScopeContribution {
  const total = effectiveCounters(epoch);
  const newWork = mapCounters((name) => sinceBaseline(total[name], epoch.baseline[name], epoch, epoch.comparable[name]));
  assertSubsetsHold(total, "Effective snapshot");
  assertSubsetsHold(newWork, "New work since baseline");
  const fresh = epoch.origin.kind === "fresh_zero";
  const sameModel = epoch.baselineAttribution.kind === "model" && epoch.attribution.kind === "model"
    && modelKey(epoch.baselineAttribution.model) === modelKey(epoch.attribution.model);
  const attribution = aggregateAttribution(epoch.attribution);
  return {
    total,
    newWork,
    attribution,
    newWorkAttribution: fresh || sameModel ? attribution : UNKNOWN_ATTRIBUTION,
    disjoint: fresh,
  };
}

function snapshotContribution(state: SnapshotAccounting): ScopeContribution {
  const [first, ...rest] = state.epochs.map(epochContribution);
  if (first === undefined) {
    const none = unavailableCounters(state.unavailable);
    return { total: none, newWork: none, attribution: null, newWorkAttribution: null, disjoint: true };
  }
  return rest.reduce((sum, next) => {
    const total = combineCounters(sum.total, next.total, next.disjoint ? addCounts : overlapCounts);
    const newWork = combineCounters(sum.newWork, next.newWork, addCounts);
    return {
      total: mapCounters((name) => markDiscontinuous(total[name])),
      newWork: mapCounters((name) => markDiscontinuous(newWork[name])),
      attribution: combineAttribution(sum.attribution, next.attribution),
      newWorkAttribution: combineAttribution(sum.newWorkAttribution, next.newWorkAttribution),
      disjoint: sum.disjoint && next.disjoint,
    };
  }, first);
}

// ------------------------------------------------------------------------------------------------
//                Public Scope Operations
// ------------------------------------------------------------------------------------------------

export function applyScopeObservation(prior: ScopeAccounting | undefined, observation: AgentTokenUsageObservation): ScopeAccounting {
  const { measurement } = observation;
  if (observation.view.accounting === "delta") {
    if (measurement.kind === "snapshot") return rejectUsage("usage_invalid", "A delta view cannot admit a snapshot.");
    return applyDelta(prior?.kind === "delta" ? prior : undefined, measurement);
  }
  if (measurement.kind === "delta") return rejectUsage("usage_invalid", "A snapshot view cannot admit a delta.");
  return applySnapshot(prior?.kind === "snapshot" ? prior : undefined, measurement);
}

export function scopeContribution(accounting: ScopeAccounting): ScopeContribution {
  if (accounting.kind === "snapshot") return snapshotContribution(accounting);
  const { total, attribution } = accounting;
  return { total, newWork: total, attribution, newWorkAttribution: attribution, disjoint: true };
}

/** Sum of every known value a scope can contribute; it bounds every later fold of that scope. */
export function scopeMagnitude(accounting: ScopeAccounting): Readonly<Record<Counter, number>> {
  if (accounting.kind === "delta") return mapCounters((name) => knownValue(accounting.total[name]));
  const epochs = accounting.epochs.map(effectiveCounters);
  return mapCounters((name) => epochs.reduce((sum, counters) => checkedAdd(sum, knownValue(counters[name])), 0));
}
