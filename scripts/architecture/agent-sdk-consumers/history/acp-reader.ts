import assert from 'node:assert/strict';
import { createAcpStandardSessionOperations } from '@agen-ai/acp-transport';
import { createAcpHistory, type AcpHistoryConnection } from '@agen-ai/agent-history/acp';
import { parseAgentHistorySourceIdentity, type AgentHistoryCatalogPage } from '@agen-ai/agent-history';
import { acpHistoryInitialization, createAcpHistoryPeer } from './acp-peer.js';
import { proveBrowseExample } from './browse-example.js';

export async function proveAcpHistory() {
  const projectPath = '/synthetic/packed-acp';
  const sessions = [
    { sessionId: 'peer-alpha', cwd: projectPath, title: 'Packed Alpha', updatedAt: '2026-10-21T00:00:02Z' },
    { sessionId: 'peer-beta', cwd: projectPath, title: 'Packed Beta', updatedAt: '2026-10-21T00:00:01Z' },
    { sessionId: 'peer-gamma', cwd: projectPath, title: 'Packed Gamma', updatedAt: '2026-10-21T00:00:00Z' },
  ];
  const peer = createAcpHistoryPeer({ respond: (request) => {
    if (request.method === 'initialize') return { result: acpHistoryInitialization(true, 'packed-generic-agent') };
    if (request.method !== 'session/list') return { error: { code: -32601, message: 'Method not found' } };
    const cursor = request.params !== null && typeof request.params === 'object' && 'cursor' in request.params ? request.params.cursor : undefined;
    return { result: cursor === undefined ? { sessions: sessions.slice(0, 2), nextCursor: 'native-next' } : { sessions: sessions.slice(2) } };
  } });
  const operations = createAcpStandardSessionOperations(peer.client);
  const initialization = await operations.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const connection: AcpHistoryConnection = { protocolProfile: 'schema-v1.23.0', initialization,
    resources: { kind: 'caller_owned', maxInboundFrameBytes: 1_048_576 },
    listSessions: (params, options) => operations.listSessions({ ...params }, options) };
  const providerKey = parseAgentHistorySourceIdentity({ providerKey: 'synthetic-acp', sourceId: 'packed', generation: 'one' }).providerKey;
  const history = createAcpHistory({ providerKey, sourceId: 'packed', generation: 'one',
    scope: { kind: 'project', projectPath, worktrees: 'excluded' }, connection });
  try {
    if (history.catalog.status !== 'supported') throw new Error('Negotiated packed ACP catalog unavailable');
    const catalogIds: string[] = [], titles: (string | undefined)[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 3; index += 1) {
      const page: AgentHistoryCatalogPage = await history.catalog.list({ limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      assert.equal(page.items.length, 1);
      assert.deepEqual(page.coverage, { view: 'catalog', children: 'unknown', omissions: ['provider_omission'] });
      catalogIds.push(...page.items.map((item) => item.ref.conversationId));
      titles.push(...page.items.map((item) => item.title));
      cursor = page.nextCursor;
      if (index < 2) assert.equal(typeof cursor, 'string');
    }
    assert.equal(cursor, undefined);
    assert.deepEqual(catalogIds, ['peer-alpha', 'peer-beta', 'peer-gamma']);
    assert.deepEqual(titles, ['Packed Alpha', 'Packed Beta', 'Packed Gamma']);
    assert.equal(history.lookup.status, 'unsupported');
    assert.equal(history.transcript.status, 'unsupported');
    const browseExample = await proveBrowseExample(history, 'peer-alpha',
      { catalogCount: 3, transcript: { status: 'unsupported' } });
    await history.close();
    assert.deepEqual(await operations.initialize({ protocolVersion: 1, clientCapabilities: {} }), initialization);

    const absentPeer = createAcpHistoryPeer({ respond: () => ({ result: acpHistoryInitialization(false, 'grok') }) });
    try {
      const absentOperations = createAcpStandardSessionOperations(absentPeer.client);
      const absentInitialization = await absentOperations.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const absent = createAcpHistory({ providerKey, sourceId: 'absent', generation: 'one',
        scope: { kind: 'project', projectPath, worktrees: 'excluded' },
        connection: { ...connection, initialization: absentInitialization,
          listSessions: (params, options) => absentOperations.listSessions({ ...params }, options) } });
      try { assert.equal(absent.catalog.status, 'unsupported'); assert.equal(absent.transcript.status, 'unsupported'); }
      finally { await absent.close(); }
      assert.deepEqual(absentPeer.requests.map((request) => request.method), ['initialize']);
    } finally { await absentPeer.close(); }
    const executionMethods = peer.requests.filter((request) => !['initialize', 'session/list'].includes(request.method)).map((request) => request.method);
    assert.deepEqual(executionMethods, []);
    return { catalogIds, transcript: 'unsupported', absentCatalog: 'unsupported', callerTransportSurvived: true, executionMethods, browseExample };
  } finally { await history.close(); await peer.close(); }
}
