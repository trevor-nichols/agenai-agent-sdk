import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent } from '@agen-ai/agent-protocol';
import { sessionRecord, type Readback } from './support/native-http.js';
import { startText } from './support/session.js';
import {
  ANTHROPIC, anthropicCounts, atLeast, COMPLETE, completion, contractError, measured, missing, openUsageSession, partial, readTurn,
  snapshot, step, tokens,
} from './support/usage.js';

const T1 = tokens(10, 1, 0, 0, 0);

test('an identical duplicate of each step record counts once', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = () => {
    native.started();
    native.stepStarted('msg_a');
    native.stepStarted('msg_a');
    native.stepEnded('msg_a', T1);
    native.stepEnded('msg_a', T1);
    native.succeeded();
  };
  assert.deepEqual(measured(await readTurn(session, 'turn-1')), [
    ['opencode-model-steps', 'turn:turn-1', 'final', step(COMPLETE, anthropicCounts(atLeast(10, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))],
  ]);
});

test('a conflicting step result is refused at arrival while the reader is paused, and the session admits no further turn', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  const interrupted = Promise.withResolvers<void>();
  loop.control.onPrompt = () => {
    native.started();
    loop.send('session.text.started', { assistantMessageID: 'msg_a', ordinal: 0 });
  };
  loop.control.onInterrupt = () => { native.interrupted(); interrupted.resolve(); };
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const seen: string[] = [];
  while (!seen.includes('item.started')) {
    const next = await outputs.next();
    if (!next.done && next.value.kind === 'event') seen.push(next.value.event.type);
  }
  native.step('msg_a', T1);
  native.stepEnded('msg_a', tokens(11, 1, 0, 0, 0));
  await interrupted.promise;
  assert.deepEqual(seen, ['turn.started', 'item.started']);
  await assert.rejects((async () => { for (let next = await outputs.next(); !next.done; next = await outputs.next()); })(),
    contractError('usage_identity_conflict'));
  assert.throws(() => startText(session, 'turn-2'));
});

test('a conflicting step result while the turn settles is refused before the turn result', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = () => { native.started(); native.step('msg_a', T1); native.succeeded(); };
  loop.control.readback = async (): Promise<Readback> => {
    native.stepEnded('msg_a', tokens(11, 1, 0, 0, 0));
    await loop.delivered();
    return 'drop';
  };
  const delivered: string[] = [];
  await assert.rejects(readTurn(session, 'turn-1', (event) => { delivered.push(event.type); }), contractError('usage_identity_conflict'));
  assert.deepEqual(delivered, ['turn.started']);
});

// Each script's first turn is valid, delivering `kept` observations; its second violates the contract.
for (const [name, code, kept, script] of [
  ['a step reused by a later turn', 'usage_identity_conflict', 1, (n: Native) => n.step('msg_a', T1)],
  ['a restarted step', 'usage_identity_conflict', 1, (n: Native, turn: number) => {
    n.step(`msg_${turn}`, T1);
    if (turn === 2) n.stepStarted('msg_2');
  }],
  ['a step settled without starting', 'usage_sequence_invalid', 1, (n: Native, turn: number) => {
    if (turn === 1) n.step('msg_a', T1); else n.stepEnded('msg_b', T1);
  }],
  ['a streamed total below an earlier one', 'usage_counter_regression', 2, (n: Native, turn: number) => {
    n.step(`msg_${turn}`, T1);
    n.total(turn === 1 ? T1 : tokens(9, 1, 0, 0, 0));
  }],
  ['an invalid step counter', 'usage_invalid', 1, (n: Native, turn: number) => {
    n.stepStarted(`msg_${turn}`);
    n.stepEnded(`msg_${turn}`, turn === 1 ? T1 : { ...T1, input: -1 });
  }],
] as const) {
  test(`${name} fails the session as the ${code} contract error, keeping usage already delivered`, async (t) => {
    const { loop, session, native } = await openUsageSession(t);
    loop.control.onPrompt = (turn) => { native.started(); script(native, turn); native.succeeded(); };
    loop.control.onInterrupt = () => native.interrupted();
    const delivered: AgentEvent[] = [...await readTurn(session, 'turn-1')];
    await assert.rejects(readTurn(session, 'turn-2', (event) => { delivered.push(event); }), contractError(code));
    assert.equal(delivered.filter((event) => event.type === 'usage.observed').length, kept);
    assert.throws(() => startText(session, 'turn-3'));
  });
}
type Native = Awaited<ReturnType<typeof openUsageSession>>['native'];

for (const [name, code, readback] of [
  ['a readback that contradicts streamed totals', 'usage_counter_regression', sessionRecord(tokens(9, 5, 0, 0, 0))],
  ['a readback of another session', 'usage_scope_mismatch', sessionRecord(T1, 'ses_other')],
  ['a readback without complete usage', 'usage_invalid', { ...sessionRecord(T1), tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0 } } }],
] as const) {
  test(`${name} is the ${code} contract error before the turn result`, async (t) => {
    const { loop, session, native } = await openUsageSession(t);
    loop.control.onPrompt = () => { native.started(); native.step('msg_a', T1); native.total(T1); native.succeeded(); };
    loop.control.readback = () => ({ session: readback });
    const delivered: string[] = [];
    await assert.rejects(readTurn(session, 'turn-1', (event) => { delivered.push(event.type); }), contractError(code));
    assert.deepEqual(delivered, ['turn.started']);
  });
}

test('a step past the session bound is a capacity failure, never an eviction', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = () => {
    native.started();
    for (let index = 0; index <= 1_024; index += 1) native.stepStarted(`msg_${index}`);
  };
  loop.control.onInterrupt = () => native.interrupted();
  await assert.rejects(readTurn(session, 'turn-1'), contractError('usage_capacity_exceeded'));
});

test('a step between turns fences the session as a sequence violation', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = () => { native.started(); native.succeeded(); };
  await readTurn(session, 'turn-1');
  native.stepStarted('msg_late');
  await loop.delivered();
  await assert.rejects(startText(session, 'turn-2').outputs[Symbol.asyncIterator]().next(), /no longer usable \(usage_sequence_invalid\)/u);
});

test('a session total between turns waits for the next turn', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = (turn) => { native.started(); if (turn === 2) { native.step('msg_b', T1); native.total(tokens(30, 4, 0, 0, 0)); } native.succeeded(); };
  await readTurn(session, 'turn-1');
  native.total(tokens(20, 3, 0, 0, 0));
  await loop.delivered();
  const events = await readTurn(session, 'turn-2');
  assert.deepEqual(measured(events).slice(0, 2), [
    ['opencode-session-usage', 'session', 'open', snapshot(0, COMPLETE, anthropicCounts(atLeast(20, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(3, 'not_reported')))],
    ['opencode-session-usage', 'session', 'open', snapshot(1, COMPLETE, anthropicCounts(atLeast(30, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(4, 'not_reported')))],
  ]);
});

test('a step on another model is configuration drift, not usage', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = () => { native.started(); native.stepStarted('msg_a', { provider: 'anthropic', id: 'claude-haiku-4-5' }); };
  loop.control.onInterrupt = () => native.interrupted();
  const events = await readTurn(session, 'turn-1');
  const last = events.at(-1)!;
  assert.equal(last.type === 'turn.completed' && last.payload.error?.code, 'opencode_model_drift');
  assert.deepEqual(measured(events), [['opencode-model-steps', 'turn:turn-1', 'final', missing('observation_interrupted')]]);
});

test('cancellation leaves the open step unavailable and every later session total a lower bound', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = (turn) => {
    native.started();
    if (turn === 1) { native.step('msg_a', T1); native.total(T1); native.stepStarted('msg_b'); return; }
    native.step('msg_c', tokens(2, 2, 0, 0, 0));
    native.total(tokens(12, 3, 0, 0, 0));
    native.succeeded();
  };
  loop.control.onInterrupt = () => native.interrupted();
  loop.control.readback = (count) => ({ session: sessionRecord(count === 1 ? T1 : tokens(12, 3, 0, 0, 0)) });
  const execution = startText(session, 'turn-1');
  const events: AgentEvent[] = [];
  loop.control.onPrompt = ((script) => (turn: number) => {
    script(turn);
    if (turn === 1) void loop.delivered().then(() => session.interruption.kind === 'supported'
      && session.interruption.interruptTurn({ turnId: execution.turnId, reason: 'user_requested' }));
  })(loop.control.onPrompt);
  for await (const output of execution.outputs) if (output.kind === 'event') events.push(output.event);
  assert.equal(completion(events), 'canceled');
  const lowered = (value: number) => atLeast(value, 'not_reported', 'observation_interrupted');
  assert.deepEqual(measured(events), [
    ['opencode-session-usage', 'session', 'open', snapshot(0, partial('observation_interrupted'), anthropicCounts(lowered(10), missing('not_reported', 'observation_interrupted'), missing('not_reported', 'observation_interrupted'), lowered(1)))],
    ['opencode-model-steps', 'turn:turn-1', 'open', step(COMPLETE, anthropicCounts(atLeast(10, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')), ANTHROPIC)],
    ['opencode-model-steps', 'turn:turn-1', 'open', missing('observation_interrupted')],
    ['opencode-model-steps', 'turn:turn-1', 'final', missing('observation_interrupted')],
  ]);
  assert.deepEqual(measured(await readTurn(session, 'turn-2'))[0], ['opencode-session-usage', 'session', 'open',
    snapshot(1, partial('observation_interrupted'), anthropicCounts(lowered(12), missing('not_reported', 'observation_interrupted'), missing('not_reported', 'observation_interrupted'), lowered(3)))]);
});

test('losing the native server reads nothing back and reports the unsettled turn unavailable', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = () => { native.started(); native.step('msg_a', T1); native.total(T1); native.stepStarted('msg_b'); loop.endStream(); };
  const events = await readTurn(session, 'turn-1');
  assert.equal(completion(events), 'failed');
  assert.equal(loop.control.reads, 0);
  const lowered = (value: number) => atLeast(value, 'not_reported', 'observation_interrupted');
  assert.deepEqual(measured(events), [
    ['opencode-session-usage', 'session', 'open', snapshot(0, partial('observation_interrupted'), anthropicCounts(lowered(10), missing('not_reported', 'observation_interrupted'), missing('not_reported', 'observation_interrupted'), lowered(1)))],
    ['opencode-model-steps', 'turn:turn-1', 'open', step(COMPLETE, anthropicCounts(atLeast(10, 'not_reported'), missing('not_reported'), missing('not_reported'), atLeast(1, 'not_reported')))],
    ['opencode-model-steps', 'turn:turn-1', 'open', missing('observation_interrupted')],
    ['opencode-model-steps', 'turn:turn-1', 'final', missing('observation_interrupted')],
  ]);
});

test('a reader that abandons the turn receives no usage, and later native totals are harmless', async (t) => {
  const { loop, session, native } = await openUsageSession(t);
  loop.control.onPrompt = () => { native.started(); native.step('msg_a', T1); };
  loop.control.onInterrupt = () => { native.total(T1); native.interrupted(); };
  const outputs = startText(session, 'turn-1').outputs[Symbol.asyncIterator]();
  const first = await outputs.next();
  assert.equal(!first.done && first.value.kind === 'event' && first.value.event.type, 'turn.started');
  await outputs.return?.(undefined);
  await loop.delivered();
  assert.throws(() => startText(session, 'turn-2'));
});
