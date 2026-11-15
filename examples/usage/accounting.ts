import { parseAgentProviderKey, parseAgentSessionId } from '@agen-ai/agent-protocol';
import type { AgentTokenUsageCounterName, AgentUsageObservedEvent } from '@agen-ai/agent-protocol/usage';
import {
  admitTokenUsageEvent, createTokenUsageLedger, sumDisjointTokenCounts, summarizeTokenUsageView,
  type AgentTokenUsageAdmission, type AgentTokenUsageAmount, type AgentTokenUsageLedger,
} from '@agen-ai/agent-runtime/usage';
import {
  atLeast, callScope, delta, exact, notMeasured, observed, snapshot, tokens, turnScope, unavailable, VIEWS,
} from './observations.js';

const sessionId = parseAgentSessionId('usage-example:session');
const INPUT_OUTPUT = ['inputTokens', 'outputTokens'] as const;

type Admitted = Readonly<{ ledger: AgentTokenUsageLedger; statuses: readonly string[] }>;

function admitAll(events: readonly AgentUsageObservedEvent[], start = createTokenUsageLedger({ sessionId })): Admitted {
  let ledger = start;
  const statuses: string[] = [];
  for (const event of events) {
    const admission = admitTokenUsageEvent(ledger, event);
    if (admission.status === 'rejected') throw new Error(`${admission.code}: ${admission.message}`);
    statuses.push(admission.status);
    ledger = admission.ledger;
  }
  return { ledger, statuses };
}

const disposition = (admission: AgentTokenUsageAdmission) => admission.status === 'rejected' ? admission.code : admission.status;

/** Reports only the selected counters; each keeps its exact, at_least or unavailable precision. */
function counts(amount: AgentTokenUsageAmount, names: readonly AgentTokenUsageCounterName[] = INPUT_OUTPUT) {
  return Object.fromEntries(names.map((name) => [name, amount.counters[name]]));
}

function summary(ledger: AgentTokenUsageLedger, event: AgentUsageObservedEvent) {
  const view = summarizeTokenUsageView(ledger, event.payload.view.viewId);
  if (view === undefined) throw new Error(`No observation was admitted for ${event.payload.view.viewId}.`);
  return view;
}

function noMeasurement() {
  const missing = observed(sessionId, 'turn-1', notMeasured('turn-1:usage', turnScope('turn-1'), ['not_reported']));
  const silent = summarizeTokenUsageView(createTokenUsageLedger({ sessionId }), missing.payload.view.viewId);
  const view = summary(admitAll([missing]).ledger, missing);
  return { scenario: 'no_measurement', withoutObservation: silent === undefined ? 'no_summary' : 'summary',
    explicit: { scopeCount: view.scopeCount, total: counts(view.total) } };
}

function inclusiveSubdivisions() {
  const providerKey = parseAgentProviderKey('usage-example');
  // The native source reports disjoint uncached and cache-read buckets; inputTokens is their inclusive total.
  const inputTokens = sumDisjointTokenCounts(providerKey, exact(200), exact(800));
  const event = observed(sessionId, 'turn-1', delta('turn-1:usage', VIEWS.turn, turnScope('turn-1'), tokens(inputTokens, exact(50), {
    cacheReadInputTokens: exact(800), cacheCreationInputTokens: unavailable('not_reported'),
    reasoningOutputTokens: unavailable('not_reported'),
  })));
  const view = summary(admitAll([event]).ledger, event);
  return { scenario: 'inclusive_subdivisions', total: counts(view.total,
    ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'reasoningOutputTokens']) };
}

function partialReasoning() {
  const event = observed(sessionId, 'turn-1', delta('turn-1:usage', VIEWS.turn, turnScope('turn-1'),
    tokens(exact(10), exact(100), { reasoningOutputTokens: atLeast(7, 'native_result_incomplete') })));
  const view = summary(admitAll([event]).ledger, event);
  return { scenario: 'partial_reasoning', total: counts(view.total, ['outputTokens', 'reasoningOutputTokens']) };
}

function stableHistoryAndReplay() {
  const baseline = observed(sessionId, 'turn-1', snapshot('session:0', 0, tokens(exact(400), exact(40)), { origin: 'historical' }));
  const current = observed(sessionId, 'turn-1', snapshot('session:1', 1, tokens(exact(600), exact(60)), { origin: 'historical' }));
  const history = admitAll([baseline, current]);
  const before = summary(history.ledger, current);
  // A later delivery of the identical record, e.g. after reconnecting, is a replay rather than new work.
  const replay = admitTokenUsageEvent(history.ledger, observed(sessionId, 'turn-2', current.payload));
  const conflict = admitTokenUsageEvent(history.ledger,
    observed(sessionId, 'turn-2', snapshot('session:1', 2, tokens(exact(700), exact(70)), { origin: 'historical' })));
  const after = summary(replay.status === 'rejected' ? history.ledger : replay.ledger, current);
  return [
    { scenario: 'stable_history', admissions: history.statuses, total: counts(before.total), newWork: counts(before.newWork) },
    { scenario: 'duplicate_replay', replay: replay.status,
      sameLedger: replay.status !== 'rejected' && replay.ledger === history.ledger,
      changedContent: disposition(conflict), total: counts(after.total), newWork: counts(after.newWork) },
  ];
}

function unknownBaseline() {
  const origin = [0, 1].map((revision) => observed(sessionId, 'turn-1',
    snapshot(`origin:${revision}`, revision, tokens(exact(400 + 200 * revision), exact(40 + 20 * revision)), { origin: 'unknown' })));
  const comparison = [
    observed(sessionId, 'turn-1', snapshot('population:0', 0, tokens(exact(400), exact(40)), { origin: 'historical' })),
    observed(sessionId, 'turn-1', snapshot('population:1', 1, tokens(exact(600), exact(60)),
      { origin: 'historical', unknownComparison: ['inputTokens'] })),
  ];
  const unknownOrigin = summary(admitAll(origin).ledger, origin[0]!);
  const changedPopulation = summary(admitAll(comparison).ledger, comparison[0]!);
  return { scenario: 'unknown_baseline',
    unknownOrigin: { total: counts(unknownOrigin.total), newWork: counts(unknownOrigin.newWork) },
    unknownComparison: { total: counts(changedPopulation.total), newWork: counts(changedPopulation.newWork) } };
}

function historicalBackfill() {
  const partial = { kind: 'partial', reasons: ['history_incomplete'] } as const;
  const events = [
    observed(sessionId, 'turn-1', snapshot('backfill:0', 0,
      tokens(atLeast(400, 'history_incomplete'), atLeast(40, 'history_incomplete')), { origin: 'historical', coverage: partial })),
    observed(sessionId, 'turn-1', snapshot('backfill:1', 1, tokens(exact(1000), exact(100)), { origin: 'historical' })),
  ];
  const view = summary(admitAll(events).ledger, events[0]!);
  return { scenario: 'historical_backfill', total: counts(view.total), newWork: counts(view.newWork) };
}

function continuingCheckpoints() {
  const checkpoint = (revision: number, deliveryTurnId: string, input: number, finality: 'open' | 'final') =>
    observed(sessionId, deliveryTurnId, snapshot(`series:${revision}`, revision, tokens(exact(input), exact(input / 10)),
      { origin: 'fresh_zero', finality }));
  const events = [checkpoint(0, 'turn-1', 100, 'open'), checkpoint(1, 'turn-2', 300, 'open'), checkpoint(2, 'turn-2', 300, 'final')];
  const series = admitAll(events);
  const view = summary(series.ledger, events[0]!);
  return { scenario: 'continuing_checkpoints', deliveries: events.map((event) => [event.turnId, event.payload.finality]),
    scopeCount: view.scopeCount, total: counts(view.total), newWork: counts(view.newWork),
    afterFinal: disposition(admitTokenUsageEvent(series.ledger, checkpoint(3, 'turn-3', 400, 'open'))) };
}

function parentAndChild() {
  const parent = observed(sessionId, 'turn-1', delta('turn-1:usage', VIEWS.turn, turnScope('turn-1'), tokens(exact(1000), exact(100))));
  const child = observed(sessionId, 'turn-1', delta('call-1:usage', VIEWS.calls, callScope('1', 'turn-1'), tokens(exact(300), exact(30))));
  const { ledger } = admitAll([parent, child]);
  return { scenario: 'parent_and_child', authoritative: counts(summary(ledger, parent).total), detail: counts(summary(ledger, child).total) };
}

function equalDeltas() {
  const call = (id: string) => observed(sessionId, 'turn-1', delta(`call-${id}:usage`, VIEWS.calls, callScope(id, 'turn-1'),
    tokens(exact(200), exact(20))));
  const events = [call('a'), call('b')];
  const view = summary(admitAll(events).ledger, events[0]!);
  return { scenario: 'equal_deltas', scopeCount: view.scopeCount, total: counts(view.total) };
}

export function runAccountingScenarios() {
  return [noMeasurement(), inclusiveSubdivisions(), partialReasoning(), ...stableHistoryAndReplay(), unknownBaseline(),
    historicalBackfill(), continuingCheckpoints(), parentAndChild(), equalDeltas()];
}
