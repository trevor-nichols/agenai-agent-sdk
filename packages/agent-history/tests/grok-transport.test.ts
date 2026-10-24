import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcpExtensionRegistry } from '@agen-ai/acp-transport';
import { createGrokHistory, grokHistoryExtensions, type GrokHistoryConnection } from '../dist/grok.js';
import { parseAgentHistoryConversationRef } from '../dist/index.js';
import { acpHistoryInitialization, createAcpHistoryPeer } from './helpers/acp-peer.js';

test('Grok mapped extension failures remain visible and never fall back to load_history or execution methods', async (t) => {
  const sessionId = '70000001-1111-4111-8111-111111111111', projectPath = '/synthetic/grok';
  const initialization = { ...acpHistoryInitialization(true, 'synthetic-grok-history'),
    _meta: { agentVersion: '1.0.62', grokShell: true } };
  const peer = createAcpHistoryPeer({ extensions: createAcpExtensionRegistry(grokHistoryExtensions()), respond: (request) => {
    if (request.method === 'initialize') return { result: initialization };
    if (request.method === '_x.ai/session/state') return { result: { summary: {
      info: { id: sessionId, cwd: projectPath }, session_summary: 'Existing stored metadata',
      created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
    } } };
    return { error: { code: -32601, message: 'Method not found' } };
  } });
  t.after(() => peer.close());
  const observedInitialization = await peer.client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const connection: GrokHistoryConnection = { protocolProfile: 'schema-v1.23.0', runtimeVersion: '1.0.62',
    initialization: observedInitialization, resources: { kind: 'caller_owned', maxInboundFrameBytes: 1_048_576 },
    listSessions: (params, options) => peer.client.request('session/list', { ...params }, options),
    sessionState: (params, options) => peer.client.request('_x.ai/session/state', { ...params }, options),
    sessionUpdates: (params, options) => peer.client.request('_x.ai/session/updates', { ...params }, options) };
  const history = createGrokHistory({ sourceId: 'synthetic-peer', generation: 'one',
    scope: { kind: 'project', projectPath, worktrees: 'excluded' }, connection });
  t.after(() => history.close());
  if (history.lookup.status !== 'supported' || history.transcript.status !== 'supported') assert.fail('The selected exact-version mapping exposes independent metadata and update reads.');
  const conversation = parseAgentHistoryConversationRef({ source: { providerKey: history.source.providerKey,
    sourceId: history.source.sourceId, generation: history.source.generation }, conversationId: sessionId });
  assert.equal((await history.lookup.get({ conversation })).title, 'Existing stored metadata');
  await assert.rejects(history.transcript.read({ conversation, limit: 1 }), (error: unknown) => error !== null
    && typeof error === 'object' && 'code' in error && error.code === 'unsupported_scope');
  assert.deepEqual(peer.requests.map((request) => request.method).filter((method) => method !== '_x.ai/session/state'),
    ['initialize', '_x.ai/session/updates']);
  await history.close();
  assert.deepEqual(await peer.client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }), initialization);
});
