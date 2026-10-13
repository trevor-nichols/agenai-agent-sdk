import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentSessionId } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { runAgentProviderConformance } from '@agen-ai/agent-runtime/testing';
import { createAcpProviderDriver } from '../src/index.js';
import { createSessionPeer, type SessionPeer } from './fixtures/session-peer.js';

import { configuration, definition, providerKey, selection, turnInput } from './fixtures/session-runtime.js';

test('binding callback failure preserves the original error and releases the created native session', { timeout: 3_000 }, async () => {
  let released = 0;
  const peer = createSessionPeer({ owned: true, onRelease: () => { released += 1; } });
  const driver = createAcpProviderDriver({ providerKey, createConnection: () => peer.lease });
  const registry = await createAgentProviderRegistry({ drivers: [driver], definitions: [definition] });
  const original = new Error('binding publication failed');
  try {
    await assert.rejects(async () => registry.requireInstance(definition.instanceId).adapter.createSession({
      sessionId: parseAgentSessionId('fixture:session'), workingDirectory: '/fixture', configuration,
      onBindingCreated: () => { throw original; },
    }), (error) => error === original);
    assert.equal(released, 1);
    assert.equal(peer.stdout.destroyed, true);
  } finally { await registry.dispose(); }
});

test('the public runtime conformance runner validates the real ACP driver and session ports', { timeout: 5_000 }, async () => {
  const peers: SessionPeer[] = [];
  const driver = createAcpProviderDriver({ providerKey, createConnection() {
    const peer = createSessionPeer({ onPrompt(peer, frame) {
      const prompt = frame.params?.prompt as { text: string }[];
      if (prompt[0]?.text === 'hold') return;
      peer.send(peer.permission('conformance:permission', 'tool'));
    }, onResolution(peer) { peer.complete(); } });
    peers.push(peer);
    return peer.lease;
  } });
  try {
    const report = await runAgentProviderConformance({
      driver, definition, workingDirectory: '/fixture', configuration,
      createSessionId: parseAgentSessionId('conformance:create'), resumeSessionId: parseAgentSessionId('conformance:resume'),
      abortedSessionId: parseAgentSessionId('conformance:aborted'), interruptionSessionId: parseAgentSessionId('conformance:interrupt'),
      turn: turnInput('conformance:turn'), interruptionTurn: turnInput('conformance:held', 'hold'), resolutionFor: selection,
    });
    assert.equal(report.providerKey, providerKey);
    assert.ok(report.checks.includes('request_resolution'));
    assert.ok(report.checks.includes('interruption'));
    assert.ok(report.checks.includes('idempotent_disposal'));
  } finally { for (const peer of peers) peer.dispose(); }
});
