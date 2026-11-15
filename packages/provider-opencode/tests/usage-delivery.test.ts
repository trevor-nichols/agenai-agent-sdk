import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent } from '@agen-ai/agent-protocol';
import { sessionRecord } from './support/native-http.js';
import { startText } from './support/session.js';
import {
  anthropicCounts, atLeast, COMPLETE, completion, contractError, measured, missing, openUsageSession, readTurn, snapshot, step, tokens,
} from './support/usage.js';

test('a readback below the dispatch-time counters fails and keeps already delivered usage', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = (turn) => { native.started(); native.step(`msg_${turn}`, tokens(10, 1, 0, 0, 0)); native.succeeded(); };
  loop.control.readback = (turn) => ({ session: sessionRecord(tokens(turn === 1 ? 100 : 50, 1, 0, 0, 0)) });
  const kept = measured(await readTurn(session, 'turn-1'));
  assert.deepEqual(kept[0], ['opencode-session-usage', 'session', 'open',
    snapshot(0, COMPLETE, anthropicCounts(atLeast(100, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))]);
  const delivered: string[] = [];
  await assert.rejects(readTurn(session, 'turn-2', (event) => { delivered.push(event.type); }), contractError('usage_counter_regression'));
  assert.deepEqual(delivered, ['turn.started']);
  assert.throws(() => startText(session, 'turn-3'));
});

test('64 distinct between-turn checkpoints retain arrival order and the next settlement follows them', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = (turn) => {
    native.started();
    if (turn === 2) { native.step('msg_a', tokens(1, 1, 0, 0, 0)); native.total(tokens(65, 65, 0, 0, 0)); }
    native.succeeded();
  };
  await readTurn(session, 'turn-1');
  for (let value = 1; value <= 64; value += 1) native.total(tokens(value, value, 0, 0, 0));
  await loop.delivered();
  const events = await readTurn(session, 'turn-2');
  assert.deepEqual(measured(events), [
    ...Array.from({ length: 65 }, (_, index) => ['opencode-session-usage', 'session', 'open',
      snapshot(index, COMPLETE, anthropicCounts(atLeast(index + 1, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(index + 1, 'not_reported')))]),
    ['opencode-model-steps', 'turn:turn-2', 'final', step(COMPLETE, anthropicCounts(atLeast(1, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))],
  ]);
  assert.equal(completion(events), 'completed');
});

test('the 65th pending checkpoint fences the session without sending another prompt', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = () => { native.started(); native.succeeded(); };
  await readTurn(session, 'turn-1');
  for (let value = 1; value <= 65; value += 1) native.total(tokens(value, value, 0, 0, 0));
  await loop.delivered();
  await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /no longer usable \(usage_capacity_exceeded\)/u);
  assert.equal(loop.control.prompts, 1);
});

for (const replay of ['identical', 'conflicting', 'new', 'late-checkpoints', 'overflow'] as const) {
  test(`${replay} work arriving during usage delivery preserves the settled accounting boundary`, async (t) => {
    const { loop, session, native } = await openUsageSession(t);
    loop.control.onPrompt = (turn) => {
      native.started();
      if (turn === 1) { native.step('msg_a', tokens(10, 1, 0, 0, 0)); native.total(tokens(10, 1, 0, 0, 0)); }
      native.succeeded();
    };
    const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    for (;;) {
      const next = await outputs.next();
      assert.equal(next.done, false);
      if (!next.done && next.value.kind === 'event') {
        events.push(next.value.event);
        if (next.value.event.type === 'usage.observed') break;
      }
    }
    if (replay === 'late-checkpoints') { native.total(tokens(20, 2, 0, 0, 0)); native.total(tokens(30, 3, 0, 0, 0)); }
    else if (replay === 'overflow') { for (let value = 11; value <= 75; value += 1) native.total(tokens(value, value, 0, 0, 0)); }
    else if (replay === 'new') native.stepStarted('msg_new');
    else native.stepEnded('msg_a', tokens(replay === 'identical' ? 10 : 11, 1, 0, 0, 0));
    await loop.delivered();
    const drain = async () => {
      for (let next = await outputs.next(); !next.done; next = await outputs.next()) {
        if (next.value.kind === 'event') events.push(next.value.event);
      }
    };
    if (replay !== 'identical' && replay !== 'late-checkpoints') {
      const code = replay === 'overflow' ? 'usage_capacity_exceeded' : replay === 'new' ? 'usage_sequence_invalid' : 'usage_identity_conflict';
      await assert.rejects(drain(), contractError(code));
      assert.deepEqual(events.map((event) => event.type), ['turn.started', 'usage.observed']);
      assert.throws(() => startText(session, 'turn-2'));
    } else {
      await drain();
      assert.deepEqual(measured(events), [
        ['opencode-session-usage', 'session', 'open', snapshot(0, COMPLETE, anthropicCounts(atLeast(10, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))],
        ['opencode-model-steps', 'turn:turn-1', 'final', step(COMPLETE, anthropicCounts(atLeast(10, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))],
      ]);
      assert.equal(completion(events), 'completed');
      if (replay === 'late-checkpoints') {
        const next = await readTurn(session, 'turn-2');
        assert.deepEqual(measured(next).slice(0, 2), [
          ['opencode-session-usage', 'session', 'open', snapshot(1, COMPLETE, anthropicCounts(atLeast(20, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(2, 'not_reported')))],
          ['opencode-session-usage', 'session', 'open', snapshot(2, COMPLETE, anthropicCounts(atLeast(30, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(3, 'not_reported')))],
        ]);
        assert.equal(completion(next), 'completed');
      }
    }
  });
}

for (const [name, code, response] of [
  ['malformed JSON', 'usage_invalid', { body: '{', contentType: 'application/json' }],
  ['unexpected content type', 'usage_invalid', { body: '{}', contentType: 'text/plain' }],
  ['an oversized response', 'usage_capacity_exceeded', { session: { ...sessionRecord(tokens(10, 1, 0, 0, 0)), extra: 'x'.repeat(4 * 1024 * 1024) } }],
] as const) {
  test(`${name} on the session readback fails accounting before completion`, async (t) => {
    const { loop, session, native } = await openUsageSession(t);
    loop.control.onPrompt = () => {
      native.started(); native.step('msg_a', tokens(10, 1, 0, 0, 0)); native.total(tokens(10, 1, 0, 0, 0)); native.succeeded();
    };
    loop.control.readback = () => response;
    const delivered: string[] = [];
    await assert.rejects(readTurn(session, 'turn-1', (event) => { delivered.push(event.type); }), contractError(code));
    assert.deepEqual(delivered, ['turn.started']);
    assert.throws(() => startText(session, 'turn-2'));
  });
}
