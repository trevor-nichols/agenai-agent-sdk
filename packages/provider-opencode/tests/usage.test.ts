import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionRecord } from './support/native-http.js';
import {
  anthropicCounts, atLeast, COMPLETE, completion, measured, missing, OPENAI, openaiCounts, openUsageSession, partial, readTurn,
  snapshot, step, tokens, types, usageOf,
} from './support/usage.js';

test('two turns report one session snapshot each and a model delta per step, equal-valued steps included', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = (count) => {
    native.started();
    if (count === 1) {
      native.step('msg_a', tokens(10, 1, 0, 100, 1000));
      native.step('msg_b', tokens(10, 1, 0, 100, 1000));
      native.total(tokens(20, 2, 0, 200, 2000));
    } else {
      native.step('msg_c', tokens(5, 3, 0, 0, 0));
      native.total(tokens(25, 5, 0, 200, 2000));
    }
    native.succeeded();
  };
  loop.control.readback = (count) => ({ session: sessionRecord(count === 1 ? tokens(20, 2, 0, 200, 2000) : tokens(25, 5, 0, 200, 2000)) });
  const first = await readTurn(session, 'turn-1');
  assert.deepEqual(measured(first), [
    ['opencode-session-usage', 'session', 'open', snapshot(0, COMPLETE, anthropicCounts(atLeast(2220, 'not_reported'), atLeast(200, 'not_reported'), atLeast(2000, 'not_reported'), atLeast(2, 'not_reported')))],
    ['opencode-model-steps', 'turn:turn-1', 'open', step(COMPLETE, anthropicCounts(atLeast(1110, 'not_reported'), atLeast(100, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(1, 'not_reported')))],
    ['opencode-model-steps', 'turn:turn-1', 'final', step(COMPLETE, anthropicCounts(atLeast(1110, 'not_reported'), atLeast(100, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(1, 'not_reported')))],
  ]);
  assert.deepEqual(types(first).slice(-4), ['usage.observed', 'usage.observed', 'usage.observed', 'turn.completed']);
  assert.equal(completion(first), 'completed');
  const second = await readTurn(session, 'turn-2');
  assert.deepEqual(measured(second), [
    ['opencode-session-usage', 'session', 'open', snapshot(1, COMPLETE, anthropicCounts(atLeast(2225, 'not_reported'), atLeast(200, 'not_reported'), atLeast(2000, 'not_reported'), atLeast(5, 'not_reported')))],
    ['opencode-model-steps', 'turn:turn-2', 'final', step(COMPLETE, anthropicCounts(atLeast(5, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(3, 'not_reported')))],
  ]);
  const [sessionScope, turnOne] = usageOf(first).map((observation) => observation.scope);
  const [again, turnTwo] = usageOf(second).map((observation) => observation.scope);
  assert.equal(again!.scopeId, sessionScope!.scopeId);
  assert.notEqual(turnTwo!.scopeId, turnOne!.scopeId);
  for (const scope of [turnOne, turnTwo]) assert.equal(scope!.kind === 'turn' && 'containedIn' in scope! && scope.containedIn, sessionScope!.scopeId);
  const comparison = usageOf(second)[0]!.measurement;
  assert.equal(comparison.kind, 'snapshot');
  const stable = { kind: 'stable', populationId: sessionScope!.scopeId };
  assert.deepEqual(comparison.kind === 'snapshot' && comparison.comparison, {
    inputTokens: stable, cacheReadInputTokens: stable, cacheCreationInputTokens: stable, outputTokens: stable,
    cacheCreationFiveMinuteInputTokens: { kind: 'unknown' }, cacheCreationOneHourInputTokens: { kind: 'unknown' },
    reasoningOutputTokens: { kind: 'unknown' }, modelCalls: { kind: 'unknown' }, turns: { kind: 'unknown' },
  });
  assert.equal(loop.control.prompts, 2);
});

test('OpenAI reasoning counts once in output and its zero cache write stays unsupported; Anthropic reasoning is never a measured zero', async (t) => {
  const openai = await openUsageSession(t, OPENAI);
  openai.loop.control.onPrompt = () => {
    openai.native.started();
    openai.native.step('msg_1', tokens(100, 1, 10, 1000, 0));
    openai.native.total(tokens(100, 1, 10, 1000, 0));
    openai.native.succeeded();
  };
  openai.loop.control.readback = () => ({ session: sessionRecord(tokens(100, 1, 10, 1000, 0)) });
  assert.deepEqual(measured(await readTurn(openai.session, 'turn-1')), [
    ['opencode-session-usage', 'session', 'open', snapshot(0, COMPLETE, openaiCounts(atLeast(1100, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(11, 'not_reported'), atLeast(10, 'not_reported')))],
    ['opencode-model-steps', 'turn:turn-1', 'final', step(COMPLETE, openaiCounts(atLeast(1100, 'not_reported'), atLeast(1000, 'not_reported'), atLeast(11, 'not_reported'), atLeast(10, 'not_reported')), OPENAI)],
  ]);
  const anthropic = await openUsageSession(t);
  anthropic.loop.control.onPrompt = () => {
    anthropic.native.started();
    anthropic.native.step('msg_1', tokens(10, 3, 4, 0, 0));
    anthropic.native.succeeded();
  };
  assert.deepEqual(measured(await readTurn(anthropic.session, 'turn-1')), [
    ['opencode-model-steps', 'turn:turn-1', 'final', step(COMPLETE, anthropicCounts(atLeast(10, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(7, 'not_reported')))],
  ]);
});

for (const model of [undefined, OPENAI]) {
  test(`${model?.provider ?? 'anthropic'} defaulted zeroes and later positive totals retain missing-accounting precision`, async (t) => {
    const { loop, session, native } = await openUsageSession(t, model);
    loop.control.onPrompt = (turn) => {
      native.started();
      native.step(`msg_${turn}`, turn === 1 ? tokens(0, 0, 0, 0, 0) : turn === 2 ? tokens(100, 10, 0, 0, 0) : tokens(20, 2, model ? 3 : 0, 5, model ? 0 : 13));
      native.total(turn === 1 ? tokens(0, 0, 0, 0, 0) : turn === 2 ? tokens(100, 10, 0, 0, 0) : tokens(120, 12, model ? 3 : 0, 5, model ? 0 : 13));
      native.succeeded();
    };
    const zero = await readTurn(session, 'turn-1');
    const first = await readTurn(session, 'turn-2');
    const second = await readTurn(session, 'turn-3');
    const empty = missing('not_reported');
    const firstCounts = model ? openaiCounts(atLeast(100, 'not_reported'), empty, atLeast(10, 'not_reported'), empty)
      : anthropicCounts(atLeast(100, 'not_reported'), empty, empty, atLeast(10, 'not_reported'));
    const cumulative = model ? openaiCounts(atLeast(125, 'not_reported'), atLeast(5, 'not_reported'), atLeast(15, 'not_reported'), atLeast(3, 'not_reported'))
      : anthropicCounts(atLeast(138, 'not_reported'), atLeast(5, 'not_reported'), atLeast(13, 'not_reported'), atLeast(12, 'not_reported'));
    const current = model ? openaiCounts(atLeast(25, 'not_reported'), atLeast(5, 'not_reported'), atLeast(5, 'not_reported'), atLeast(3, 'not_reported'))
      : anthropicCounts(atLeast(38, 'not_reported'), atLeast(5, 'not_reported'), atLeast(13, 'not_reported'), atLeast(2, 'not_reported'));
    const zeroCounts = model ? openaiCounts(empty, empty, empty, empty) : anthropicCounts(empty, empty, empty, empty);
    assert.deepEqual(measured(zero), [
      ['opencode-session-usage', 'session', 'open', snapshot(0, COMPLETE, zeroCounts)],
      ['opencode-model-steps', 'turn:turn-1', 'final', step(COMPLETE, zeroCounts, model)],
    ]);
    assert.deepEqual(measured(first), [
      ['opencode-session-usage', 'session', 'open', snapshot(1, COMPLETE, firstCounts)],
      ['opencode-model-steps', 'turn:turn-2', 'final', step(COMPLETE, firstCounts, model)],
    ]);
    assert.deepEqual(measured(second), [
      ['opencode-session-usage', 'session', 'open', snapshot(2, COMPLETE, cumulative)],
      ['opencode-model-steps', 'turn:turn-3', 'final', step(COMPLETE, current, model)],
    ]);
  });
}

test('usage arriving between turns opens the next turn, and only a concurrently overtaken readback is stale', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = (count) => {
    native.started();
    if (count === 1) {
      native.step('msg_a', tokens(10, 1, 0, 0, 0));
      native.total(tokens(10, 1, 0, 0, 0));
    } else {
      native.step('msg_b', tokens(5, 1, 0, 0, 0));
    }
    native.succeeded();
  };
  loop.control.readback = async (count) => {
    if (count === 2) { native.total(tokens(45, 7, 0, 0, 0)); await loop.delivered(); }
    return { session: sessionRecord(count === 1 ? tokens(10, 1, 0, 0, 0) : tokens(40, 6, 0, 0, 0)) };
  };
  await readTurn(session, 'turn-1');
  native.total(tokens(40, 6, 0, 0, 0));
  await loop.delivered();
  const second = await readTurn(session, 'turn-2');
  assert.deepEqual(types(second).slice(0, 2), ['turn.started', 'usage.observed']);
  assert.deepEqual(measured(second), [
    ['opencode-session-usage', 'session', 'open', snapshot(1, COMPLETE, anthropicCounts(atLeast(40, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(6, 'not_reported')))],
    ['opencode-session-usage', 'session', 'open', snapshot(2, COMPLETE, anthropicCounts(atLeast(45, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(7, 'not_reported')))],
    ['opencode-model-steps', 'turn:turn-2', 'final', step(COMPLETE, anthropicCounts(atLeast(5, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))],
  ]);
});

test('a dropped or unanswered readback keeps the streamed totals and the outcome, and replays nothing', { timeout: 20_000 }, async (t) => {
  for (const answer of ['drop', 'hang'] as const) {
    const { loop, session, native } = await openUsageSession(t);
    loop.control.onPrompt = () => {
      native.started();
      native.step('msg_a', tokens(10, 1, 0, 0, 0));
      native.total(tokens(10, 1, 0, 0, 0));
      native.succeeded();
    };
    loop.control.readback = () => answer;
    const events = await readTurn(session, 'turn-1');
    assert.equal(completion(events), 'completed', answer);
    assert.deepEqual(measured(events)[0], ['opencode-session-usage', 'session', 'open',
      snapshot(0, COMPLETE, anthropicCounts(atLeast(10, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))], answer);
    assert.deepEqual([loop.control.prompts, loop.control.reads], [1, 1], answer);
  }
});

test('a failed step without usage is unavailable, one with usage is a lower bound, and later totals stay lower bounds', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = (count) => {
    native.started();
    if (count === 1) {
      native.step('msg_a', tokens(10, 1, 0, 0, 0));
      native.stepStarted('msg_b');
      native.stepFailed('msg_b', tokens(3, 2, 0, 0, 0));
      native.stepStarted('msg_c');
      native.stepFailed('msg_c');
      native.total(tokens(13, 3, 0, 0, 0));
      native.failed();
    } else {
      native.step('msg_d', tokens(1, 1, 0, 0, 0));
      native.total(tokens(14, 4, 0, 0, 0));
      native.succeeded();
    }
  };
  loop.control.readback = (count) => ({ session: sessionRecord(count === 1 ? tokens(13, 3, 0, 0, 0) : tokens(14, 4, 0, 0, 0)) });
  const failed = await readTurn(session, 'turn-1');
  assert.equal(completion(failed), 'failed');
  assert.deepEqual(measured(failed), [
    ['opencode-session-usage', 'session', 'open', snapshot(0, partial('native_result_incomplete'),
      anthropicCounts(atLeast(13, 'not_reported', 'native_result_incomplete'), missing('not_reported', 'native_result_incomplete'), missing('not_reported', 'native_result_incomplete'),
        atLeast(3, 'not_reported', 'native_result_incomplete')))],
    ['opencode-model-steps', 'turn:turn-1', 'open', step(COMPLETE, anthropicCounts(atLeast(10, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))],
    ['opencode-model-steps', 'turn:turn-1', 'open', step(partial('native_result_incomplete'), anthropicCounts(atLeast(3, 'not_reported', 'native_result_incomplete'),
      missing('not_reported', 'native_result_incomplete'), missing('not_reported', 'native_result_incomplete'), atLeast(2, 'not_reported', 'native_result_incomplete')))],
    ['opencode-model-steps', 'turn:turn-1', 'open', { kind: 'unavailable', reasons: ['native_result_incomplete'] }],
    ['opencode-model-steps', 'turn:turn-1', 'final', { kind: 'unavailable', reasons: ['native_result_incomplete'] }],
  ]);
  const next = await readTurn(session, 'turn-2');
  assert.equal(completion(next), 'completed');
  assert.deepEqual(measured(next), [
    ['opencode-session-usage', 'session', 'open', snapshot(1, partial('native_result_incomplete'),
      anthropicCounts(atLeast(14, 'not_reported', 'native_result_incomplete'), missing('not_reported', 'native_result_incomplete'), missing('not_reported', 'native_result_incomplete'),
        atLeast(4, 'not_reported', 'native_result_incomplete')))],
    ['opencode-model-steps', 'turn:turn-2', 'final', step(COMPLETE, anthropicCounts(atLeast(1, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))],
  ]);
});
