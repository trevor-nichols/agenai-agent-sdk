// ------------------------------------------------------------------------------------------------
//                usage.ts - Claude result usage as two non-additive views: query snapshots and turn details
// ------------------------------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import {
  AGENT_TOKEN_USAGE_GAP_REASONS, AGENT_TOKEN_USAGE_LIMITS, compareStringsByUnicodeCodePoint, safeParseAgentTokenUsageObservation,
  type AgentProviderKey, type AgentTokenCount, type AgentTokenUsageGapReason, type AgentTokenUsageObservation, type AgentTokenUsageReasons,
  type AgentTurnId,
} from '@agen-ai/agent-protocol';
import { sumDisjointTokenCounts, throwAgentProviderContractError } from '@agen-ai/agent-runtime';
import type { NativeCount, NativeModelUsage, NativeTurnUsage, WorkerMessage } from './protocol.js';

type Result = Extract<WorkerMessage, { type: 'result' }>;
type NativeCounters = Readonly<Record<'input' | 'cacheRead' | 'cacheCreation' | 'cache5m' | 'cache1h' | 'output', NativeCount>>;
type Known = Readonly<Record<keyof NativeCounters, number | null>>;
type Gap = AgentTokenUsageGapReason;

// Claude Code reports both views for every session; neither establishes descendant or auxiliary inclusion.
const POPULATION = Object.freeze({ descendants: 'unknown', auxiliary: 'unknown' } as const);
const COUNT_BASIS = Object.freeze({ modelCalls: 'unsupported', turns: 'unsupported' } as const);
/** Cumulative `modelUsage` of the session's one native query. */
export const CLAUDE_QUERY_VIEW = Object.freeze({
  viewId: 'claude-query-model-usage', authority: 'authoritative', accounting: 'snapshot', population: POPULATION, countBasis: COUNT_BASIS,
} as const);
/** Per-turn main-loop `usage`; contained in, and never added to, the query view. */
export const CLAUDE_TURN_VIEW = Object.freeze({
  viewId: 'claude-main-loop-turn', authority: 'detail', accounting: 'delta', population: POPULATION, countBasis: COUNT_BASIS,
} as const);
/** Thinking tokens are an approximate re-tokenization that Claude defaults to zero, so reasoning is never reported. */
export const CLAUDE_REPORTED_COUNTERS = Object.freeze([
  'inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'cacheCreationFiveMinuteInputTokens', 'cacheCreationOneHourInputTokens',
  'outputTokens',
] as const);
const UNREPORTED = ['reasoningOutputTokens', 'modelCalls', 'turns'] as const;
/** Results Claude ends between model responses, so their usage covers every request the turn made. */
const SETTLED_ERRORS = new Set(['error_max_turns', 'error_max_budget_usd']);
const UNSUPPORTED = Object.freeze({ kind: 'unavailable', reasons: ['unsupported'] } as const);

/** Canonical order; every caller holds at least one gap. */
function reasons(gaps: ReadonlySet<Gap>): AgentTokenUsageReasons {
  const [first, ...rest] = AGENT_TOKEN_USAGE_GAP_REASONS.filter((reason) => gaps.has(reason));
  if (first === undefined) throw new RangeError('An inexact usage measurement requires a reason.');
  return [first, ...rest];
}
const unavailable = (gaps: ReadonlySet<Gap>) => ({ kind: 'unavailable' as const, reasons: reasons(gaps) });
const coverage = (gaps: ReadonlySet<Gap>) => gaps.size === 0 ? { kind: 'complete' } : { kind: 'partial', reasons: reasons(gaps) };
const zeroed = (values: Known) => Object.values(values).every((value) => value === null || value === 0);

export class ClaudeUsage {
  private readonly nonce = randomBytes(8).toString('hex');
  private readonly queryScope = Object.freeze({ scopeId: `claude-query:${this.nonce}`, kind: 'materialization' });
  /** Reasons a later cumulative report may miss work: once Claude lost an earlier turn's accounting, it never regains it. */
  private readonly lost = new Set<Gap>();
  private observations = 0;
  private turns = 0;

  constructor(private readonly providerKey: AgentProviderKey) {}

  /**
   * The query snapshot, then this turn's main-loop detail, for one turn that reached Claude. A turn
   * without a result has unavailable usage; Claude's own invalid or over-capacity reports are contract failures.
   */
  observe(turnId: AgentTurnId, result: Result | undefined, interrupted: boolean): readonly AgentTokenUsageObservation[] {
    this.turns += 1;
    const turnScope = { scopeId: `claude-turn:${this.nonce}:${this.turns}`, kind: 'turn', turnId, containedIn: this.queryScope.scopeId };
    if (!result) {
      this.lost.add('observation_interrupted');
      const missing = unavailable(new Set(['observation_interrupted']));
      return [this.parse(CLAUDE_QUERY_VIEW, this.queryScope, missing, 'open'), this.parse(CLAUDE_TURN_VIEW, turnScope, missing, 'final')];
    }
    const gaps = new Set<Gap>();
    if (interrupted) gaps.add('observation_interrupted');
    if (result.isError && !SETTLED_ERRORS.has(result.subtype)) gaps.add('native_result_incomplete');
    const query = this.query(result, new Set([...this.lost, ...gaps]));
    for (const gap of gaps) this.lost.add(gap);
    return [this.parse(CLAUDE_QUERY_VIEW, this.queryScope, query, 'open'), this.parse(CLAUDE_TURN_VIEW, turnScope, this.turn(result, gaps), 'final')];
  }

  private query(result: Result, gaps: ReadonlySet<Gap>) {
    const models = this.models(result.modelUsage);
    if (result.resultIndex === 'invalid') this.reject('usage_invalid', 'Claude reported an invalid result index.');
    // Claude documents zeroed usage on crash and startup-error results; that is missing accounting, not zero work.
    if (result.isError && (models ?? []).every((entry) => zeroed(entry.values))) return unavailable(new Set([...gaps, 'native_result_incomplete']));
    if (!models || result.resultIndex === null) return unavailable(new Set([...gaps, 'not_reported']));
    const rows = models.map((entry) => ({ model: { modelId: entry.model }, counters: this.counters(entry.values, gaps) }));
    const attribution = rows.length === 1 ? { kind: 'model', model: rows[0]!.model }
      : { kind: 'mixed', rowCoverage: gaps.size === 0 ? 'complete' : 'partial', rows };
    const counters = Object.fromEntries([
      ...CLAUDE_REPORTED_COUNTERS.map((name) => [name, this.sum(rows.map((row) => row.counters[name]))]),
      ...UNREPORTED.map((name) => [name, UNSUPPORTED]),
    ]);
    const comparison = Object.fromEntries([
      ...CLAUDE_REPORTED_COUNTERS.map((name) => [name, { kind: 'stable', populationId: this.queryScope.scopeId }]),
      ...UNREPORTED.map((name) => [name, { kind: 'unknown' }]),
    ]);
    return { kind: 'snapshot', epoch: 0, revision: result.resultIndex, origin: { kind: 'fresh_zero', cause: 'initial' }, comparison,
      coverage: coverage(gaps), counters, attribution };
  }

  private turn(result: Result, gaps: ReadonlySet<Gap>) {
    const values = this.known(result.usage);
    if (result.isError && (!values || zeroed(values))) return unavailable(new Set([...gaps, 'native_result_incomplete']));
    if (!values) return unavailable(new Set([...gaps, 'not_reported']));
    return { kind: 'delta', coverage: coverage(gaps), counters: this.counters(values, gaps), attribution: { kind: 'unknown' } };
  }

  /** Sorted, bounded model rows; `undefined` when Claude reported none. */
  private models(usage: NativeModelUsage): Array<{ model: string; values: Known }> | undefined {
    if (usage === 'invalid') this.reject('usage_invalid', 'Claude reported an invalid model usage map.');
    if (usage === null || usage.entries === 0) return undefined;
    if (usage.entries > AGENT_TOKEN_USAGE_LIMITS.modelRows) this.reject('usage_capacity_exceeded', 'Claude reported more models than usage attribution holds.');
    return usage.models.map(({ model, ...counters }) => {
      if (model.length > AGENT_TOKEN_USAGE_LIMITS.identifierLength) this.reject('usage_capacity_exceeded', 'Claude reported an over-long model identifier.');
      return { model, values: this.known(counters)! };
    }).sort((left, right) => compareStringsByUnicodeCodePoint(left.model, right.model));
  }

  private known(usage: NativeTurnUsage | NativeCounters): Known | undefined {
    if (usage === 'invalid') this.reject('usage_invalid', 'Claude reported an invalid usage record.');
    if (usage === null) return undefined;
    if (Object.values(usage).includes('invalid')) this.reject('usage_invalid', 'Claude reported an invalid token count.');
    return usage as Known;
  }

  /**
   * Native buckets under the observation's gaps. Input adds Claude's exclusive uncached, cache-read and
   * cache-creation buckets once; output already includes thinking. Code defaults nullable API cache
   * counters and retention categories before summing them, so even positive totals can omit earlier requests.
   */
  private counters(values: Known, gaps: ReadonlySet<Gap>) {
    const count = (value: number | null): AgentTokenCount => value === null ? unavailable(new Set(['not_reported']))
      : gaps.size === 0 ? { kind: 'exact', value } : { kind: 'at_least', value, reasons: reasons(gaps) };
    const defaultedGaps = new Set<Gap>([...gaps, 'not_reported']);
    const defaulted = (value: number | null): AgentTokenCount => value === null || value === 0 ? unavailable(defaultedGaps)
      : { kind: 'at_least', value, reasons: reasons(defaultedGaps) };
    const cacheRead = defaulted(values.cacheRead);
    const cacheCreation = defaulted(values.cacheCreation);
    const split = (values.cache5m ?? 0) + (values.cache1h ?? 0);
    if (values.cacheCreation !== null && split > values.cacheCreation) {
      this.reject('usage_invalid', 'Claude reported more retention-categorized cache writes than cache creation.');
    }
    return {
      inputTokens: sumDisjointTokenCounts(this.providerKey, count(values.input), cacheRead, cacheCreation),
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
      cacheCreationFiveMinuteInputTokens: defaulted(values.cache5m),
      cacheCreationOneHourInputTokens: defaulted(values.cache1h),
      outputTokens: count(values.output),
      reasoningOutputTokens: UNSUPPORTED, modelCalls: UNSUPPORTED, turns: UNSUPPORTED,
    };
  }

  private sum(counts: readonly AgentTokenCount[]): AgentTokenCount {
    return counts.length === 1 ? counts[0]! : sumDisjointTokenCounts(this.providerKey, counts[0]!, ...counts.slice(1));
  }

  private parse(view: object, scope: object, measurement: object, finality: 'open' | 'final'): AgentTokenUsageObservation {
    this.observations += 1;
    const parsed = safeParseAgentTokenUsageObservation({ observationId: `claude-usage:${this.nonce}:${this.observations}`, view, scope, measurement, finality });
    if (!parsed.success) this.reject('usage_invalid', 'Claude reported usage outside the token-usage contract.');
    return parsed.data;
  }

  private reject(code: 'usage_invalid' | 'usage_capacity_exceeded', message: string): never {
    return throwAgentProviderContractError(this.providerKey, code, message);
  }
}
