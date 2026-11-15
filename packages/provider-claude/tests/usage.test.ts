import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAgentProviderKey, parseAgentSessionId, type AgentEvent, type AgentTokenUsageObservation, type AgentUsageViewId,
} from '@agen-ai/agent-protocol';
import { AgentProviderContractError, type AgentProviderSession } from '@agen-ai/agent-runtime';
import { admitTokenUsageEvent, createTokenUsageLedger, summarizeTokenUsageView, type AgentTokenUsageLedger } from '@agen-ai/agent-runtime/usage';
import { claudeCapabilities } from '../src/node/capabilities.js';
import { CLAUDE_QUERY_VIEW, CLAUDE_TURN_VIEW } from '../src/node/usage.js';
import { openValidatedSession, scriptedTools, startText } from './support/session.js';
import { launch } from './support/worker.js';

// Expected values are written out from the scripted SDK's native reports, never computed by the driver's mapping.
const exact = (value: number) => ({ kind: 'exact', value });
const atLeast = (value: number, ...reasons: string[]) => ({ kind: 'at_least', value, reasons });
const unavailable = (...reasons: string[]) => ({ kind: 'unavailable', reasons });
const UNSUPPORTED = unavailable('unsupported');
const counters = (input: unknown, cacheRead: unknown, cacheCreation: unknown, fiveMinute: unknown, oneHour: unknown, output: unknown) => ({
  inputTokens: input, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation, cacheCreationFiveMinuteInputTokens: fiveMinute,
  cacheCreationOneHourInputTokens: oneHour, outputTokens: output, reasoningOutputTokens: UNSUPPORTED, modelCalls: UNSUPPORTED, turns: UNSUPPORTED,
});
const COMPLETE = { kind: 'complete' };
const model = (modelId: string) => ({ kind: 'model', model: { modelId } });

type Usage = Readonly<{ view: string; measurement: unknown; observation: AgentTokenUsageObservation }>;
type Turn = Readonly<{ types: string[]; usage: Usage[]; completed: Extract<AgentEvent, { type: 'turn.completed' }> | undefined }>;

/** Reads one turn to its end, keeping every event type and each usage observation it carried. */
async function read(session: AgentProviderSession, turnId: string, during?: (event: AgentEvent) => void): Promise<Turn> {
  const types: string[] = [];
  const usage: Usage[] = [];
  let completed: Turn['completed'];
  for await (const output of startText(session, turnId).outputs) {
    if (output.kind !== 'event') continue;
    types.push(output.event.type);
    during?.(output.event);
    if (output.event.type === 'usage.observed') {
      const observation = output.event.payload;
      usage.push({ view: observation.view.viewId, measurement: observation.measurement, observation });
    }
    if (output.event.type === 'turn.completed') completed = output.event;
  }
  return { types, usage, completed };
}

async function open(t: test.TestContext, script: string) {
  const run = await launch(script);
  t.after(run.cleanup);
  const { worker } = await run.started;
  t.after(() => worker.close());
  const tools = scriptedTools(async (call) => ({ tool: call.tool as 'read', status: 'completed', text: 'notes', isError: false, changes: [] }));
  const session = await openValidatedSession({ worker, tools: tools.tools, model: script });
  t.after(() => session.close({ reason: 'idle' }));
  return session;
}

const snapshot = (revision: number, coverage: unknown, values: unknown, attribution: unknown) => {
  const stable = { kind: 'stable', populationId: 'query' };
  return { kind: 'snapshot', epoch: 0, revision, origin: { kind: 'fresh_zero', cause: 'initial' }, coverage, counters: values, attribution,
    comparison: { inputTokens: stable, cacheReadInputTokens: stable, cacheCreationInputTokens: stable, cacheCreationFiveMinuteInputTokens: stable,
      cacheCreationOneHourInputTokens: stable, outputTokens: stable, reasoningOutputTokens: { kind: 'unknown' }, modelCalls: { kind: 'unknown' },
      turns: { kind: 'unknown' } } };
};
const delta = (coverage: unknown, values: unknown) => ({ kind: 'delta', coverage, counters: values, attribution: { kind: 'unknown' } });
/** The comparison identity is the query scope's own nonce-bearing id; it is replaced by a fixed name for comparison. */
const measured = (usage: Usage[]) => usage.map(({ view, measurement }) => [view, JSON.parse(JSON.stringify(measurement).replace(/"claude-query:[0-9a-f]{16}"/gu, '"query"'))]);

function ledgerOf(turns: readonly Turn[]): AgentTokenUsageLedger {
  let ledger = createTokenUsageLedger({ sessionId: parseAgentSessionId('claude-session:1') });
  for (const { observation } of turns.flatMap((turn) => turn.usage)) {
    const admitted = admitTokenUsageEvent(ledger, { protocolVersion: 14, type: 'usage.observed', sessionId: parseAgentSessionId('claude-session:1'),
      turnId: observation.scope.kind === 'turn' ? observation.scope.turnId : 'turn-1', occurredAt: new Date(0).toISOString(), payload: observation } as never);
    assert.equal(admitted.status, 'recorded');
    if (admitted.status === 'recorded') ledger = admitted.ledger;
  }
  return ledger;
}

test('the capability declares exactly the qualified query snapshot and main-loop turn views', () => {
  const capability = claudeCapabilities(parseAgentProviderKey('claude')).tokenUsage;
  assert.equal(capability.kind, 'supported');
  assert.deepEqual(capability.kind === 'supported' && capability.views.map((entry) => [entry.view.viewId, entry.view.authority, entry.view.accounting,
    entry.scopeKind, entry.view.population, entry.view.countBasis, entry.reportedCounters.length, entry.attribution]), [
    ['claude-query-model-usage', 'authoritative', 'snapshot', 'materialization', { descendants: 'unknown', auxiliary: 'unknown' },
      { modelCalls: 'unsupported', turns: 'unsupported' }, 6, ['model', 'mixed']],
    ['claude-main-loop-turn', 'detail', 'delta', 'turn', { descendants: 'unknown', auxiliary: 'unknown' },
      { modelCalls: 'unsupported', turns: 'unsupported' }, 6, ['unknown']],
  ]);
});

test('two turns report cache-inclusive settled usage as one open query series and final per-turn details, never added together', async (t) => {
  const session = await open(t, 'usage-two-turn');
  const first = await read(session, 'turn-1');
  const second = await read(session, 'turn-2');
  assert.deepEqual(first.types.slice(-3), ['usage.observed', 'usage.observed', 'turn.completed']);
  assert.ok(first.types.indexOf('usage.observed') > first.types.lastIndexOf('content.delta'));
  assert.deepEqual(measured(first.usage), [
    ['claude-query-model-usage', snapshot(0, COMPLETE, counters(atLeast(1110, 'not_reported'), atLeast(100, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(1000, 'not_reported'), unavailable('not_reported'), exact(1)), model('usage-two-turn'))],
    ['claude-main-loop-turn', delta(COMPLETE, counters(atLeast(1110, 'not_reported'), atLeast(100, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(1000, 'not_reported'), unavailable('not_reported'), exact(1)))],
  ]);
  assert.deepEqual(measured(second.usage), [
    ['claude-query-model-usage', snapshot(1, COMPLETE, counters(atLeast(3330, 'not_reported'), atLeast(300, 'not_reported'), atLeast(3000, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(2000, 'not_reported'), exact(3)), model('usage-two-turn'))],
    ['claude-main-loop-turn', delta(COMPLETE, counters(atLeast(2220, 'not_reported'), atLeast(200, 'not_reported'), atLeast(2000, 'not_reported'), unavailable('not_reported'), atLeast(2000, 'not_reported'), exact(2)))],
  ]);
  const [query, turn] = [first.usage[0]!.observation, first.usage[1]!.observation];
  assert.deepEqual([query.scope.kind, query.finality, turn.scope.kind, turn.finality], ['materialization', 'open', 'turn', 'final']);
  assert.equal(second.usage[0]!.observation.scope.scopeId, query.scope.scopeId);
  assert.deepEqual(turn.scope, { scopeId: turn.scope.scopeId, kind: 'turn', turnId: 'turn-1', containedIn: query.scope.scopeId });
  const ledger = ledgerOf([first, second]);
  for (const view of [CLAUDE_QUERY_VIEW, CLAUDE_TURN_VIEW]) {
    const summary = summarizeTokenUsageView(ledger, view.viewId as AgentUsageViewId);
    assert.deepEqual([summary?.total.counters.inputTokens, summary?.total.counters.outputTokens], [atLeast(3330, 'not_reported'), exact(3)]);
  }
});

test('defaulted cache zeroes are unreported and later positive totals cannot recover omitted requests', async (t) => {
  const session = await open(t, 'usage-defaulted');
  const first = await read(session, 'turn-1');
  const second = await read(session, 'turn-2');
  const missing = unavailable('not_reported');
  assert.deepEqual(measured(first.usage), [
    ['claude-query-model-usage', snapshot(0, COMPLETE,
      counters(atLeast(100, 'not_reported'), missing, missing, missing, missing, exact(10)), model('usage-defaulted'))],
    ['claude-main-loop-turn', delta(COMPLETE, counters(atLeast(100, 'not_reported'), missing, missing, missing, missing, exact(10)))],
  ]);
  assert.deepEqual(measured(second.usage), [
    ['claude-query-model-usage', snapshot(1, COMPLETE, counters(atLeast(138, 'not_reported'), atLeast(5, 'not_reported'),
      atLeast(13, 'not_reported'), atLeast(6, 'not_reported'), atLeast(7, 'not_reported'), exact(12)), model('usage-defaulted'))],
    ['claude-main-loop-turn', delta(COMPLETE, counters(atLeast(38, 'not_reported'), atLeast(5, 'not_reported'),
      atLeast(13, 'not_reported'), atLeast(6, 'not_reported'), atLeast(7, 'not_reported'), exact(2)))],
  ]);
  const zero = await read(await open(t, 'usage-defaulted-zero'), 'turn-1');
  assert.deepEqual(measured(zero.usage), [
    ['claude-query-model-usage', snapshot(0, COMPLETE,
      counters(atLeast(0, 'not_reported'), missing, missing, missing, missing, exact(0)), model('usage-defaulted-zero'))],
    ['claude-main-loop-turn', delta(COMPLETE, counters(atLeast(0, 'not_reported'), missing, missing, missing, missing, exact(0)))],
  ]);
  const summary = summarizeTokenUsageView(ledgerOf([first, second]), CLAUDE_QUERY_VIEW.viewId as AgentUsageViewId);
  assert.deepEqual([summary?.total.counters.inputTokens, summary?.total.counters.outputTokens], [atLeast(138, 'not_reported'), exact(12)]);
});

test('one turn with two native requests and an auxiliary model reports the turn sum and a complete sorted model partition', async (t) => {
  const turn = await read(await open(t, 'usage-tool'), 'turn-1');
  assert.equal(turn.completed?.payload.outcome, 'completed');
  assert.ok(turn.types.includes('item.completed'));
  assert.deepEqual(measured(turn.usage), [
    ['claude-query-model-usage', snapshot(0, COMPLETE, counters(atLeast(43330, 'not_reported'), atLeast(300, 'not_reported'), atLeast(3000, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(2000, 'not_reported'), exact(403)), { kind: 'mixed', rowCoverage: 'complete', rows: [
      { model: { modelId: 'claude-auxiliary' }, counters: counters(atLeast(40000, 'not_reported'), unavailable('not_reported'), unavailable('not_reported'), unavailable('not_reported'), unavailable('not_reported'), exact(400)) },
      { model: { modelId: 'usage-tool' }, counters: counters(atLeast(3330, 'not_reported'), atLeast(300, 'not_reported'), atLeast(3000, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(2000, 'not_reported'), exact(3)) },
    ] })],
    ['claude-main-loop-turn', delta(COMPLETE, counters(atLeast(3330, 'not_reported'), atLeast(300, 'not_reported'), atLeast(3000, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(2000, 'not_reported'), exact(3)))],
  ]);
});

test('a zeroed native error result is unavailable, keeps earlier usage and leaves later cumulative reports as lower bounds', async (t) => {
  const session = await open(t, 'usage-error');
  const turns = [await read(session, 'turn-1'), await read(session, 'turn-2'), await read(session, 'turn-3')];
  assert.deepEqual(turns.map((turn) => turn.completed?.payload.outcome), ['completed', 'failed', 'completed']);
  assert.deepEqual(measured(turns[1]!.usage), [
    ['claude-query-model-usage', unavailable('native_result_incomplete')], ['claude-main-loop-turn', unavailable('native_result_incomplete')],
  ]);
  const lower = (value: number) => atLeast(value, 'not_reported', 'native_result_incomplete');
  assert.deepEqual(measured(turns[2]!.usage), [
    ['claude-query-model-usage', snapshot(2, { kind: 'partial', reasons: ['native_result_incomplete'] },
      counters(lower(3330), lower(300), lower(3000), lower(1000), lower(2000), atLeast(3, 'native_result_incomplete')), model('usage-error'))],
    ['claude-main-loop-turn', delta(COMPLETE, counters(atLeast(2220, 'not_reported'), atLeast(200, 'not_reported'), atLeast(2000, 'not_reported'), unavailable('not_reported'), atLeast(2000, 'not_reported'), exact(2)))],
  ]);
  const total = summarizeTokenUsageView(ledgerOf(turns), CLAUDE_QUERY_VIEW.viewId as AgentUsageViewId)?.total.counters.inputTokens;
  assert.deepEqual(total, lower(3330));
});

test('an interrupted turn reports partial usage, and the query series stays a lower bound afterwards', async (t) => {
  const session = await open(t, 'usage-interrupt');
  await read(session, 'turn-1');
  const interrupted = await read(session, 'turn-2', (event) => {
    if (event.type === 'content.delta' && session.interruption.kind === 'supported') void session.interruption.interruptTurn({ turnId: event.turnId, reason: 'user_requested' });
  });
  const later = await read(session, 'turn-3');
  assert.deepEqual([interrupted.completed?.payload.outcome, later.completed?.payload.outcome], ['canceled', 'completed']);
  const cut = (value: number) => atLeast(value, 'not_reported', 'native_result_incomplete', 'observation_interrupted');
  const partial = { kind: 'partial', reasons: ['native_result_incomplete', 'observation_interrupted'] };
  const unreported = unavailable('not_reported', 'native_result_incomplete', 'observation_interrupted');
  assert.deepEqual(measured(interrupted.usage), [
    ['claude-query-model-usage', snapshot(1, partial, counters(cut(1220), cut(200), cut(1000), cut(1000), unreported, atLeast(11, 'native_result_incomplete', 'observation_interrupted')), model('usage-interrupt'))],
    ['claude-main-loop-turn', delta(partial, counters(cut(110), cut(100), unreported, unreported, unreported, atLeast(10, 'native_result_incomplete', 'observation_interrupted')))],
  ]);
  assert.deepEqual(measured(later.usage), [
    ['claude-query-model-usage', snapshot(2, partial, counters(cut(3440), cut(400), cut(3000), cut(1000), cut(2000), atLeast(13, 'native_result_incomplete', 'observation_interrupted')), model('usage-interrupt'))],
    ['claude-main-loop-turn', delta(COMPLETE, counters(atLeast(2220, 'not_reported'), atLeast(200, 'not_reported'), atLeast(2000, 'not_reported'), unavailable('not_reported'), atLeast(2000, 'not_reported'), exact(2)))],
  ]);
});

test('worker loss after a result keeps the confirmed usage and reports the lost turn unavailable', async (t) => {
  const session = await open(t, 'usage-crash');
  const first = await read(session, 'turn-1');
  const lost = await read(session, 'turn-2');
  assert.equal(first.usage.length, 2);
  assert.deepEqual([lost.completed?.payload.outcome, lost.completed?.payload.outcome === 'failed' && lost.completed.payload.error.code], ['failed', 'claude_worker_failed']);
  assert.deepEqual(measured(lost.usage), [
    ['claude-query-model-usage', unavailable('observation_interrupted')], ['claude-main-loop-turn', unavailable('observation_interrupted')],
  ]);
  assert.deepEqual(lost.usage.map(({ observation }) => observation.finality), ['open', 'final']);
});

test('omitted retention categories and model usage stay unavailable or lower bounds', async (t) => {
  const turn = await read(await open(t, 'usage-unsplit'), 'turn-1');
  assert.deepEqual(measured(turn.usage), [
    ['claude-query-model-usage', snapshot(0, COMPLETE, counters(atLeast(1110, 'not_reported'), atLeast(100, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(600, 'not_reported'), unavailable('not_reported'),
      exact(1)), model('usage-unsplit'))],
    ['claude-main-loop-turn', delta(COMPLETE, counters(atLeast(1110, 'not_reported'), atLeast(100, 'not_reported'), atLeast(1000, 'not_reported'), unavailable('not_reported'), unavailable('not_reported'), exact(1)))],
  ]);
  const missing = await read(await open(t, 'text'), 'turn-1');
  assert.deepEqual(measured(missing.usage), [['claude-query-model-usage', unavailable('not_reported')], ['claude-main-loop-turn', unavailable('not_reported')]]);
});

for (const [script, code] of [['usage-invalid', 'usage_invalid'], ['usage-models', 'usage_capacity_exceeded'], ['usage-regression', 'usage_counter_regression']] as const) {
  test(`${script} fails the session as the ${code} contract error, keeping usage already delivered`, async (t) => {
    const session = await open(t, script);
    const delivered: string[] = [];
    if (script === 'usage-regression') delivered.push(...(await read(session, 'turn-1')).types.filter((type) => type === 'usage.observed'));
    await assert.rejects(read(session, 'turn-x', (event) => { delivered.push(event.type); }),
      (error: unknown) => error instanceof AgentProviderContractError && error.code === code);
    assert.equal(delivered.filter((type) => type === 'usage.observed').length, script === 'usage-regression' ? 2 : 0);
    assert.throws(() => startText(session, 'turn-y'));
  });
}

test('a reader that abandons the turn receives no usage and the session admits no further turn', async (t) => {
  const session = await open(t, 'usage-two-turn');
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const types: string[] = [];
  for (let next = await outputs.next(); !next.done; next = await outputs.next()) {
    if (next.value.kind !== 'event') continue;
    types.push(next.value.event.type);
    if (next.value.event.type === 'content.delta') break;
  }
  await outputs.return?.(undefined);
  assert.equal(types.includes('usage.observed'), false);
  assert.throws(() => startText(session, 'turn-2'));
});
