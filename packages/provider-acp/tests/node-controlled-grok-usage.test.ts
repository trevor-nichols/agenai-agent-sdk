import assert from 'node:assert/strict';
import test from 'node:test';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import {
  agentText, controlledUsagePeer, NATIVE_SESSION_ID, notification, outcomeOf, promptUsage, readTurn, startText, usageOf,
} from './node-fixtures/controlled-grok-usage.js';

const exact = (value: number) => ({ kind: 'exact', value });
const atLeast = (value: number) => ({ kind: 'at_least', value, reasons: ['native_result_incomplete'] });
const unavailable = (...reasons: string[]) => ({ kind: 'unavailable', reasons });
const UNSUPPORTED = unavailable('unsupported');
const counters = (input: object, cacheRead: object, cacheCreation: object, output: object, reasoning: object, modelCalls: object, turns: object) => ({
  inputTokens: input, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation,
  cacheCreationFiveMinuteInputTokens: UNSUPPORTED, cacheCreationOneHourInputTokens: UNSUPPORTED,
  outputTokens: output, reasoningOutputTokens: reasoning, modelCalls, turns,
});
const COMPLETE = { kind: 'complete' };
const ended = (meta?: AcpJsonObject): { result: AcpJsonObject } => ({ result: { stopReason: 'end_turn', ...(meta ? { _meta: meta } : {}) } });

async function onePrompt(t: test.TestContext, reply: { result: AcpJsonObject }) {
  const peer = await controlledUsagePeer(t, [{ before: [agentText('ok')], reply }]);
  const events = await readTurn(startText(peer.session, 'turn:usage'));
  assert.deepEqual(outcomeOf(events), [reply.result.stopReason === 'max_tokens' ? 'completed: The agent reached its token limit.' : 'completed']);
  const [usage, ...extra] = usageOf(events);
  assert.equal(extra.length, 0);
  return usage!.measurement;
}

test('each controlled prompt reports one final whole-prompt delta from its response, before completion', async (t) => {
  const first = { inputTokens: 1629, cachedReadTokens: 512, cacheCreationTokens: 0, outputTokens: 26, reasoningTokens: 25, totalTokens: 1655, modelCalls: 1 };
  const second = { inputTokens: 1689, cachedReadTokens: 1536, cacheCreationTokens: 0, outputTokens: 20, reasoningTokens: 19, totalTokens: 1709, modelCalls: 1 };
  const shadow = notification('_x.ai/session_notification', { sessionUpdate: 'turn_completed', stop_reason: 'end_turn',
    usage: promptUsage({ inputTokens: 9_000, outputTokens: 900, totalTokens: 9_900, modelCalls: 7 }) });
  const peer = await controlledUsagePeer(t, [
    { before: [agentText('first'), shadow], reply: ended({ sessionId: NATIVE_SESSION_ID, promptId: 'prompt-1', requestId: 'prompt-1',
      inputTokens: 1629, outputTokens: 26, totalTokens: 1662,
      usage: promptUsage({ ...first, numTurns: 1, modelUsage: { 'grok-native-model': promptUsage(first) } }) }) },
    { before: [agentText('second'), shadow], reply: ended({ sessionId: NATIVE_SESSION_ID, promptId: 'prompt-2', totalTokens: 1717,
      usage: promptUsage({ ...second, numTurns: 1, modelUsage: { 'grok-native-model': promptUsage(second) } }) }) },
  ]);
  assert.equal(peer.capabilities.tokenUsage.kind, 'supported');
  const one = await readTurn(startText(peer.session, 'turn:one'));
  const two = await readTurn(startText(peer.session, 'turn:two'));

  assert.deepEqual(one.slice(-3).map((event) => event.type), ['usage.observed', 'item.completed', 'turn.completed']);
  assert.deepEqual(two.slice(-3).map((event) => event.type), ['usage.observed', 'item.completed', 'turn.completed']);
  const [a] = usageOf(one);
  const [b] = usageOf(two);
  assert.deepEqual(a!.view, { viewId: 'grok-prompt-usage', authority: 'authoritative', accounting: 'delta',
    population: { descendants: 'unknown', auxiliary: 'unknown' }, countBasis: { modelCalls: 'provider_reported', turns: 'observed' } });
  assert.deepEqual([a!.scope.kind, a!.scope.kind === 'turn' && a!.scope.turnId, a!.finality], ['turn', 'turn:one', 'final']);
  assert.deepEqual([b!.scope.kind === 'turn' && b!.scope.turnId, b!.finality], ['turn:two', 'final']);
  assert.notEqual(a!.observationId, b!.observationId);
  assert.notEqual(a!.scope.scopeId, b!.scope.scopeId);
  assert.deepEqual(a!.measurement, { kind: 'delta', coverage: COMPLETE,
    counters: counters(exact(1629), exact(512), exact(0), exact(26), exact(25), exact(1), exact(1)),
    attribution: { kind: 'model', model: { modelId: 'grok-native-model' } } });
  assert.deepEqual(b!.measurement, { kind: 'delta', coverage: COMPLETE,
    counters: counters(exact(1689), exact(1536), exact(0), exact(20), exact(19), exact(1), exact(1)),
    attribution: { kind: 'model', model: { modelId: 'grok-native-model' } } });
});

test('identical independent prompts remain two distinct observations', async (t) => {
  const usage = promptUsage({ inputTokens: 40, cachedReadTokens: 0, cacheCreationTokens: 0, outputTokens: 2, reasoningTokens: 1, totalTokens: 42, modelCalls: 1 });
  const peer = await controlledUsagePeer(t, [{ reply: ended({ usage }) }, { reply: ended({ usage }) }]);
  const [a] = usageOf(await readTurn(startText(peer.session, 'turn:a')));
  const [b] = usageOf(await readTurn(startText(peer.session, 'turn:b')));
  assert.notEqual(a!.observationId, b!.observationId);
  assert.deepEqual(a!.measurement, b!.measurement);
});

test('missing, partial, and zero native usage stay honest without changing the outcome', async (t) => {
  const notReported = { kind: 'unavailable', reasons: ['not_reported'] };
  assert.deepEqual(await onePrompt(t, ended()), notReported);
  assert.deepEqual(await onePrompt(t, ended({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })), notReported);
  assert.deepEqual(await onePrompt(t, ended({ usage: promptUsage({ inputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0,
    outputTokens: 0, reasoningTokens: 0, totalTokens: 0, modelCalls: 0 }) })), { kind: 'delta', coverage: COMPLETE,
    counters: counters(exact(0), exact(0), exact(0), exact(0), exact(0), exact(0), exact(1)), attribution: { kind: 'unknown' } });
  assert.deepEqual(await onePrompt(t, ended({ usage: promptUsage({ inputTokens: 100, outputTokens: 10 }) })), { kind: 'delta', coverage: COMPLETE,
    counters: counters(exact(100), unavailable('not_reported'), unavailable('not_reported'), exact(10), unavailable('not_reported'),
      unavailable('not_reported'), exact(1)), attribution: { kind: 'unknown' } });
  assert.deepEqual(await onePrompt(t, { result: { stopReason: 'max_tokens', _meta: { usage: promptUsage({ inputTokens: 7, outputTokens: 3,
    costIsPartial: true }) } } }), { kind: 'delta', coverage: COMPLETE,
    counters: counters(exact(7), unavailable('not_reported'), unavailable('not_reported'), exact(3), unavailable('not_reported'),
      unavailable('not_reported'), exact(1)), attribution: { kind: 'unknown' } });
});

test('incomplete native usage becomes lower bounds, or unavailable when nothing was recorded', async (t) => {
  const recorded = { inputTokens: 300, cachedReadTokens: 100, outputTokens: 20, reasoningTokens: 5, modelCalls: 1 };
  assert.deepEqual(await onePrompt(t, ended({ usage: promptUsage({ ...recorded, usageIsIncomplete: true,
    modelUsage: { 'grok-native-model': promptUsage(recorded) } }) })), {
    kind: 'delta', coverage: { kind: 'partial', reasons: ['native_result_incomplete'] },
    counters: counters(atLeast(300), atLeast(100), unavailable('not_reported', 'native_result_incomplete'), atLeast(20), atLeast(5),
      atLeast(1), atLeast(1)),
    attribution: { kind: 'mixed', rowCoverage: 'partial', rows: [{ model: { modelId: 'grok-native-model' },
      counters: counters(atLeast(300), atLeast(100), unavailable('not_reported', 'native_result_incomplete'), atLeast(20), atLeast(5),
        atLeast(1), UNSUPPORTED) }] },
  });
  const nothing = { kind: 'unavailable', reasons: ['native_result_incomplete'] };
  assert.deepEqual(await onePrompt(t, ended({ usage: promptUsage({ usageIsIncomplete: true }) })), nothing);
  assert.deepEqual(await onePrompt(t, ended({ usage: promptUsage({ usageIsIncomplete: true, inputTokens: 0, outputTokens: 0,
    totalTokens: 0, modelCalls: 0 }) })), nothing);
});

test('per-model rows claim a complete partition only when they sum exactly to the aggregate', async (t) => {
  const full = { inputTokens: 1000, cachedReadTokens: 400, cacheCreationTokens: 0, outputTokens: 50, reasoningTokens: 30, totalTokens: 1050, modelCalls: 3 };
  const z = { inputTokens: 600, cachedReadTokens: 300, cacheCreationTokens: 0, outputTokens: 20, reasoningTokens: 10, totalTokens: 620, modelCalls: 1 };
  const a = { inputTokens: 400, cachedReadTokens: 100, cacheCreationTokens: 0, outputTokens: 30, reasoningTokens: 20, totalTokens: 430, modelCalls: 2 };
  const aggregate = counters(exact(1000), exact(400), exact(0), exact(50), exact(30), exact(3), exact(1));
  const row = (model: string, v: typeof a) => ({ model: { modelId: model }, counters: counters(exact(v.inputTokens), exact(v.cachedReadTokens),
    exact(v.cacheCreationTokens), exact(v.outputTokens), exact(v.reasoningTokens), exact(v.modelCalls), UNSUPPORTED) });

  assert.deepEqual(await onePrompt(t, ended({ usage: promptUsage({ ...full, modelUsage: { 'grok-z': promptUsage(z), 'grok-a': promptUsage(a) } }) })),
    { kind: 'delta', coverage: COMPLETE, counters: aggregate,
      attribution: { kind: 'mixed', rowCoverage: 'complete', rows: [row('grok-a', a), row('grok-z', z)] } });
  assert.deepEqual(await onePrompt(t, ended({ usage: promptUsage({ ...full, modelUsage: { 'grok-z': promptUsage(z) } }) })),
    { kind: 'delta', coverage: COMPLETE, counters: aggregate, attribution: { kind: 'mixed', rowCoverage: 'partial', rows: [row('grok-z', z)] } });
  const { modelCalls: _omitted, ...withoutCalls } = full;
  assert.deepEqual(await onePrompt(t, ended({ usage: promptUsage({ ...full, modelUsage: { 'grok-z': promptUsage(withoutCalls) } }) })),
    { kind: 'delta', coverage: COMPLETE, counters: aggregate, attribution: { kind: 'mixed', rowCoverage: 'partial', rows: [{
      model: { modelId: 'grok-z' }, counters: counters(exact(1000), exact(400), exact(0), exact(50), exact(30), unavailable('not_reported'), UNSUPPORTED),
    }] } });
});

test('model-only usage preserves reported rows without inventing aggregate counters', async (t) => {
  for (const incomplete of [false, true]) {
    const absent = incomplete ? unavailable('not_reported', 'native_result_incomplete') : unavailable('not_reported');
    const count = incomplete ? atLeast : exact;
    assert.deepEqual(await onePrompt(t, ended({ usage: promptUsage({ usageIsIncomplete: incomplete,
      modelUsage: { 'native-model': { inputTokens: 300, outputTokens: 20, modelCalls: 1 } } }) })), {
      kind: 'delta', coverage: incomplete ? { kind: 'partial', reasons: ['native_result_incomplete'] } : COMPLETE,
      counters: counters(absent, absent, absent, absent, absent, absent, count(1)),
      attribution: { kind: 'mixed', rowCoverage: 'partial', rows: [{ model: { modelId: 'native-model' },
        counters: counters(count(300), absent, absent, count(20), absent, count(1), UNSUPPORTED) }] },
    });
  }
});

test('context occupancy never becomes consumption, and generic ACP keeps usage unsupported', async (t) => {
  const occupancy = notification('session/update', { sessionUpdate: 'usage_update', used: 99_999, size: 256_000, cost: { amount: 1, currency: 'USD' } });
  const carriers = ended({ usage: promptUsage({ inputTokens: 5, outputTokens: 1, totalTokens: 6 }) });
  assert.deepEqual(await (async () => {
    const peer = await controlledUsagePeer(t, [{ before: [occupancy], reply: ended() }]);
    const events = await readTurn(startText(peer.session, 'turn:occupancy'));
    return [events.some((event) => event.type === 'context.usage.updated'), usageOf(events).map((usage) => usage.measurement)];
  })(), [false, [{ kind: 'unavailable', reasons: ['not_reported'] }]]);

  const generic = await controlledUsagePeer(t, [{ before: [occupancy, notification('_x.ai/session_notification', { sessionUpdate: 'turn_completed',
    usage: promptUsage({ inputTokens: 5 }) })], reply: { result: { ...carriers.result, usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } } } }],
  { dialect: false });
  assert.deepEqual(generic.capabilities.tokenUsage, { kind: 'unsupported' });
  const events = await readTurn(startText(generic.session, 'turn:generic'));
  assert.deepEqual([usageOf(events), outcomeOf(events)], [[], ['completed']]);
});
