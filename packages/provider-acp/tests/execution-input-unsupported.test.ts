import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentSessionId } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry, parseAgentExecutionInputMessageId, type AgentProviderTurnExecution } from '@agen-ai/agent-runtime';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import { createAcpProviderDriver, type AcpStructuredOutputMappingSelection } from '../src/index.js';
import { collectRemaining, createSessionPeer } from './fixtures/session-peer.js';
import { configuration, definition, events, providerKey, turnInput } from './fixtures/session-runtime.js';

async function tryInput(execution: AgentProviderTurnExecution) {
  if (execution.input?.kind !== 'supported') return { status: 'unsupported' } as const;
  return execution.input.sendMessage({
    messageId: parseAgentExecutionInputMessageId('unsupported:update'),
    parts: [{ type: 'text', text: 'Change the requested answer.' }],
  });
}

const profiles: readonly Readonly<{
  name: string;
  initializeResult?: AcpJsonObject;
  structuredOutputMapping?: AcpStructuredOutputMappingSelection;
}>[] = [
  { name: 'generic ACP' },
  { name: 'Grok labels and advertised input extensions', initializeResult: {
    protocolVersion: 1, agentCapabilities: { _meta: { executionInput: { kind: 'supported' } } }, authMethods: [],
    agentInfo: { name: 'grok', version: '1.0.67' },
    _meta: { grokShell: true, agentVersion: '1.0.67', extensions: ['_x.ai/interject', '_x.ai/session/interjection', '_x.ai/queue/changed'] },
  } },
  { name: 'selected Grok 1.0.62 structured output', structuredOutputMapping: { mapping: 'grok-build-1.0.62-structured-output-v1' },
    initializeResult: { protocolVersion: 1, agentCapabilities: {}, authMethods: [],
      agentInfo: { name: 'grok', version: '1.0.62' }, _meta: { grokShell: true, agentVersion: '1.0.62' } } },
];

for (const profile of profiles) for (const ownership of ['borrowed', 'owned'] as const) {
  test(`${profile.name} with ${ownership} streams declines execution input without interjection or extra prompts`, { timeout: 5_000 }, async (t) => {
    let releases = 0;
    const unknownRequestAnswered = Promise.withResolvers<void>();
    const peer = createSessionPeer({
      owned: ownership === 'owned', onRelease: () => { releases += 1; }, initializeResult: profile.initializeResult,
      onPrompt(peer) {
        peer.batch([
          { jsonrpc: '2.0', method: '_x.ai/queue/changed', params: { sessionId: peer.sessionId,
            entries: [{ id: 'unowned:command', status: 'queued' }] } },
          { jsonrpc: '2.0', method: '_x.ai/session/interjection', params: { sessionId: peer.sessionId,
            interjectionId: 'unsupported:update', text: 'Change the requested answer.', status: 'queued' } },
          { jsonrpc: '2.0', id: 'unregistered:input', method: '_x.ai/interject', params: { sessionId: peer.sessionId,
            interjectionId: 'unsupported:update', text: 'Change the requested answer.' } },
          peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Original prompt output.' } }),
        ]);
      },
      onResolution(_peer, frame) { if (frame.id === 'unregistered:input') unknownRequestAnswered.resolve(); },
    });
    t.after(() => peer.dispose());
    const driver = createAcpProviderDriver({ providerKey, createConnection: () => peer.lease,
      ...(profile.structuredOutputMapping ? { structuredOutputMapping: profile.structuredOutputMapping } : {}) });
    const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [definition] });
    t.after(() => registry.dispose());
    const instance = registry.requireInstance(definition.instanceId);
    assert.equal(instance.adapter.executionInput?.kind ?? 'unsupported', 'unsupported');
    assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize']);
    const session = await instance.adapter.createSession({ sessionId: parseAgentSessionId('unsupported:session'),
      workingDirectory: '/fixture', configuration, onBindingCreated() {} });
    const execution = session.startTurn(turnInput());
    assert.deepEqual(await tryInput(execution), { status: 'unsupported' });
    assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize', 'session/new']);

    const iterator = execution.outputs[Symbol.asyncIterator]();
    const observed = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) assert.fail('Expected the original prompt output before completion.');
      observed.push(next.value);
      if (next.value.kind === 'event' && next.value.event.type === 'content.delta') break;
    }
    await unknownRequestAnswered.promise;
    assert.equal(instance.adapter.executionInput?.kind ?? 'unsupported', 'unsupported');
    assert.deepEqual(await tryInput(execution), { status: 'unsupported' });
    peer.complete();
    observed.push(...await collectRemaining(iterator));
    assert.deepEqual(await tryInput(execution), { status: 'unsupported' });
    const outputEvents = events(observed);
    assert.deepEqual(outputEvents.filter((event) => event.type === 'turn.started').map((event) => event.turnId), [execution.turnId]);
    assert.deepEqual(outputEvents.flatMap((event) => event.type === 'content.delta' ? [event.payload.delta] : []), ['Original prompt output.']);
    assert.deepEqual(outputEvents.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [
      { outcome: 'completed', structuredOutput: { kind: 'not_requested' } },
    ]);
    assert.equal(outputEvents.at(-1)?.type, 'turn.completed');
    await session.close({ reason: 'shutdown' });
    await registry.dispose();

    assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize', 'session/new', 'session/prompt', undefined]);
    assert.deepEqual(peer.frames.find((frame) => frame.method === 'session/prompt')?.params,
      { sessionId: peer.sessionId, prompt: [{ type: 'text', text: 'hello' }] });
    assert.deepEqual(peer.frames.filter((frame) => !frame.method), [
      { jsonrpc: '2.0', id: 'unregistered:input', error: { code: -32601, message: 'Method not found' } },
    ]);
    assert.equal(releases, ownership === 'owned' ? 1 : 0);
    assert.equal(peer.stdout.destroyed, ownership === 'owned');
    assert.equal(peer.stdin.destroyed, ownership === 'owned');
    assert.equal(peer.stdout.listenerCount('data'), 0);
  });
}
