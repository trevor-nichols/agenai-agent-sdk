import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyNativeEvent, NativeEventError } from '../src/node/native-events.js';

const SESSION = 'ses_1';
const TOKENS = { input: 7, output: 5, reasoning: 11, cache: { read: 300, write: 40 } };
const event = (type: string, data: Record<string, unknown>) => ({ id: 'evt_1', created: 1, type, data });

test('turn events for this session map to their native identities', () => {
  assert.deepEqual(classifyNativeEvent(event('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg_1', ordinal: 2, delta: 'hi' }), SESSION),
    { kind: 'text', stream: 'assistant', phase: 'delta', key: 'msg_1:2', text: 'hi' });
  assert.deepEqual(classifyNativeEvent(event('session.reasoning.started', { sessionID: SESSION, assistantMessageID: 'msg_1', ordinal: 0 }), SESSION),
    { kind: 'text', stream: 'reasoning', phase: 'started', key: 'msg_1:0', text: '' });
  assert.deepEqual(classifyNativeEvent(event('session.tool.input.started', { sessionID: SESSION, assistantMessageID: 'msg_1', id: 'toolu_1', name: 'agenai_bash' }), SESSION),
    { kind: 'tool_input', callID: 'toolu_1', name: 'agenai_bash' });
  assert.deepEqual(classifyNativeEvent(event('session.execution.failed', { sessionID: SESSION, error: { type: 'provider', message: 'quota' } }), SESSION),
    { kind: 'execution_failed', message: 'quota' });
  assert.deepEqual(classifyNativeEvent(event('permission.asked', { id: 'per_1', sessionID: SESSION, action: 'shell', resources: [] }), SESSION),
    { kind: 'permission_asked', requestID: 'per_1' });
});

test('another session, an unknown type, rpc and configuration changes are drift', () => {
  for (const [type, data] of [
    ['session.text.delta', { sessionID: 'ses_other', assistantMessageID: 'msg_1', ordinal: 0, delta: 'x' }],
    ['form.created', { form: { id: 'frm_1', sessionID: 'ses_other', title: 'x', fields: [] } }],
    ['session.future.event', { sessionID: SESSION }],
    ['rpc.anything', {}],
    ['config.updated', {}],
    ['session.permissions', { sessionID: SESSION }],
    ['session.execution.succeeded', { sessionID: 'ses_other' }],
    ['session.idle', { sessionID: 'ses_other' }],
    ['session.usage.updated', { sessionID: 'ses_other', cost: 0, tokens: TOKENS }],
    ['session.step.ended', { sessionID: 'ses_other', assistantMessageID: 'msg_1', finish: 'stop', cost: 0, tokens: TOKENS }],
  ] as const) {
    assert.equal(classifyNativeEvent(event(type, data), SESSION).kind, 'drift', type);
  }
  assert.deepEqual(classifyNativeEvent(event('plugin.updated', {}), SESSION), { kind: 'opening', type: 'plugin.updated' });
  assert.deepEqual(classifyNativeEvent(event('session.step.streamed', { sessionID: SESSION, assistantMessageID: 'msg_1' }), SESSION), { kind: 'benign' });
  for (const type of ['project.updated', 'filesystem.changed']) assert.deepEqual(classifyNativeEvent(event(type, {}), SESSION), { kind: 'benign' }, type);
});

test('usage events keep their exclusive buckets, step identity and configured model', () => {
  assert.deepEqual(classifyNativeEvent(event('session.usage.updated', { sessionID: SESSION, cost: 0.1, tokens: TOKENS }), SESSION),
    { kind: 'session_usage', tokens: { input: 7, cacheRead: 300, cacheWrite: 40, output: 5, reasoning: 11 } });
  assert.deepEqual(classifyNativeEvent(event('session.step.started', {
    sessionID: SESSION, assistantMessageID: 'msg_2', agent: 'build', model: { id: 'gpt-5', providerID: 'openai', variant: 'high' }, started: 1,
  }), SESSION), { kind: 'step_started', messageID: 'msg_2', model: { providerID: 'openai', id: 'gpt-5' } });
  assert.deepEqual(classifyNativeEvent(event('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg_2', finish: 'stop', cost: 0, tokens: TOKENS }), SESSION),
    { kind: 'step_ended', messageID: 'msg_2', tokens: { input: 7, cacheRead: 300, cacheWrite: 40, output: 5, reasoning: 11 } });
  assert.deepEqual(classifyNativeEvent(event('session.step.failed', { sessionID: SESSION, assistantMessageID: 'msg_3', error: { type: 'x' } }), SESSION),
    { kind: 'step_failed', messageID: 'msg_3', tokens: null });
});

test('counters outside non-negative safe integers stay invalid for the usage contract to reject', () => {
  for (const tokens of [
    { ...TOKENS, input: -1 }, { ...TOKENS, output: 1.5 }, { ...TOKENS, reasoning: 2 ** 53 }, { ...TOKENS, cache: { read: '3', write: 0 } },
    { input: 1, output: 1, reasoning: 0, cache: { read: 0 } }, null,
  ]) {
    assert.deepEqual(classifyNativeEvent(event('session.usage.updated', { sessionID: SESSION, tokens }), SESSION), { kind: 'session_usage', tokens: 'invalid' });
    assert.deepEqual(classifyNativeEvent(event('session.step.failed', { sessionID: SESSION, assistantMessageID: 'msg_1', error: {}, tokens }), SESSION),
      { kind: 'step_failed', messageID: 'msg_1', tokens: 'invalid' });
  }
});

test('a usage event without its step identity or usage record is a native protocol failure', () => {
  for (const [type, data] of [
    ['session.usage.updated', { sessionID: SESSION }],
    ['session.step.started', { sessionID: SESSION, model: { id: 'gpt-5', providerID: 'openai' } }],
    ['session.step.started', { sessionID: SESSION, assistantMessageID: 'msg_1' }],
    ['session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg_1' }],
    ['session.step.failed', { sessionID: SESSION, assistantMessageID: 'x'.repeat(257) }],
  ] as const) {
    assert.throws(() => classifyNativeEvent(event(type, data), SESSION), NativeEventError, type);
  }
});

test('every session-scoped event without a string session identity is a native protocol failure', () => {
  for (const type of ['session.execution.started', 'session.execution.succeeded', 'session.execution.interrupted', 'session.idle', 'session.tool.success']) {
    for (const data of [{}, { sessionID: 42 }]) {
      assert.throws(() => classifyNativeEvent(event(type, data), SESSION), NativeEventError, `${type} ${JSON.stringify(data)}`);
    }
  }
});

test('a malformed turn event is a native protocol failure', () => {
  assert.throws(() => classifyNativeEvent({ type: 'session.text.delta' }, SESSION), NativeEventError);
  assert.throws(() => classifyNativeEvent(event('session.tool.called', { sessionID: SESSION, id: 'toolu_1' }), SESSION), NativeEventError);
  assert.throws(() => classifyNativeEvent(event('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg_1', ordinal: -1, delta: 'x' }), SESSION), NativeEventError);
});
