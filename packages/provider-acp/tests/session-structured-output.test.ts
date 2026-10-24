import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentSessionId, type AgentOutputSchema, type AgentTurnCompletedPayload } from '@agen-ai/agent-protocol';
import { AgentProviderContractError, createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { runAgentProviderConformance } from '@agen-ai/agent-runtime/testing';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import { createAcpProviderDriver, type CreateAcpProviderDriverOptions } from '../src/index.js';
import { createSessionPeer, type PeerFrame, type SessionPeer } from './fixtures/session-peer.js';
import { collect, configuration, definition, events, providerKey, selection, turnInput } from './fixtures/session-runtime.js';

const mapping = { mapping: 'grok-build-1.0.62-structured-output-v1' } as const;
const initialize: AcpJsonObject = {
  protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'grok', version: '1' },
  _meta: { grokShell: true, agentVersion: '1.0.62' },
};
const titleSchema: AgentOutputSchema = {
  type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 100 } },
  required: ['title'], additionalProperties: false,
};
const rankSchema: AgentOutputSchema = {
  type: 'object', properties: { rank: { type: 'integer', minimum: 1, maximum: 5 } },
  required: ['rank'], additionalProperties: false,
};
const output = (schema: AgentOutputSchema = titleSchema) => ({ kind: 'json_schema' as const, schema });
const hasCode = (reasonCode: string) => (error: unknown): boolean =>
  error instanceof Error && (('reasonCode' in error && error.reasonCode === reasonCode)
    || (error instanceof AgentProviderContractError && error.code === reasonCode));

function respond(peer: SessionPeer, frame: PeerFrame, meta?: unknown, stopReason = 'end_turn'): void {
  peer.send({ jsonrpc: '2.0', id: frame.id, result: { stopReason, ...(meta === undefined ? {} : { _meta: meta }) } });
}

async function openMapped(peer: SessionPeer) {
  const driver = createAcpProviderDriver({ providerKey, structuredOutputMapping: mapping, createConnection: () => peer.lease });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [definition] });
  const instance = registry.requireInstance(definition.instanceId);
  const session = await instance.adapter.createSession({
    sessionId: parseAgentSessionId('structured:session'), workingDirectory: '/fixture', configuration, onBindingCreated() {},
  });
  return { registry, instance, session };
}

test('structured mapping selection rejects unknown authority and accessor data before acquiring streams', () => {
  let acquisitions = 0;
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'mapping', { enumerable: true, get() { getterCalls += 1; return mapping.mapping; } });
  for (const structuredOutputMapping of [null, false, 'standard', {}, { mapping: 'other' }, { ...mapping, repair: true }, getter,
    Object.create(mapping), { ...mapping, [Symbol('authority')]: true }]) {
    assert.throws(() => createAcpProviderDriver({ providerKey, structuredOutputMapping, createConnection() {
      acquisitions += 1; throw new Error('Invalid mapping acquired streams.');
    } } as unknown as CreateAcpProviderDriverOptions), TypeError);
  }
  assert.equal(acquisitions, 0);
  assert.equal(getterCalls, 0);
});

for (const [name, metadata] of [
  ['missing metadata', undefined], ['wrong version', { grokShell: true, agentVersion: '1.0.61' }],
  ['newer version', { grokShell: true, agentVersion: '1.0.63' }], ['padded version', { grokShell: true, agentVersion: '1.0.62 ' }],
  ['missing native identity', { agentVersion: '1.0.62' }], ['false native identity', { grokShell: false, agentVersion: '1.0.62' }],
] as const) {
  test(`selected structured mapping rejects ${name} during initialization and releases owned streams`, async () => {
    let releases = 0;
    const peer = createSessionPeer({ owned: true, onRelease: () => { releases += 1; }, initializeResult: {
      protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'grok', version: '1.0.62' },
      ...(metadata ? { _meta: metadata } : {}),
    } });
    const driver = createAcpProviderDriver({ providerKey, structuredOutputMapping: mapping, createConnection: () => peer.lease });
    await assert.rejects(async () => driver.materialize(definition), hasCode('acp_structured_output_profile_mismatch'));
    assert.equal(releases, 1);
    assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize']);
    assert.equal(peer.stdout.destroyed, true);
  });
}

test('generic ACP tolerates optional extensions but rejects structured opening and turns before native session or prompt work', async (t) => {
  const peer = createSessionPeer({ initializeResult: initialize });
  t.after(() => peer.dispose());
  peer.send({ jsonrpc: '2.0', method: '_vendor/optional_notification', params: {} });
  const driver = createAcpProviderDriver({ providerKey, createConnection: () => peer.lease });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [definition] });
  t.after(() => registry.dispose());
  const instance = registry.requireInstance(definition.instanceId);
  const context = { sessionId: parseAgentSessionId('unsupported:session'), workingDirectory: '/fixture', configuration, onBindingCreated() {} };
  await assert.rejects(async () => instance.adapter.createSession({ ...context, output: output() }), hasCode('structured_output_unsupported'));
  assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize']);
  const session = await instance.adapter.createSession(context);
  assert.throws(() => session.startTurn({ ...turnInput(), output: output() }), hasCode('structured_output_unsupported'));
  assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize', 'session/new']);
});

test('the selected public provider forwards each exact schema, ignores assistant JSON, then resets to plain output', async (t) => {
  let prompts = 0;
  const peer = createSessionPeer({ initializeResult: initialize, onPrompt(peer, frame) {
    prompts += 1;
    peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"title":"Untrusted assistant text"}' } }));
    respond(peer, frame, prompts === 1 ? { sessionId: peer.sessionId, structuredOutput: { title: 'Payment failures' } }
      : prompts === 2 ? { sessionId: peer.sessionId, structuredOutput: { rank: 3 } } : { structuredOutput: { title: 'Ignored plain metadata' } });
  } });
  t.after(() => peer.dispose());
  const { registry, instance, session } = await openMapped(peer);
  t.after(() => registry.dispose());
  assert.equal(instance.capabilities.turns.structuredOutput.kind, 'supported');
  await assert.rejects(async () => instance.adapter.createSession({ sessionId: parseAgentSessionId('wrong:scope'),
    workingDirectory: '/fixture', configuration, onBindingCreated() {}, output: output() }), hasCode('structured_output_scope_mismatch'));
  const completions: AgentTurnCompletedPayload[] = [];
  for (const [index, request] of [output(), output(rankSchema), undefined].entries()) {
    const outputs = events(await collect(session.startTurn({ ...turnInput(`structured:${index}`), ...(request ? { output: request } : {}) }).outputs));
    const terminal = outputs.filter((event) => event.type === 'turn.completed');
    assert.equal(terminal.length, 1);
    assert.equal(outputs.at(-1)?.type, 'turn.completed');
    completions.push(terminal[0]!.payload);
  }
  assert.deepEqual(completions, [
    { outcome: 'completed', structuredOutput: { kind: 'json', value: { title: 'Payment failures' } } },
    { outcome: 'completed', structuredOutput: { kind: 'json', value: { rank: 3 } } },
    { outcome: 'completed', structuredOutput: { kind: 'not_requested' } },
  ]);
  assert.deepEqual(peer.frames.filter((frame) => frame.method === 'session/prompt').map((frame) => frame.params), [
    { sessionId: peer.sessionId, prompt: [{ type: 'text', text: 'hello' }], _meta: { outputSchema: titleSchema } },
    { sessionId: peer.sessionId, prompt: [{ type: 'text', text: 'hello' }], _meta: { outputSchema: rankSchema } },
    { sessionId: peer.sessionId, prompt: [{ type: 'text', text: 'hello' }] },
  ]);
});

for (const failure of ['wrong_response', 'duplicate_response', 'response_loss'] as const) {
  test(`structured ${failure} cannot escape the existing transport correlation and stream owner`, async () => {
    let releases = 0;
    const peer = createSessionPeer({ initializeResult: initialize, owned: true, onRelease: () => { releases += 1; }, onPrompt(peer, frame) {
      if (failure === 'response_loss') { peer.stdout.end(); return; }
      const response = { jsonrpc: '2.0', id: failure === 'wrong_response' ? 'wrong-rpc-id' : frame.id,
        result: { stopReason: 'end_turn', _meta: { structuredOutput: { title: 'Never successful' } } } };
      peer.batch(failure === 'duplicate_response' ? [response, response] : [response]);
    } });
    const { registry, session } = await openMapped(peer);
    try {
      const execution = session.startTurn({ ...turnInput(), output: output() });
      await assert.rejects(() => collect(execution.outputs), failure === 'response_loss'
        ? hasCode('acp_provider_peer_closed') : hasCode('acp_orphan_or_late_response'));
      assert.throws(() => session.startTurn(turnInput('after:lost')), AgentProviderContractError);
    } finally { await registry.dispose(); peer.dispose(); }
    assert.equal(releases, 1);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
    assert.equal(peer.stdout.destroyed, true);
  });
}

const failureCases = [
  { name: 'absent metadata', reason: 'missing_output' },
  { name: 'unrelated metadata', meta: { usage: {} }, reason: 'missing_output' },
  { name: 'wrong shape', meta: { structuredOutput: { wrong: 'value' } }, reason: 'schema_mismatch' },
  { name: 'parsed null', meta: { structuredOutput: null }, reason: 'schema_mismatch' },
  { name: 'JSON text instead of a native value', meta: { structuredOutput: '{"title":"text"}' }, reason: 'schema_mismatch' },
  { name: 'overlarge value', meta: { structuredOutput: { title: 'x'.repeat(16_384) } }, reason: 'output_limit_exceeded' },
  { name: 'overlarge metadata', meta: { structuredOutput: { title: 'Fits' }, unrelated: 'x'.repeat(32_768) }, reason: 'output_limit_exceeded' },
  { name: 'native schema validation error', meta: { structuredOutputError: 'output does not match the required schema: native detail' }, reason: 'provider_error' },
  { name: 'untyped native retry error', meta: { structuredOutputError: 'retry limit reached for schema validation' }, reason: 'provider_error' },
  { name: 'refusal with an otherwise valid value', stop: 'refusal', meta: { structuredOutput: { title: 'Withheld' } }, reason: 'refused', nativeReason: 'The agent declined the request.' },
  { name: 'token truncation with an otherwise valid value', stop: 'max_tokens', meta: { structuredOutput: { title: 'Withheld' } }, reason: 'incomplete', nativeReason: 'The agent reached its token limit.' },
  { name: 'request limit', stop: 'max_turn_requests', meta: { structuredOutput: { title: 'Withheld' } }, reason: 'incomplete', nativeReason: 'The agent reached its request limit.' },
  { name: 'native cancellation', stop: 'cancelled', meta: { structuredOutput: { title: 'Withheld' } }, reason: 'incomplete', outcome: 'canceled' },
] as const;

for (const fixture of failureCases) {
  test(`the public structured mapping preserves ${fixture.name} without retries or assistant-text fallback`, async (t) => {
    const peer = createSessionPeer({ initializeResult: initialize, onPrompt(peer, frame) {
      peer.send(peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"title":"Not authoritative"}' } }));
      respond(peer, frame, 'meta' in fixture ? fixture.meta : undefined, 'stop' in fixture ? fixture.stop : undefined);
    } });
    t.after(() => peer.dispose());
    const { registry, session } = await openMapped(peer);
    t.after(() => registry.dispose());
    const observed = events(await collect(session.startTurn({ ...turnInput(), output: output() }).outputs));
    const terminal = observed.find((event) => event.type === 'turn.completed');
    assert.ok(terminal?.type === 'turn.completed');
    assert.equal(terminal.payload.outcome, 'outcome' in fixture ? fixture.outcome : 'completed');
    assert.equal(terminal.payload.reason, 'nativeReason' in fixture ? fixture.nativeReason : undefined);
    const structured = terminal.payload.structuredOutput;
    assert.equal(structured.kind, 'unavailable');
    if (structured.kind !== 'unavailable') throw new Error('Expected unavailable structured output.');
    assert.equal(structured.reason, fixture.reason);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
  });
}

for (const [name, meta, reasonCode] of [
  ['value and error together', { structuredOutput: { title: 'Ambiguous' }, structuredOutputError: 'invalid' }, 'acp_structured_output_ambiguous'],
  ['null error', { structuredOutputError: null }, 'acp_structured_output_error_invalid'],
  ['object error', { structuredOutputError: {} }, 'acp_structured_output_error_invalid'],
  ['empty error', { structuredOutputError: ' ' }, 'acp_structured_output_error_invalid'],
  ['overlarge error', { structuredOutputError: 'x'.repeat(4_097) }, 'acp_structured_output_error_invalid'],
  ['wrong native session', { sessionId: 'other-session', structuredOutput: { title: 'Wrong session' } }, 'acp_structured_output_identity_mismatch'],
] as const) {
  test(`the selected mapping fences malformed ${name} and releases its owned connection`, async () => {
    let releases = 0;
    const peer = createSessionPeer({ initializeResult: initialize, owned: true, onRelease: () => { releases += 1; },
      onPrompt(peer, frame) { respond(peer, frame, meta); } });
    const { registry, session } = await openMapped(peer);
    try {
      await assert.rejects(() => collect(session.startTurn({ ...turnInput(), output: output() }).outputs), hasCode(reasonCode));
      assert.throws(() => session.startTurn(turnInput('after:failure')), AgentProviderContractError);
    } finally { await registry.dispose(); peer.dispose(); }
    assert.equal(releases, 1);
    assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
    assert.equal(peer.stdout.destroyed, true);
  });
}

test('structured prompt RPC failure preserves the native execution error and supplies no value', async (t) => {
  const peer = createSessionPeer({ initializeResult: initialize, onPrompt(peer, frame) {
    peer.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'Untrusted native diagnostics' } });
  } });
  t.after(() => peer.dispose());
  const { registry, session } = await openMapped(peer);
  t.after(() => registry.dispose());
  const completed = events(await collect(session.startTurn({ ...turnInput(), output: output() }).outputs))
    .find((event) => event.type === 'turn.completed');
  assert.deepEqual(completed?.payload, { outcome: 'failed', structuredOutput: { kind: 'unavailable', reason: 'provider_error' },
    error: { category: 'provider', code: 'provider_internal_error', message: 'The agent encountered an internal error while processing the prompt.', recovery: { kind: 'unknown' } } });
  assert.equal(peer.frames.filter((frame) => frame.method === 'session/prompt').length, 1);
});

test('the public conformance runner proves selected native structured schema changes and the ordinary-turn reset', { timeout: 5_000 }, async (t) => {
  const peers: SessionPeer[] = [];
  t.after(() => { for (const peer of peers) peer.dispose(); });
  const driver = createAcpProviderDriver({ providerKey, structuredOutputMapping: mapping, createConnection() {
    const peer = createSessionPeer({ initializeResult: initialize, onPrompt(peer, frame) {
      const text = (frame.params?.prompt as { text: string }[])[0]?.text;
      if (text === 'hold') return;
      if (text === 'title') respond(peer, frame, { structuredOutput: { title: 'Conformance title' } });
      else if (text === 'rank') respond(peer, frame, { structuredOutput: { rank: 4 } });
      else peer.complete();
    } });
    peers.push(peer);
    return peer.lease;
  } });
  const report = await runAgentProviderConformance({ driver, definition, workingDirectory: '/fixture', configuration,
    createSessionId: parseAgentSessionId('conformance:create'), resumeSessionId: parseAgentSessionId('conformance:resume'),
    abortedSessionId: parseAgentSessionId('conformance:aborted'), interruptionSessionId: parseAgentSessionId('conformance:interrupt'),
    turn: turnInput('conformance:plain'), interruptionTurn: turnInput('conformance:held', 'hold'), resolutionFor: selection,
    structuredOutput: { sessionId: parseAgentSessionId('conformance:structured'), plainSessionId: parseAgentSessionId('conformance:reset'),
      schema: titleSchema, alternateSchema: rankSchema,
      turns: [{ turn: turnInput('conformance:title', 'title'), expectedValue: { title: 'Conformance title' } },
        { turn: turnInput('conformance:rank', 'rank'), expectedValue: { rank: 4 } }],
      plainTurn: turnInput('conformance:after:structured'),
    },
  });
  assert.equal(report.providerKey, providerKey);
  assert.ok(report.checks.includes('structured_output'));
  assert.ok(report.checks.includes('structured_output_lifetime'));
  assert.deepEqual(peers[1]!.frames.filter((frame) => frame.method === 'session/prompt').map((frame) => frame.params?._meta), [
    { outputSchema: titleSchema }, { outputSchema: rankSchema }, undefined,
  ]);
});
