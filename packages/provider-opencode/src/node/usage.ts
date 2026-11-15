// ------------------------------------------------------------------------------------------------
//                usage.ts - OpenCode token usage as two non-additive views: session snapshots and model steps
// ------------------------------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import {
  AGENT_TOKEN_USAGE_COUNTERS, AGENT_TOKEN_USAGE_GAP_REASONS, safeParseAgentTokenUsageObservation,
  type AgentProviderKey, type AgentTokenCount, type AgentTokenUsageCounterName, type AgentTokenUsageGapReason,
  type AgentTokenUsageObservation, type AgentTokenUsageReasons, type AgentTurnId,
} from '@agen-ai/agent-protocol';
import {
  createTokenUsagePendingBuffer, sumDisjointTokenCounts, throwAgentProviderContractError,
  type AgentTokenUsageDelivery, type AgentTokenUsagePendingBuffer,
} from '@agen-ai/agent-runtime';
import type { NodeOpenCodeModelProvider } from '../index.js';
import { nativeUsage, type NativeEvent, type NativeModel, type NativeTokens, type NativeUsage } from './native-events.js';

export type UsageEvent = Extract<NativeEvent, { kind: 'session_usage' | 'step_started' | 'step_ended' | 'step_failed' }>;
const USAGE_EVENTS: ReadonlySet<NativeEvent['kind']> = new Set(['session_usage', 'step_started', 'step_ended', 'step_failed']);
export const isUsageEvent = (event: NativeEvent): event is UsageEvent => USAGE_EVENTS.has(event.kind);
type Gap = AgentTokenUsageGapReason;
type UsageCode = 'usage_invalid' | 'usage_identity_conflict' | 'usage_scope_mismatch' | 'usage_counter_regression'
  | 'usage_sequence_invalid' | 'usage_capacity_exceeded';
type Step = Readonly<{ model: NativeModel; state: 'started' } | { model: NativeModel; state: 'ended'; tokens: NativeTokens }
  | { model: NativeModel; state: 'failed'; tokens: NativeTokens | null }>;
export type OpenCodeTurnOutcome = 'succeeded' | 'interrupted' | 'failed' | 'lost';

// OpenCode session totals include whatever its projector records; descendant and auxiliary inclusion stay unknown.
const POPULATION = Object.freeze({ descendants: 'unknown', auxiliary: 'unknown' } as const);
const COUNT_BASIS = Object.freeze({ modelCalls: 'unsupported', turns: 'unsupported' } as const);
/** OpenCode's own cumulative session tokens, from `session.usage.updated` and session readback. */
export const OPENCODE_SESSION_VIEW = Object.freeze({
  viewId: 'opencode-session-usage', authority: 'authoritative', accounting: 'snapshot', population: POPULATION, countBasis: COUNT_BASIS,
} as const);
/** One delta per native model step of an SDK turn; contained in, and never added to, the session view. */
export const OPENCODE_STEP_VIEW = Object.freeze({
  viewId: 'opencode-model-steps', authority: 'detail', accounting: 'delta', population: POPULATION, countBasis: COUNT_BASIS,
} as const);
/**
 * Both route parsers accept absent usage; OpenCode defaults every absent bucket to zero. The route
 * still determines which counters can be observed: Anthropic reasoning and OpenAI cache writes are unsupported.
 */
export const OPENCODE_REPORTED_COUNTERS = Object.freeze({
  anthropic: Object.freeze(['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens'] as const),
  openai: Object.freeze(['inputTokens', 'cacheReadInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const),
});
/** Step identities retained for the session; a further step is a capacity failure, never an eviction. */
const MAX_SESSION_STEPS = 1_024;
const UNSUPPORTED = Object.freeze({ kind: 'unavailable', reasons: ['unsupported'] } as const);
const ZERO: NativeTokens = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
const BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const;

/** Canonical order; every caller holds at least one gap. */
function reasons(gaps: ReadonlySet<Gap>): AgentTokenUsageReasons {
  const [first, ...rest] = AGENT_TOKEN_USAGE_GAP_REASONS.filter((reason) => gaps.has(reason));
  if (first === undefined) throw new RangeError('An inexact usage measurement requires a reason.');
  return [first, ...rest];
}
const unavailable = (gaps: ReadonlySet<Gap>) => ({ kind: 'unavailable' as const, reasons: reasons(gaps) });
const coverage = (gaps: ReadonlySet<Gap>) => gaps.size === 0 ? { kind: 'complete' } : { kind: 'partial', reasons: reasons(gaps) };
const covers = (upper: NativeTokens, lower: NativeTokens) => BUCKETS.every((bucket) => upper[bucket] >= lower[bucket]);
const same = (left: NativeTokens | null, right: NativeTokens | null) => left === right
  || (left !== null && right !== null && covers(left, right) && covers(right, left));

export class OpenCodeUsage {
  private readonly nonce = randomBytes(8).toString('hex');
  private readonly sessionScope = Object.freeze({ scopeId: `opencode-session:${this.nonce}`, kind: 'session' });
  private readonly reported: ReadonlySet<AgentTokenUsageCounterName>;
  /** Reasons later session totals may miss work: once a step's usage went unrecorded, it never returns. */
  private readonly lost = new Set<Gap>();
  private readonly stepIds = new Set<string>();
  private readonly queued: AgentTokenUsagePendingBuffer;
  /** Highest native report; a fresh session starts every bucket at zero. */
  private latest = ZERO;
  private streamed = ZERO;
  private observed = false;
  private emitted: string | undefined;
  private revision = -1;
  private observations = 0;
  private turns = 0;
  private turn: { turnId: AgentTurnId; steps: Map<string, Step>; settled: boolean } | undefined;

  constructor(private readonly providerKey: AgentProviderKey, private readonly route: NodeOpenCodeModelProvider, private readonly model: string) {
    this.reported = new Set(OPENCODE_REPORTED_COUNTERS[route]);
    this.queued = createTokenUsagePendingBuffer({ providerKey });
  }

  /**
   * Accounts one native usage event at arrival. Returns `false` for a step on another model, which is
   * configuration drift rather than usage; invalid, conflicting or over-capacity usage throws.
   */
  admit(event: UsageEvent): boolean {
    switch (event.kind) {
      case 'session_usage': this.sessionEvent(event.tokens); return true;
      case 'step_started':
        if (event.model.providerID !== this.route || event.model.id !== this.model) return false;
        this.stepStarted(event.messageID, event.model);
        return true;
      case 'step_ended': this.settleStep(event.messageID, 'ended', this.valid(event.tokens, 'OpenCode ended a model step with invalid usage.')); return true;
      case 'step_failed':
        this.settleStep(event.messageID, 'failed', event.tokens === null ? null : this.valid(event.tokens, 'OpenCode failed a model step with invalid usage.'));
        return true;
    }
  }

  /**
   * One streamed session total. Streamed totals never decrease. A total at or below one already
   * read back is stale, and one that neither covers nor trails it contradicts native accounting.
   */
  private sessionEvent(tokens: NativeUsage): void {
    const usage = this.valid(tokens, 'OpenCode streamed invalid session usage.');
    if (!covers(usage, this.streamed)) this.reject('usage_counter_regression', 'OpenCode session usage decreased.');
    this.streamed = usage;
    this.observed = true;
    if (!covers(this.latest, usage)) {
      if (!covers(usage, this.latest)) this.reject('usage_counter_regression', 'OpenCode session usage contradicted its readback.');
      this.latest = usage;
    }
    if (!this.turn || this.turn.settled) this.checkpoint();
  }

  /** Immutable minimum known before dispatch; later streamed updates may overtake the response. */
  readbackBaseline(): NativeTokens { return this.latest; }

  rejectReadback(code: 'usage_invalid' | 'usage_capacity_exceeded'): never {
    return this.reject(code, 'OpenCode returned an invalid or oversized session readback.');
  }

  /**
   * One `session.get` readback of this session. It may have been read before a total that streamed
   * meanwhile. It must cover everything known before dispatch, and be comparable with any later update.
   */
  readback(sessionID: string, session: unknown, baseline: NativeTokens): void {
    if (session === null || typeof session !== 'object') this.reject('usage_invalid', 'OpenCode read back an invalid session.');
    const record = session as Record<string, unknown>;
    if (record.id !== sessionID) this.reject('usage_scope_mismatch', 'OpenCode read back usage for another session.');
    const usage = this.valid(nativeUsage(record.tokens), 'OpenCode read back invalid session usage.');
    if (!covers(usage, baseline)) this.reject('usage_counter_regression', 'OpenCode session readback decreased below its dispatch baseline.');
    this.observed = true;
    if (covers(this.latest, usage)) return;
    if (!covers(usage, this.latest)) this.reject('usage_counter_regression', 'OpenCode session readback contradicted its streamed usage.');
    this.latest = usage;
  }

  beginTurn(turnId: AgentTurnId): void {
    this.turn = { turnId, steps: new Map(), settled: false };
  }

  /** Keep settled identities until the original reader has delivered its terminal event. */
  finishTurn(turnId: AgentTurnId): void {
    if (this.turn?.turnId === turnId) this.turn = undefined;
  }

  private stepStarted(messageID: string, model: NativeModel): void {
    const steps = this.steps();
    const step = steps.get(messageID);
    if (step) {
      if (step.state === 'started' && step.model.id === model.id && step.model.providerID === model.providerID) return;
      this.reject('usage_identity_conflict', 'OpenCode started one model step twice.');
    }
    if (this.stepIds.has(messageID)) this.reject('usage_identity_conflict', 'OpenCode reused a model step across turns.');
    if (this.turn?.settled) this.reject('usage_sequence_invalid', 'OpenCode started a model step after turn accounting settled.');
    if (this.stepIds.size >= MAX_SESSION_STEPS) this.reject('usage_capacity_exceeded', 'OpenCode ran more model steps than usage accounting holds.');
    this.stepIds.add(messageID);
    steps.set(messageID, Object.freeze({ model, state: 'started' }));
  }

  /** Opening, between-turn and late checkpoints retain their original order and shared delivery bounds. */
  pending(delivery: AgentTokenUsageDelivery) {
    return this.queued.drain(delivery);
  }

  /** Active-turn SSE and readback reconcile into one settlement checkpoint; idle updates retain each distinct total. */
  private checkpoint(): void {
    const key = JSON.stringify([this.latest, [...this.lost].sort()]);
    if (!this.observed || key === this.emitted) return;
    this.emitted = key;
    this.revision += 1;
    const gaps: ReadonlySet<Gap> = this.lost;
    const comparison = Object.fromEntries(AGENT_TOKEN_USAGE_COUNTERS.map((name) => [name, this.reported.has(name)
      ? { kind: 'stable', populationId: this.sessionScope.scopeId } : { kind: 'unknown' }]));
    this.queued.retain(this.parse(OPENCODE_SESSION_VIEW, this.sessionScope, {
      kind: 'snapshot', epoch: 0, revision: this.revision, origin: { kind: 'fresh_zero', cause: 'initial' }, comparison,
      coverage: coverage(gaps), counters: this.counters(this.latest, gaps), attribution: { kind: 'unknown' },
    }, 'open'));
  }

  /** Ends the turn: the session snapshot, then one final-closed delta sequence of its model steps. */
  settle(outcome: OpenCodeTurnOutcome): readonly AgentTokenUsageObservation[] {
    const turn = this.turn;
    if (!turn) return [];
    turn.settled = true;
    const steps = [...turn.steps.values()];
    if (steps.some((step) => step.state === 'started') || outcome === 'interrupted' || outcome === 'lost') this.lost.add('observation_interrupted');
    if (steps.some((step) => step.state === 'failed') || outcome === 'failed') this.lost.add('native_result_incomplete');
    this.turns += 1;
    const scope = { scopeId: `opencode-turn:${this.nonce}:${this.turns}`, kind: 'turn', turnId: turn.turnId, containedIn: this.sessionScope.scopeId };
    const measurements = steps.map((step) => this.step(step));
    if (outcome !== 'succeeded' || steps.length === 0) {
      measurements.push(unavailable(new Set([outcome === 'succeeded' ? 'not_reported' : outcome === 'failed' ? 'native_result_incomplete' : 'observation_interrupted'])));
    }
    this.checkpoint();
    return measurements.map((measurement, index) => this.parse(OPENCODE_STEP_VIEW, scope, measurement,
      index === measurements.length - 1 ? 'final' : 'open'));
  }

  /** Ends a turn without observations; unless OpenCode never received its prompt, its work can no longer be accounted. */
  abandon(turnId: AgentTurnId, unprompted = false): void {
    if (this.turn?.turnId !== turnId) return;
    this.turn = undefined;
    if (!unprompted) this.lost.add('observation_interrupted');
  }

  private settleStep(messageID: string, state: 'ended' | 'failed', tokens: NativeTokens | null): void {
    const step = this.steps().get(messageID);
    if (!step) this.reject('usage_sequence_invalid', 'OpenCode settled a model step it never started.');
    if (step.state !== 'started') {
      if (step.state === state && same(step.tokens, tokens)) return;
      this.reject('usage_identity_conflict', 'OpenCode settled one model step twice.');
    }
    if (this.turn?.settled) this.reject('usage_sequence_invalid', 'OpenCode settled new model work after turn accounting settled.');
    this.steps().set(messageID, Object.freeze(state === 'ended' ? { model: step.model, state, tokens: tokens! } : { model: step.model, state, tokens }));
  }

  private steps(): Map<string, Step> {
    if (!this.turn) this.reject('usage_sequence_invalid', 'OpenCode reported a model step outside a turn.');
    return this.turn.steps;
  }

  private step(step: Step) {
    if (step.state === 'started') return unavailable(new Set(['observation_interrupted']));
    if (step.tokens === null) return unavailable(new Set(['native_result_incomplete']));
    const gaps = new Set<Gap>(step.state === 'failed' ? ['native_result_incomplete'] : []);
    return { kind: 'delta', coverage: coverage(gaps), counters: this.counters(step.tokens, gaps),
      attribution: { kind: 'model', model: { modelProvider: step.model.providerID, modelId: step.model.id } } };
  }

  /**
   * Input and output add disjoint native buckets once. Both route parsers accept missing usage; Lq
   * projects absence to zero before session accumulation, so positive totals can still omit earlier steps.
   */
  private counters(tokens: NativeTokens, gaps: ReadonlySet<Gap>) {
    const defaultedGaps = new Set<Gap>([...gaps, 'not_reported']);
    const count = (value: number): AgentTokenCount => value === 0 ? unavailable(defaultedGaps)
      : { kind: 'at_least', value, reasons: reasons(defaultedGaps) };
    const values: Partial<Record<AgentTokenUsageCounterName, AgentTokenCount>> = {
      inputTokens: sumDisjointTokenCounts(this.providerKey, count(tokens.input), count(tokens.cacheRead), count(tokens.cacheWrite)),
      cacheReadInputTokens: count(tokens.cacheRead),
      cacheCreationInputTokens: count(tokens.cacheWrite),
      outputTokens: sumDisjointTokenCounts(this.providerKey, count(tokens.output), count(tokens.reasoning)),
      reasoningOutputTokens: count(tokens.reasoning),
    };
    return Object.fromEntries(AGENT_TOKEN_USAGE_COUNTERS.map((name) => [name, this.reported.has(name) ? values[name] : UNSUPPORTED]));
  }

  private valid(tokens: NativeUsage, message: string): NativeTokens {
    if (tokens === 'invalid') this.reject('usage_invalid', message);
    return tokens;
  }

  private parse(view: object, scope: object, measurement: object, finality: 'open' | 'final'): AgentTokenUsageObservation {
    this.observations += 1;
    const parsed = safeParseAgentTokenUsageObservation({ observationId: `opencode-usage:${this.nonce}:${this.observations}`, view, scope, measurement, finality });
    if (!parsed.success) this.reject('usage_invalid', 'OpenCode reported usage outside the token-usage contract.');
    return parsed.data;
  }

  private reject(code: UsageCode, message: string): never {
    return throwAgentProviderContractError(this.providerKey, code, message);
  }
}
