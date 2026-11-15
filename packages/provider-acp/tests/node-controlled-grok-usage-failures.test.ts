import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { AcpJsonObject, AcpJsonValue } from '@agen-ai/acp-transport';
import type { AgentEvent } from '@agen-ai/agent-protocol';
import {
  agentText, controlledUsagePeer, NATIVE_SESSION_ID, notification, outcomeOf, promptUsage, readTurn, startText, usageOf,
} from './node-fixtures/controlled-grok-usage.js';

const valid = { inputTokens: 1629, cachedReadTokens: 512, cacheCreationTokens: 0, outputTokens: 26, reasoningTokens: 25, totalTokens: 1655, modelCalls: 1 };
const ended = (meta: AcpJsonObject) => ({ result: { stopReason: 'end_turn', _meta: meta } });
const withUsage = (changes: Readonly<Record<string, AcpJsonValue>>) => ended({ usage: promptUsage({ ...valid, ...changes }) });
const rows = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`grok-${index}`, promptUsage({ inputTokens: 1 })]));

async function rejected(t: test.TestContext, replies: readonly { result: AcpJsonObject }[], code: string) {
  const peer = await controlledUsagePeer(t, replies.map((reply) => ({ before: [agentText('partial')], reply })));
  for (const [index] of replies.slice(0, -1).entries()) assert.equal(usageOf(await readTurn(startText(peer.session, `turn:${index}`))).length, 1);
  await assert.rejects(readTurn(startText(peer.session, 'turn:rejected')), { name: 'AgentProviderContractError', code });
  await delay(10);
  assert.equal(peer.releases(), 1);
  assert.throws(() => startText(peer.session, 'turn:after'));
}

test('malformed or contradictory native usage rejects the turn as a contract failure and releases the process', async (t) => {
  const malformed: readonly Readonly<Record<string, AcpJsonValue>>[] = [{ inputTokens: -1 }, { outputTokens: 2.5 },
    { cachedReadTokens: '512' }, { modelCalls: 2 ** 53 }, { reasoningTokens: null }, { reasoningTokens: 30 },
    { cachedReadTokens: 1000, cacheCreationTokens: 700 }, { totalTokens: 1700 }, { usageIsIncomplete: null }, { usageIsIncomplete: 'yes' }, { modelUsage: [] },
    { modelUsage: { 'grok-a': promptUsage({ ...valid, inputTokens: 2000, totalTokens: 2026 }) } }];
  for (const changes of malformed) {
    await rejected(t, [withUsage(changes)], 'usage_invalid');
  }
  await rejected(t, [ended({ usage: 'present' })], 'usage_invalid');
  await rejected(t, [ended({ sessionId: 'foreign-session', usage: promptUsage(valid) })], 'usage_scope_mismatch');
  await rejected(t, [withUsage({ modelUsage: rows(9) })], 'usage_capacity_exceeded');
  await rejected(t, [withUsage({ modelUsage: { ['m'.repeat(129)]: promptUsage({ inputTokens: 1 }) } })], 'usage_capacity_exceeded');
  await rejected(t, [ended({ promptId: 'prompt-1', usage: promptUsage(valid) }), ended({ promptId: 'prompt-1', usage: promptUsage(valid) })],
    'usage_identity_conflict');
});

test('a failed prompt keeps its failure and reports usage unavailable without parsing error data', async (t) => {
  const peer = await controlledUsagePeer(t, [{ before: [agentText('partial')], reply: { error: { code: -32603, message: 'Internal error',
    data: { promptUsage: { inputTokens: -5, outputTokens: 'many' } } } } }]);
  const events = await readTurn(startText(peer.session, 'turn:failed'));
  assert.deepEqual(outcomeOf(events), ['failed']);
  assert.deepEqual(events.slice(-3).map((event) => event.type), ['usage.observed', 'item.completed', 'turn.completed']);
  assert.deepEqual(usageOf(events).map((usage) => usage.measurement), [{ kind: 'unavailable', reasons: ['native_result_incomplete'] }]);
});

test('a canceled prompt settles canceled and keeps its incomplete usage as lower bounds', async (t) => {
  const peer = await controlledUsagePeer(t, [{ before: [agentText('working')], onCancel: { result: { stopReason: 'cancelled', _meta: {
    sessionId: NATIVE_SESSION_ID, usage: promptUsage({ usageIsIncomplete: true, inputTokens: 1629, outputTokens: 3, modelCalls: 1 }) } } } }]);
  const { interruption } = peer.session;
  assert.ok(interruption.kind === 'supported');
  const execution = startText(peer.session, 'turn:cancel');
  const events: AgentEvent[] = [];
  for await (const output of execution.outputs) {
    if (output.kind !== 'event') continue;
    events.push(output.event);
    if (output.event.type === 'content.delta') {
      assert.equal((await interruption.interruptTurn({ turnId: execution.turnId, reason: 'user_requested' })).status, 'canceled');
    }
  }
  assert.equal(peer.methods.filter((method) => method === 'session/cancel').length, 1);
  assert.deepEqual(outcomeOf(events), ['canceled']);
  const lower = (value: number) => ({ kind: 'at_least', value, reasons: ['native_result_incomplete'] });
  const [usage] = usageOf(events);
  assert.deepEqual([usage!.measurement.kind, usage!.measurement.kind === 'delta' && usage!.measurement.counters.inputTokens,
    usage!.measurement.kind === 'delta' && usage!.measurement.counters.outputTokens], ['delta', lower(1629), lower(3)]);
});

test('duplicate native carriers never produce a second observation for one prompt', async (t) => {
  const shadow = notification('_x.ai/session_notification', { sessionUpdate: 'turn_completed', usage: promptUsage(valid) });
  const notified = await controlledUsagePeer(t, [{ before: [shadow, shadow], reply: withUsage({}) }]);
  assert.equal(usageOf(await readTurn(startText(notified.session, 'turn:notified'))).length, 1);

  const replayed = await controlledUsagePeer(t, [{ reply: withUsage({}), repeatReply: true }]);
  const events: AgentEvent[] = [];
  await assert.rejects((async () => {
    for await (const output of startText(replayed.session, 'turn:replayed').outputs) if (output.kind === 'event') events.push(output.event);
    startText(replayed.session, 'turn:next');
  })());
  assert.ok(usageOf(events).length <= 1);
  await delay(10);
  assert.equal(replayed.releases(), 1);
});
