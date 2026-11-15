// ------------------------------------------------------------------------------------------------
//                usage.test.ts - Agent14 token-usage observation and capability boundary coverage
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  AGENT_TOKEN_USAGE_COUNTERS,
  parseAgentTokenCount,
  parseAgentTokenUsageObservation,
  parseAgentUsageObservedEvent,
  safeParseAgentTokenCount,
  safeParseAgentTokenUsageCapability,
  safeParseAgentTokenUsageObservation,
  safeParseAgentUsageObservedEvent,
} from '../src/public/usage.js';
import { parseAgentEvent } from '../src/public/index.js';
import {
  AGENT_TOKEN_USAGE_CAPABILITY_JSON_SCHEMA,
  AGENT_TOKEN_USAGE_OBSERVATION_JSON_SCHEMA,
} from '../src/jsonSchema/generated.js';
import { eventFixtureCorpus, fixtureUsageView } from './fixtures.js';

// ------------------------------------------------------------------------------------------------
//                Fixture Builders
// ------------------------------------------------------------------------------------------------

const exact = (value: number) => ({ kind: 'exact', value });
const atLeast = (value: number, ...reasons: string[]) => ({ kind: 'at_least', value, reasons });
const unavailable = (...reasons: string[]) => ({ kind: 'unavailable', reasons });
const UNSUPPORTED = unavailable('unsupported');

const counters = (values: Readonly<Record<string, number | object>> = {}) => Object.fromEntries(
  AGENT_TOKEN_USAGE_COUNTERS.map((name) => {
    const value = values[name];
    return [name, typeof value === 'number' ? exact(value) : value ?? UNSUPPORTED];
  }),
);

const deltaView = { ...fixtureUsageView, viewId: 'usage-view:turn', accounting: 'delta' } as const;
const delta = (measurement: Readonly<Record<string, unknown>> = {}, overrides = {}) => ({
  observationId: 'usage:call-1',
  view: deltaView,
  scope: { scopeId: 'usage-scope:turn-1', kind: 'turn', turnId: 'turn:1' },
  measurement: {
    kind: 'delta',
    coverage: { kind: 'complete' },
    counters: counters({ inputTokens: 100, outputTokens: 10 }),
    attribution: { kind: 'model', model: { modelProvider: 'anthropic', modelId: 'model-x' } },
    ...measurement,
  },
  finality: 'open',
  ...overrides,
});

const rows = (...values: readonly (readonly [string, number])[]) => ({
  kind: 'mixed',
  rowCoverage: 'complete',
  rows: values.map(([modelId, inputTokens]) => ({
    model: { modelId },
    counters: counters({ inputTokens, outputTokens: 5 }),
  })),
});

const usageEvent = eventFixtureCorpus.find((event) => event.type === 'usage.observed');
assert.ok(usageEvent);
const snapshot = usageEvent.payload;
const partial = { kind: 'partial', reasons: ['not_reported'] };

// ------------------------------------------------------------------------------------------------
//                Observations
// ------------------------------------------------------------------------------------------------

test('usage observations round-trip with inclusive totals, typed subsets and explicit missingness', () => {
  const observation = delta({
    counters: counters({
      inputTokens: 1_000,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 100,
      cacheCreationFiveMinuteInputTokens: atLeast(60, 'not_reported'),
      outputTokens: 27,
      reasoningOutputTokens: unavailable('not_reported'),
    }),
  });
  assert.deepEqual(parseAgentTokenUsageObservation(observation), observation);
  assert.deepEqual(parseAgentTokenUsageObservation(snapshot), snapshot);
  const missing = { ...delta(), measurement: { kind: 'unavailable', reasons: ['native_result_incomplete'] } };
  assert.deepEqual(parseAgentTokenUsageObservation(missing), missing);
  const detail = delta({}, {
    view: { ...deltaView, authority: 'detail' },
    scope: { scopeId: 'usage-scope:turn-1', kind: 'turn', turnId: 'turn:1', containedIn: 'usage-scope:query' },
  });
  assert.deepEqual(parseAgentTokenUsageObservation(detail), detail);
});

test('token counts admit only closed precision and canonical reasons', () => {
  for (const count of [exact(0), atLeast(7, 'not_reported', 'history_incomplete'), UNSUPPORTED])
    assert.deepEqual(parseAgentTokenCount(count), count);
  for (const count of [
    exact(-1),
    exact(Number.MAX_SAFE_INTEGER + 1),
    atLeast(1, 'unsupported'),
    atLeast(1),
    unavailable('history_incomplete', 'not_reported'),
    unavailable('unsupported', 'not_reported'),
    { kind: 'exact', value: 1, reasons: ['not_reported'] },
  ]) assert.equal(safeParseAgentTokenCount(count).success, false, JSON.stringify(count));
});

test('usage observations reject states the closed contract cannot represent', () => {
  const countedBasis = { ...deltaView, countBasis: { modelCalls: 'observed', turns: 'observed' } };
  const cases: readonly [string, unknown][] = [
    ['exact under partial coverage', delta({ coverage: partial })],
    ['exact model row under partial coverage', delta({
      coverage: partial,
      counters: counters({ inputTokens: atLeast(100, 'not_reported'), outputTokens: atLeast(10, 'not_reported') }),
      attribution: rows(['model-a', 50], ['model-b', 50]),
    })],
    ['unsupported lower bound', delta({ counters: counters({ inputTokens: atLeast(1, 'unsupported') }) })],
    ['unsupported beside another reason', delta({ counters: counters({ inputTokens: unavailable('unsupported', 'not_reported') }) })],
    ['noncanonical reasons', delta({ counters: counters({ inputTokens: atLeast(1, 'origin_unknown', 'not_reported') }) })],
    ['repeated reasons', delta({ counters: counters({ inputTokens: atLeast(1, 'not_reported', 'not_reported') }) })],
    ['empty reasons', delta({ counters: counters({ inputTokens: unavailable() }) })],
    ['negative value', delta({ counters: counters({ inputTokens: -1 }) })],
    ['fractional value', delta({ counters: counters({ inputTokens: 1.5 }) })],
    ['unsafe value', delta({ counters: counters({ inputTokens: 2 ** 53 }) })],
    ['missing counter', delta({ counters: { ...counters(), turns: undefined } })],
    ['cache buckets above input', delta({ counters: counters({ inputTokens: 100, cacheReadInputTokens: 60, cacheCreationInputTokens: 41 }) })],
    ['retention buckets above cache creation', delta({ counters: counters({
      inputTokens: 100, cacheCreationInputTokens: 10,
      cacheCreationFiveMinuteInputTokens: 6, cacheCreationOneHourInputTokens: 5,
    }) })],
    ['reasoning above output', delta({ counters: counters({ outputTokens: 7, reasoningOutputTokens: 8 }) })],
    ['supported basis claiming unsupported', delta({}, { view: countedBasis })],
    ['unsupported basis carrying a count', delta({ counters: counters({ inputTokens: 1, modelCalls: 1 }) })],
    ['model row carrying entered turns', delta({
      counters: counters({ inputTokens: 100, outputTokens: 10, modelCalls: 1, turns: 1 }),
      attribution: { kind: 'mixed', rowCoverage: 'partial', rows: [{
        model: { modelId: 'model-a' },
        counters: counters({ inputTokens: 1, modelCalls: 1, turns: 1 }),
      }] },
    }, { view: countedBasis })],
    ['single-row complete partition', delta({ attribution: rows(['model-a', 100]) })],
    ['unsorted model rows', delta({ attribution: rows(['model-b', 50], ['model-a', 50]) })],
    ['repeated model rows', delta({ attribution: rows(['model-a', 50], ['model-a', 50]) })],
    ['complete exact rows not summing to total', delta({ attribution: rows(['model-a', 70], ['model-b', 20]) })],
    ['row lower bounds above total', delta({
      attribution: { kind: 'mixed', rowCoverage: 'partial', rows: [{ model: { modelId: 'model-a' }, counters: counters({ inputTokens: 101 }) }] },
    })],
    ['snapshot in a delta view', { ...snapshot, view: deltaView }],
    ['delta in a snapshot view', delta({}, { view: fixtureUsageView })],
    ['later epoch with the initial cause', { ...snapshot, measurement: { ...snapshot.measurement, epoch: 1 } }],
    ['epoch zero with a native boundary', {
      ...snapshot,
      measurement: { ...snapshot.measurement, origin: { kind: 'fresh_zero', cause: 'native_reset' } },
    }],
    ['container on an authoritative scope', delta({}, {
      scope: { scopeId: 'usage-scope:turn-1', kind: 'turn', turnId: 'turn:1', containedIn: 'usage-scope:query' },
    })],
    ['detail scope containing itself', delta({}, {
      view: { ...deltaView, authority: 'detail' },
      scope: { scopeId: 'usage-scope:turn-1', kind: 'turn', turnId: 'turn:1', containedIn: 'usage-scope:turn-1' },
    })],
    ['turn scope without an SDK turn', delta({}, { scope: { scopeId: 'usage-scope:turn-1', kind: 'turn' } })],
    ['session scope naming a turn', delta({}, { scope: { scopeId: 'usage-scope:session', kind: 'session', turnId: 'turn:1' } })],
    ['epoch beyond the per-scope bound', {
      ...snapshot,
      measurement: { ...snapshot.measurement, epoch: 16, origin: { kind: 'fresh_zero', cause: 'native_reset' } },
    }],
    ['nine model rows', delta({
      coverage: partial,
      counters: counters({ inputTokens: atLeast(9, 'not_reported') }),
      attribution: { kind: 'mixed', rowCoverage: 'partial', rows: Array.from({ length: 9 }, (_, index) => ({
        model: { modelId: `model-${index}` }, counters: counters({ inputTokens: atLeast(1, 'not_reported') }),
      })) },
    })],
    ['overlong usage identity', delta({}, { observationId: 'u'.repeat(129) })],
    ['native payload bag', { ...delta(), raw: { usage: {} } }],
  ];
  for (const [name, candidate] of cases) {
    assert.equal(safeParseAgentTokenUsageObservation(candidate).success, false, name);
  }
});

test('usage.observed is an Agent14 turn event whose envelope turn is only the delivery position', () => {
  const delivered = { ...usageEvent, turnId: 'turn:delivery-b' };
  assert.deepEqual(parseAgentUsageObservedEvent(delivered), delivered);
  assert.deepEqual(parseAgentEvent(delivered), delivered);
  assert.equal(safeParseAgentUsageObservedEvent({ ...usageEvent, protocolVersion: 13 }).success, false);
  assert.equal(safeParseAgentUsageObservedEvent({ ...usageEvent, turnId: undefined }).success, false);
  const contextEvent = eventFixtureCorpus.find((event) => event.type === 'context.usage.updated');
  assert.equal(safeParseAgentUsageObservedEvent(contextEvent).success, false);
  assert.equal(safeParseAgentUsageObservedEvent({
    ...usageEvent,
    payload: { ...snapshot, measurement: { ...snapshot.measurement, coverage: partial } },
  }).success, false);
});

// ------------------------------------------------------------------------------------------------
//                Capability
// ------------------------------------------------------------------------------------------------

test('token usage capabilities bind views to scope kinds, reported counters and attribution kinds', () => {
  const view = (viewId: string, authority = 'detail', countBasis: object = deltaView.countBasis) => ({
    view: { ...deltaView, viewId, authority, countBasis },
    scopeKind: 'turn',
    reportedCounters: ['inputTokens', 'outputTokens'],
    attribution: ['model', 'unknown'],
  });
  const supported = { kind: 'supported', views: [view('a', 'authoritative'), view('b')] };
  assert.deepEqual(safeParseAgentTokenUsageCapability(supported), { success: true, data: supported });
  assert.equal(safeParseAgentTokenUsageCapability({ kind: 'unsupported' }).success, true);

  const counted = { modelCalls: 'provider_reported', turns: 'unsupported' } as const;
  const invalid: readonly [string, unknown][] = [
    ['no views', { kind: 'supported', views: [] }],
    ['five views', { kind: 'supported', views: ['a', 'b', 'c', 'd', 'e'].map((id) => view(id)) }],
    ['two authoritative views', { kind: 'supported', views: [view('a', 'authoritative'), view('b', 'authoritative')] }],
    ['repeated view', { kind: 'supported', views: [view('a'), view('a')] }],
    ['noncanonical counters', { kind: 'supported', views: [{ ...view('a'), reportedCounters: ['outputTokens', 'inputTokens'] }] }],
    ['noncanonical attribution', { kind: 'supported', views: [{ ...view('a'), attribution: ['unknown', 'model'] }] }],
    ['supported basis without its counter', { kind: 'supported', views: [view('a', 'detail', counted)] }],
    ['listed counter without a basis', {
      kind: 'supported', views: [{ ...view('a'), reportedCounters: ['inputTokens', 'modelCalls'] }],
    }],
  ];
  for (const [name, candidate] of invalid) {
    assert.equal(safeParseAgentTokenUsageCapability(candidate).success, false, name);
  }
  assert.equal(safeParseAgentTokenUsageCapability({
    kind: 'supported', views: [{ ...view('a', 'detail', counted), reportedCounters: ['inputTokens', 'modelCalls'] }],
  }).success, true);
});

// ------------------------------------------------------------------------------------------------
//                Portable JSON Schema
// ------------------------------------------------------------------------------------------------

test('portable usage JSON Schemas accept parser output and leave declared invariants to the parser', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTuples: false, validateFormats: false });
  const validateObservation = ajv.compile(AGENT_TOKEN_USAGE_OBSERVATION_JSON_SCHEMA.schema);
  const validateCapability = ajv.compile(AGENT_TOKEN_USAGE_CAPABILITY_JSON_SCHEMA.schema);
  assert.equal(validateObservation(snapshot), true);
  assert.equal(validateObservation(delta()), true);
  assert.equal(validateObservation({ ...delta(), raw: {} }), false);
  assert.equal(validateObservation(delta({}, { observationId: 'u'.repeat(129) })), false);

  const parserOnly = delta({ coverage: partial });
  assert.equal(validateObservation(parserOnly), true);
  assert.equal(safeParseAgentTokenUsageObservation(parserOnly).success, false);
  assert.ok(AGENT_TOKEN_USAGE_OBSERVATION_JSON_SCHEMA.parserInvariants.includes('usage_exact_requires_complete_coverage'));

  assert.equal(validateCapability({ kind: 'unsupported' }), true);
  assert.equal(validateCapability({ kind: 'supported', views: [] }), false);
});
