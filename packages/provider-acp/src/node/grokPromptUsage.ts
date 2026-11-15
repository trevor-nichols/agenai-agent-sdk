// ------------------------------------------------------------------------------------------------
//                grokPromptUsage.ts - Controlled Grok 1.0.77 whole-prompt usage from its own prompt response
// ------------------------------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import type { AcpJsonObject, AcpJsonValue, AcpResponseReceived } from '@agen-ai/acp-transport';
import {
  AGENT_TOKEN_USAGE_COUNTERS, AGENT_TOKEN_USAGE_LIMITS, compareStringsByUnicodeCodePoint, safeParseAgentTokenUsageObservation,
  type AgentProviderKey, type AgentTokenCount, type AgentTokenUsageCounterName, type AgentTokenUsageObservation, type AgentTurnId,
} from '@agen-ai/agent-protocol';
import { throwAgentProviderContractError } from '@agen-ai/agent-runtime';

/**
 * One delta per entered SDK turn from the `session/prompt` response's `_meta.usage` (native `PromptUsage`).
 * Native `modelCalls` is provider-reported; the SDK turn is the adapter's own observation, never native
 * `numTurns`. Neither the pinned documentation nor the two-prompt source run qualifies descendant or
 * side-model inclusion, so both remain unknown.
 */
export const CONTROLLED_GROK_PROMPT_VIEW = Object.freeze({
  viewId: 'grok-prompt-usage', authority: 'authoritative', accounting: 'delta',
  population: Object.freeze({ descendants: 'unknown', auxiliary: 'unknown' }),
  countBasis: Object.freeze({ modelCalls: 'provider_reported', turns: 'observed' }),
} as const);
/** Native retention categories do not exist on this route. */
export const CONTROLLED_GROK_REPORTED_COUNTERS = Object.freeze([
  'inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'reasoningOutputTokens', 'modelCalls', 'turns',
] as const);

/**
 * Native field of each provider-reported counter. ACP `inputTokens` already includes cached input and
 * `outputTokens` already includes reasoning, so no bucket is added to another.
 */
const NATIVE_FIELDS = Object.freeze([
  ['inputTokens', 'inputTokens'], ['cacheReadInputTokens', 'cachedReadTokens'], ['cacheCreationInputTokens', 'cacheCreationTokens'],
  ['outputTokens', 'outputTokens'], ['reasoningOutputTokens', 'reasoningTokens'], ['modelCalls', 'modelCalls'],
] as const);
type NativeCounter = (typeof NATIVE_FIELDS)[number][0];
type NativeValues = Readonly<Partial<Record<NativeCounter, number>>>;
type Row = Readonly<{ model: string; values: NativeValues }>;
type UsageCode = 'usage_invalid' | 'usage_identity_conflict' | 'usage_scope_mismatch' | 'usage_capacity_exceeded';

/** Native prompt identities retained per session; equal to the runtime's turn-scope bound. */
const MAX_PROMPT_IDENTITIES = 1_024;
const UNSUPPORTED = Object.freeze({ kind: 'unavailable', reasons: ['unsupported'] } as const);
const isObject = (value: AcpJsonValue | undefined): value is AcpJsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (reason: 'not_reported' | 'native_result_incomplete') => ({ kind: 'unavailable', reasons: [reason] } as const);

export class ControlledGrokPromptUsage {
  private readonly nonce = randomBytes(8).toString('hex');
  private readonly promptIds = new Set<string>();
  private prompts = 0;

  constructor(private readonly providerKey: AgentProviderKey, private readonly nativeSessionId: string) {}

  /**
   * The final observation of one entered SDK turn, judged from that turn's own prompt response. A
   * failed prompt keeps its failure and reports unavailable usage: the native error data carrying
   * `promptUsage` is unobserved on this route and is never normalized.
   */
  observe(turnId: AgentTurnId, response: AcpResponseReceived): AgentTokenUsageObservation {
    this.prompts += 1;
    const measurement = response.kind === 'error' ? missing('native_result_incomplete') : this.measure(response.result);
    const parsed = safeParseAgentTokenUsageObservation({
      observationId: `grok-usage:${this.nonce}:${this.prompts}`, view: CONTROLLED_GROK_PROMPT_VIEW,
      scope: { scopeId: `grok-prompt:${this.nonce}:${this.prompts}`, kind: 'turn', turnId }, measurement, finality: 'final',
    });
    if (!parsed.success) this.reject('usage_invalid', 'Grok reported prompt usage outside the token-usage contract.');
    return parsed.data;
  }

  /** Only `_meta.usage` is authoritative; sibling `_meta` scalars and notifications are never counted. */
  private measure(result: AcpJsonValue) {
    const meta = isObject(result) ? result._meta : undefined;
    if (meta === undefined || meta === null) return missing('not_reported');
    if (!isObject(meta)) this.reject('usage_invalid', 'Grok returned invalid prompt response metadata.');
    if (meta.sessionId !== undefined && meta.sessionId !== this.nativeSessionId) {
      this.reject('usage_scope_mismatch', 'Grok reported prompt usage for another native session.');
    }
    this.admitPromptId(meta.promptId);
    const usage = meta.usage;
    if (usage === undefined || usage === null) return missing('not_reported');
    if (!isObject(usage)) this.reject('usage_invalid', 'Grok reported an invalid prompt usage record.');
    const incomplete = usage.usageIsIncomplete === undefined ? false : usage.usageIsIncomplete;
    if (typeof incomplete !== 'boolean') this.reject('usage_invalid', 'Grok reported an invalid usage completeness flag.');
    const totals = this.values(usage, incomplete);
    const rows = this.rows(usage.modelUsage, incomplete);
    const known = [totals, ...rows.map((row) => row.values)].flatMap((values) => Object.values(values));
    // Grok marks lost token coverage with the flag alone; zeros beside it are not measurements.
    if (incomplete && known.every((value) => value === 0)) return missing('native_result_incomplete');
    if (known.length === 0) return missing('not_reported');
    const gaps = incomplete ? 'native_result_incomplete' : undefined;
    return { kind: 'delta', coverage: gaps ? { kind: 'partial', reasons: [gaps] } : { kind: 'complete' },
      counters: this.counters(totals, gaps, true), attribution: this.attribution(totals, rows, gaps) };
  }

  /** Grok mints one prompt identity per turn; reuse by a later prompt contradicts native ownership. */
  private admitPromptId(value: AcpJsonValue | undefined): void {
    if (value === undefined) return;
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) this.reject('usage_invalid', 'Grok reported an invalid prompt identity.');
    if (this.promptIds.has(value)) this.reject('usage_identity_conflict', 'Grok reported one native prompt identity for two SDK turns.');
    if (this.promptIds.size >= MAX_PROMPT_IDENTITIES) this.reject('usage_capacity_exceeded', 'Grok prompt identities exceed usage accounting capacity.');
    this.promptIds.add(value);
  }

  /**
   * Present native counters as safe non-negative integers. A complete record's `totalTokens` must equal
   * inclusive input plus output; an incomplete record's scalars are not comparable.
   */
  private values(record: AcpJsonObject, incomplete: boolean): NativeValues {
    const count = (value: AcpJsonValue | undefined): number | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) this.reject('usage_invalid', 'Grok reported an invalid token count.');
      return value;
    };
    const values: Partial<Record<NativeCounter, number>> = {};
    for (const [name, field] of NATIVE_FIELDS) {
      const value = count(record[field]);
      if (value !== undefined) values[name] = value;
    }
    const total = count(record.totalTokens);
    if (!incomplete && total !== undefined && values.inputTokens !== undefined && values.outputTokens !== undefined
      && total !== values.inputTokens + values.outputTokens) {
      this.reject('usage_invalid', 'Grok reported a total that differs from inclusive input plus output.');
    }
    return values;
  }

  /** Native model keys exactly as reported, sorted; the configured model never names unattributed work. */
  private rows(value: AcpJsonValue | undefined, incomplete: boolean): readonly Row[] {
    if (value === undefined || value === null) return [];
    if (!isObject(value)) this.reject('usage_invalid', 'Grok reported an invalid model usage map.');
    const entries = Object.entries(value);
    if (entries.length > AGENT_TOKEN_USAGE_LIMITS.modelRows) this.reject('usage_capacity_exceeded', 'Grok reported more models than usage attribution holds.');
    return entries.map(([model, row]) => {
      if (model.length > AGENT_TOKEN_USAGE_LIMITS.identifierLength) this.reject('usage_capacity_exceeded', 'Grok reported an over-long model identifier.');
      if (!isObject(row)) this.reject('usage_invalid', 'Grok reported an invalid model usage row.');
      return { model, values: this.values(row, incomplete) };
    }).sort((left, right) => compareStringsByUnicodeCodePoint(left.model, right.model));
  }

  /**
   * One row naming every complete counter of the aggregate is a single-model attribution; several such
   * rows are a complete partition. Narrower, incomplete or non-comparable rows stay a partial view.
   */
  private attribution(totals: NativeValues, rows: readonly Row[], gaps: 'native_result_incomplete' | undefined) {
    if (rows.length === 0) return { kind: 'unknown' };
    const partition = gaps === undefined && NATIVE_FIELDS.every(([name]) => {
      const total = totals[name];
      if (total === undefined || rows.some((row) => row.values[name] === undefined)) return false;
      return rows.reduce((sum, row) => sum + row.values[name]!, 0) === total;
    });
    if (partition && rows.length === 1) return { kind: 'model', model: { modelId: rows[0]!.model } };
    return { kind: 'mixed', rowCoverage: partition ? 'complete' : 'partial',
      rows: rows.map((row) => ({ model: { modelId: row.model }, counters: this.counters(row.values, gaps, false) })) };
  }

  /** Model rows cannot count SDK turns; the aggregate's one entered turn is the adapter's own observation. */
  private counters(values: NativeValues, gaps: 'native_result_incomplete' | undefined, aggregate: boolean) {
    const count = (value: number | undefined): AgentTokenCount => {
      if (value === undefined) return { kind: 'unavailable', reasons: gaps ? ['not_reported', gaps] : ['not_reported'] };
      return gaps ? { kind: 'at_least', value, reasons: [gaps] } : { kind: 'exact', value };
    };
    const counters: Partial<Record<AgentTokenUsageCounterName, AgentTokenCount>> = {};
    for (const name of AGENT_TOKEN_USAGE_COUNTERS) counters[name] = UNSUPPORTED;
    for (const [name] of NATIVE_FIELDS) counters[name] = count(values[name]);
    if (aggregate) counters.turns = count(1);
    return counters;
  }

  private reject(code: UsageCode, message: string): never {
    return throwAgentProviderContractError(this.providerKey, code, message);
  }
}
