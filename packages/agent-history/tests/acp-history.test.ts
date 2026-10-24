import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcpStandardSessionOperations } from '@agen-ai/acp-transport';
import { createAcpHistory, type AcpHistoryConnection } from '../dist/acp.js';
import { parseAgentHistorySourceIdentity } from '../dist/index.js';
import type { AgentHistory } from '../src/index.js';
import { acpHistoryInitialization, createAcpHistoryPeer, type AcpHistoryPeerRequest,
  type AcpHistoryPeerResponse } from './helpers/acp-peer.js';

const projectPath = '/synthetic/acp/project';
const rows = [
  { sessionId: 'peer-alpha', cwd: projectPath, title: 'Alpha saved session', updatedAt: '2026-10-21T00:00:02Z' },
  { sessionId: 'peer-beta', cwd: projectPath, title: 'Beta saved session', updatedAt: '2026-10-21T00:00:01Z' },
  { sessionId: 'peer-gamma', cwd: projectPath, title: 'Gamma saved session', updatedAt: '2026-10-21T00:00:00Z' },
];
function code(expected: string) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}
function catalog(history: AgentHistory) {
  if (history.catalog.status !== 'supported') assert.fail('The observed ACP peer advertises listing.');
  return history.catalog.list;
}
async function fixture(respond: (request: AcpHistoryPeerRequest) => AcpHistoryPeerResponse | Promise<AcpHistoryPeerResponse>, list = true) {
  const peer = createAcpHistoryPeer({ respond: (request) => request.method === 'initialize'
    ? { result: acpHistoryInitialization(list, 'grok') } : respond(request) });
  const operations = createAcpStandardSessionOperations(peer.client);
  const initialization = await operations.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const connection: AcpHistoryConnection = { protocolProfile: 'schema-v1.23.0', initialization,
    resources: { kind: 'caller_owned', maxInboundFrameBytes: 1_048_576 },
    listSessions: (params, options) => operations.listSessions({ ...params }, options) };
  const history = createAcpHistory({ providerKey: parseAgentHistorySourceIdentity({ providerKey: 'grok', sourceId: 'peer', generation: 'one' }).providerKey,
    sourceId: 'peer', generation: 'one', scope: { kind: 'project', projectPath, worktrees: 'excluded' }, connection });
  return { peer, history, initialization };
}

test('ACP negotiated discovery traverses native pages without acquiring transcript or execution capabilities', async (t) => {
  const { peer, history, initialization } = await fixture((request) => {
    if (request.method !== 'session/list') return { error: { code: -32601, message: 'Method not found' } };
    const cursor = request.params !== null && typeof request.params === 'object' && 'cursor' in request.params ? request.params.cursor : undefined;
    return { result: cursor === undefined ? { sessions: rows.slice(0, 2), nextCursor: 'native-page-two' } : { sessions: rows.slice(2), nextCursor: null } };
  });
  t.after(() => peer.close()); t.after(() => history.close());
  peer.sendNotification('_synthetic/progress', { inert: true });
  const summaries = [];
  let cursor: string | undefined;
  for (let index = 0; index < 3; index += 1) {
    const page = await catalog(history)({ limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.items.length, 1);
    summaries.push(...page.items);
    assert.deepEqual(page.coverage, { view: 'catalog', children: 'unknown', omissions: ['provider_omission'] });
    cursor = page.nextCursor;
    if (index < 2) assert.equal(typeof cursor, 'string');
  }
  assert.equal(cursor, undefined);
  assert.deepEqual(summaries.map((summary) => ({ id: summary.ref.conversationId, title: summary.title,
    updatedAt: summary.updatedAt, projectPath: summary.projectPath, archiveState: summary.archiveState })), rows.map((row) => ({
    id: row.sessionId, title: row.title, updatedAt: row.updatedAt, projectPath, archiveState: 'unknown',
  })));
  assert.equal(history.lookup.status, 'unsupported');
  assert.equal(history.transcript.status, 'unsupported');
  assert.equal(history.views.status, 'unsupported');
  await history.close();
  assert.deepEqual(await peer.client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }), initialization);
  assert.deepEqual(peer.requests.map((request) => request.method), ['initialize', 'session/list', 'session/list', 'session/list', 'initialize']);
  for (const request of peer.requests.filter((request) => request.method === 'session/list')) {
    assert.equal(request.params !== null && typeof request.params === 'object' && 'cwd' in request.params ? request.params.cwd : undefined, projectPath);
  }
});

test('ACP absent list negotiation stays unsupported even when the peer identifies itself as Grok', async (t) => {
  const { peer, history } = await fixture(() => ({ result: { sessions: rows } }), false);
  t.after(() => peer.close()); t.after(() => history.close());
  assert.equal(history.catalog.status, 'unsupported');
  assert.equal(history.transcript.status, 'unsupported');
  await history.close();
  assert.deepEqual(await peer.client.request('session/list', { cwd: projectPath }), { sessions: rows });
  assert.deepEqual(peer.requests.map((request) => request.method), ['initialize', 'session/list']);
});

test('ACP continuation rejects changed native page content and project widening before publishing rows', async (t) => {
  let changed = false;
  const { peer, history } = await fixture(() => ({ result: { sessions: changed ? [rows[1], rows[0]] : rows.slice(0, 2) } }));
  t.after(() => peer.close()); t.after(() => history.close());
  const first = await catalog(history)({ limit: 1 });
  assert.deepEqual(first.items.map((summary) => summary.ref.conversationId), ['peer-alpha']);
  if (first.nextCursor === undefined) assert.fail('The native page contains an unread second session.');
  changed = true;
  await assert.rejects(catalog(history)({ limit: 1, cursor: first.nextCursor }), code('invalid_cursor'));
  const dispatched = peer.requests.length;
  await assert.rejects(catalog(history)({ projectPath: '/synthetic/another-project' }), code('unsupported_scope'));
  await assert.rejects(catalog(history)({ archived: 'only' }), code('unsupported_scope'));
  assert.equal(peer.requests.length, dispatched);
});

test('ACP bounded native-page scanning returns a continuation instead of inventing an empty terminal catalog', async (t) => {
  let pageNumber = 0;
  const { peer, history } = await fixture(() => ({ result: { sessions: [], nextCursor: `native-page-${++pageNumber}` } }));
  t.after(() => peer.close()); t.after(() => history.close());
  const page = await catalog(history)({ limit: 1 });
  assert.deepEqual(page.items, []);
  assert.equal(typeof page.nextCursor, 'string');
  assert.equal(peer.requests.filter((request) => request.method === 'session/list').length, 8);
});

test('ACP rejects native cursor loops and out-of-scope rows without disposing the borrowed transport', async (t) => {
  for (const kind of ['loop', 'foreign'] as const) {
    const { peer, history, initialization } = await fixture((request) => {
      const next = request.params !== null && typeof request.params === 'object' && 'cursor' in request.params ? request.params.cursor : 'same-page';
      return { result: kind === 'loop' ? { sessions: [], nextCursor: next } : { sessions: [{ sessionId: 'foreign', cwd: '/synthetic/foreign' }] } };
    });
    t.after(() => peer.close()); t.after(() => history.close());
    await assert.rejects(catalog(history)({ limit: 1 }), code(kind === 'loop' ? 'native_failure' : 'unsupported_scope'));
    await history.close();
    assert.deepEqual(await peer.client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }), initialization);
  }
});

test('ACP cancellation and source close retire entered history requests while leaving the caller transport usable', { timeout: 10_000 }, async (t) => {
  for (const interruption of ['cancel', 'close'] as const) {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const { peer, history, initialization } = await fixture(async () => {
      entered.resolve(); await release.promise; return { result: { sessions: rows } };
    });
    t.after(async () => { release.resolve(); await history.close(); await peer.close(); });
    const controller = new AbortController();
    const reading = catalog(history)({ limit: 1 }, { signal: controller.signal });
    const rejected = assert.rejects(reading, code(interruption === 'cancel' ? 'cancelled' : 'closed'));
    await entered.promise;
    const cancelled = peer.nextNotification();
    if (interruption === 'cancel') controller.abort();
    const closing = history.close();
    await rejected;
    const request = peer.requests.find((value) => value.method === 'session/list');
    if (request === undefined) assert.fail('The real ACP transport dispatched the held history request.');
    assert.deepEqual(await cancelled, { method: '$/cancel_request', params: { requestId: request.id } });
    release.resolve(); await closing;
    assert.deepEqual(await peer.client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }), initialization);
    assert.deepEqual(peer.requests.map((request) => request.method), ['initialize', 'session/list', 'initialize']);
  }
});
