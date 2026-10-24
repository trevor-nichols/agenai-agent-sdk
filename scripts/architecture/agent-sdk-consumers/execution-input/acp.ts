// ------------------------------------------------------------------------------------------------
//                acp.ts - Actual packed ACP constructors keep execution input unsupported
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionId, parseAgentTurnId,
} from '@agen-ai/agent-protocol';
import type { AcpJsonObject } from '@agen-ai/acp-transport';
import {
  createAgentProviderRegistry, parseAgentExecutionInputMessageId,
  type AgentProviderOutput, type AgentProviderTurnExecution, type AgentProviderRegistry,
} from '@agen-ai/agent-runtime';
import { createAcpProviderDriver, type AcpStructuredOutputMappingSelection } from '@agen-ai/provider-acp';
import { createUnsupportedInputPeer, nativeSessionId, unsolicitedInputId } from './peer.js';

async function tryInput(execution: AgentProviderTurnExecution) {
  if (execution.input?.kind !== 'supported') return { status: 'unsupported' } as const;
  return execution.input.sendMessage({ messageId: parseAgentExecutionInputMessageId('packed-unsupported-update'),
    parts: [{ type: 'text', text: 'Change the answer.' }] });
}

const profiles: readonly Readonly<{
  name: string;
  initialization: AcpJsonObject;
  structuredOutputMapping?: AcpStructuredOutputMappingSelection;
}>[] = [
  { name: 'generic-acp', initialization: { protocolVersion: 1, agentCapabilities: {}, authMethods: [],
    agentInfo: { name: 'packed-generic-acp', version: '1.0.0' } } },
  { name: 'grok-labels-and-adverts', initialization: { protocolVersion: 1, authMethods: [],
    agentCapabilities: { _meta: { executionInput: { kind: 'supported' } } },
    agentInfo: { name: 'grok', version: '1.0.67' }, _meta: { grokShell: true, agentVersion: '1.0.67',
      extensions: ['_x.ai/interject', '_x.ai/session/interjection', '_x.ai/queue/changed'] } } },
  { name: 'grok-1.0.62-structured-output', structuredOutputMapping: { mapping: 'grok-build-1.0.62-structured-output-v1' },
    initialization: { protocolVersion: 1, agentCapabilities: {}, authMethods: [],
      agentInfo: { name: 'grok', version: '1.0.62' }, _meta: { grokShell: true, agentVersion: '1.0.62' } } },
];

const consumerRoot = fileURLToPath(new URL('../../', import.meta.url));
const privateRoot = process.argv[2];
assert.ok(privateRoot, 'The caller must identify the excluded private checkout.');
for (const name of ['@agen-ai/agent-protocol', '@agen-ai/agent-runtime', '@agen-ai/provider-acp', '@agen-ai/acp-transport']) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(name)));
  assert.ok(resolved.startsWith(join(consumerRoot, 'node_modules') + sep));
  assert.equal(resolved.startsWith(privateRoot + sep), false);
}

const scenarios = [];
for (const profile of profiles) for (const ownership of ['borrowed', 'owned'] as const) {
  const peer = createUnsupportedInputPeer(profile.initialization, ownership);
  const driver = createAcpProviderDriver({ providerKey: `packed-input-${profile.name}-${ownership}`,
    createConnection: () => peer.lease,
    limits: { initializationTimeoutMs: 2_000 },
    ...(profile.structuredOutputMapping ? { structuredOutputMapping: profile.structuredOutputMapping } : {}),
  });
  const instanceId = parseAgentInstanceId(`${driver.providerKey}:primary`);
  let registry: AgentProviderRegistry | undefined;
  try {
    registry = await createAgentProviderRegistry({ drivers: [driver],
      definitions: [{ providerKey: driver.providerKey, instanceId, driverConfiguration: {} }] });
    const instance = registry.requireInstance(instanceId);
    assert.equal(instance.adapter.executionInput?.kind ?? 'unsupported', 'unsupported');
    assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize']);
    const session = await instance.adapter.createSession({ sessionId: parseAgentSessionId('packed-input-session'),
      workingDirectory: '/packed-input', configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('packed-input-config') },
      onBindingCreated() {} });
    const execution = session.startTurn({ turnId: parseAgentTurnId('packed-original-turn'), interactionMode: 'default',
      parts: [{ type: 'text', text: 'Keep the original prompt.' }], deadlineAt: new Date(Date.now() + 5_000).toISOString() });
    const before = await tryInput(execution);
    assert.deepEqual(before, { status: 'unsupported' });
    assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize', 'session/new']);
    const iterator = execution.outputs[Symbol.asyncIterator]();
    assert.throws(() => execution.outputs[Symbol.asyncIterator](), { code: 'concurrent_turn' });
    const observed: AgentProviderOutput[] = [];
    for (;;) {
      const next = await iterator.next();
      assert.equal(next.done, false, 'The original prompt must produce text before completion.');
      if (next.done) throw new Error('The original packed prompt ended before output.');
      observed.push(next.value);
      assert.ok(observed.length <= 16);
      if (next.value.kind === 'event' && next.value.event.type === 'content.delta') break;
    }
    await peer.inputAnswered;
    assert.equal(instance.adapter.executionInput?.kind ?? 'unsupported', 'unsupported');
    const during = await tryInput(execution);
    assert.deepEqual(during, { status: 'unsupported' });
    peer.complete();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      observed.push(next.value);
      assert.ok(observed.length <= 16);
    }
    const after = await tryInput(execution);
    assert.deepEqual(after, { status: 'unsupported' });
    const events = observed.flatMap((output) => output.kind === 'event' ? [output.event] : []);
    assert.deepEqual(events.filter((event) => event.type === 'turn.started').map((event) => event.turnId), [execution.turnId]);
    assert.deepEqual(events.flatMap((event) => event.type === 'content.delta' ? [event.payload.delta] : []), ['Original packed prompt output.']);
    assert.deepEqual(events.filter((event) => event.type === 'turn.completed').map((event) => event.payload), [
      { outcome: 'completed', structuredOutput: { kind: 'not_requested' } },
    ]);
    assert.equal(events.at(-1)?.type, 'turn.completed');
    await session.close({ reason: 'shutdown' });
    await registry.dispose();
    assert.deepEqual(peer.frames.map((frame) => frame.method), ['initialize', 'session/new', 'session/prompt', undefined]);
    assert.deepEqual(peer.frames.find((frame) => frame.method === 'session/prompt')?.params,
      { sessionId: nativeSessionId, prompt: [{ type: 'text', text: 'Keep the original prompt.' }] });
    assert.deepEqual(peer.frames.filter((frame) => frame.method === undefined), [
      { id: unsolicitedInputId, error: { code: -32601, message: 'Method not found' } },
    ]);
    assert.equal(peer.releases(), ownership === 'owned' ? 1 : 0);
    assert.equal(peer.stdout.destroyed, ownership === 'owned');
    assert.equal(peer.stdin.destroyed, ownership === 'owned');
    if (ownership === 'borrowed') assert.equal(peer.stdin.writableEnded, false);
    assert.equal(peer.stdout.listenerCount('data'), 0);
    scenarios.push({ profile: profile.name, ownership, input: [before.status, during.status, after.status],
      readers: 1, turns: 1, nativePrompts: 1, nativeInputRequests: 0, unknownInputReply: -32601,
      output: 'Original packed prompt output.', terminalCount: 1, ownedReleases: peer.releases(),
      borrowedStreamsPreserved: ownership === 'borrowed', cleanup: 'joined' });
  } finally {
    try { await registry?.dispose(); } finally { peer.dispose(); }
  }
}
process.stdout.write(JSON.stringify({ proof: 'packed-acp-execution-input-unsupported', evidence: 'synthetic-peer', scenarios }) + '\n');
