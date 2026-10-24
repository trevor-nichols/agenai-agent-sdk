import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { parseAgentProviderConversationId } from '@agen-ai/agent-protocol';
import { createOpenCodeHistory } from '../dist/opencode.js';
import type { AgentHistory, AgentHistoryConversationRef } from '../src/index.js';
import { createOpenCodeHttpPeer, openCodeHttpSession, openCodeJson } from './helpers/opencode-http-peer.js';

function options(baseUrl: string) {
  return { sourceId: 'opencode-http-fixture', generation: 'fixture-generation',
    scope: { kind: 'project' as const, projectPath: '/synthetic/opencode-project', worktrees: 'excluded' as const },
    server: { baseUrl, runtimeVersion: '2.1.2' as const }, resources: { kind: 'caller_owned' as const } };
}
function ref(history: AgentHistory, id = 'ses_ms005_http'): AgentHistoryConversationRef {
  return { source: { providerKey: history.source.providerKey, sourceId: history.source.sourceId, generation: history.source.generation },
    conversationId: parseAgentProviderConversationId(id) };
}
function lookup(history: AgentHistory) {
  if (history.lookup.status !== 'supported') assert.fail('HTTP OpenCode metadata lookup must be supported.');
  return history.lookup.get;
}
function catalog(history: AgentHistory) {
  if (history.catalog.status !== 'supported') assert.fail('HTTP OpenCode catalog must be supported.');
  return history.catalog.list;
}
function transcript(history: AgentHistory) {
  if (history.transcript.status !== 'supported') assert.fail('HTTP OpenCode transcript must be supported.');
  return history.transcript.read;
}
function code(expected: string) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}
function serverInfo(response: ServerResponse, version = '2.1.2'): void {
  openCodeJson(response, { version, pid: process.pid, urls: [], paths: { tmp: '/synthetic/server-tmp' } });
}
function peer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  return createOpenCodeHttpPeer((request, response) => {
    if (request.url === '/api/info') { serverInfo(response); return; }
    return handler(request, response);
  });
}

test('OpenCode selected rename sends only an explicit title PATCH and keeps the receipt independent of later refresh', async (t) => {
  let failReads = false;
  const bodies: unknown[] = [];
  const server = await peer(async (request, response) => {
    if (request.url === '/api/session/active') { openCodeJson(response, { data: {} }); return; }
    if (request.method === 'PATCH') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      bodies.push(JSON.parse(body));
      response.writeHead(204); response.end(); return;
    }
    openCodeJson(response, failReads ? { message: 'Synthetic refresh failure' } : { data: openCodeHttpSession() }, failReads ? 500 : 200);
  });
  t.after(() => server.close());
  const history = await createOpenCodeHistory({ ...options(server.endpoint), management: ['rename'] });
  t.after(() => history.close());
  if (history.rename.status !== 'supported') assert.fail('Selected rename must be available.');
  assert.equal(history.delete.status, 'unsupported');
  const effects = history.rename.descriptor.effects;
  const before = server.requests.length;
  assert.equal((await history.rename.apply({ conversation: ref(history), title: 'Explicit title', acceptEffects: { ...effects, descendants: 'descendants' } })).status, 'not_applied');
  assert.equal(server.requests.length, before);
  const receipt = await history.rename.apply({ conversation: ref(history), title: 'Explicit title', acceptEffects: effects });
  assert.deepEqual(receipt, { status: 'applied', ref: ref(history) });
  assert.deepEqual(bodies, [{ title: 'Explicit title' }]);
  assert.deepEqual(server.requests.slice(before).map(({ method, path }) => ({ method, path })), [
    { method: 'GET', path: '/api/session/ses_ms005_http' }, { method: 'GET', path: '/api/session/active' },
    { method: 'PATCH', path: '/api/session/ses_ms005_http' },
  ]);
  failReads = true;
  await assert.rejects(lookup(history)({ conversation: ref(history) }), code('native_failure'));
  assert.equal(receipt.status, 'applied');
});

test('OpenCode missing, foreign and active sessions reject management before HTTP mutation entry', async (t) => {
  for (const fixture of [
    { missing: true, foreign: false, active: false, reason: 'not_found' },
    { missing: false, foreign: true, active: false, reason: 'unsupported_scope' },
    { missing: false, foreign: false, active: true, reason: 'unsupported_scope' },
  ]) {
    const server = await peer((request, response) => {
      if (request.url === '/api/session/active') {
        openCodeJson(response, { data: fixture.active ? { ses_ms005_http: { type: 'running' } } : {} }); return;
      }
      if (fixture.missing) openCodeJson(response, { _tag: 'SessionNotFoundError', sessionID: 'ses_ms005_http', message: 'Fixture missing' }, 404);
      else openCodeJson(response, { data: openCodeHttpSession(fixture.foreign ? { location: { directory: '/synthetic/foreign-project' } } : {}) });
    });
    t.after(() => server.close());
    const history = await createOpenCodeHistory({ ...options(server.endpoint), management: ['delete'] });
    t.after(() => history.close());
    if (history.delete.status !== 'supported') assert.fail('Delete was explicitly selected.');
    const receipt = await history.delete.apply({ conversation: ref(history), acceptEffects: history.delete.descriptor.effects });
    assert.equal(receipt.status, 'not_applied');
    if (receipt.status !== 'not_applied') assert.fail('A precheck must retain a definitive rejection.');
    assert.equal(receipt.reason.code, fixture.reason);
    assert.equal(server.requests.every((request) => request.method === 'GET'), true);
    await history.close();
  }
});

test('OpenCode HTTP mutation response loss yields uncertainty without retry while independently observable state remains readable', async (t) => {
  let title = 'Stored HTTP fixture conversation';
  let writes = 0;
  const server = await peer(async (request, response) => {
    if (request.url === '/api/session/active') { openCodeJson(response, { data: {} }); return; }
    if (request.method === 'PATCH') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const value: unknown = JSON.parse(body);
      assert.deepEqual(value, { title: 'Stored after lost response' });
      title = 'Stored after lost response'; writes += 1;
      response.destroy(); return;
    }
    openCodeJson(response, { data: openCodeHttpSession({ title }) });
  });
  t.after(() => server.close());
  const history = await createOpenCodeHistory({ ...options(server.endpoint), management: ['rename'] });
  t.after(() => history.close());
  if (history.rename.status !== 'supported') assert.fail('Rename was selected.');
  const input = { conversation: ref(history), title: 'Stored after lost response', acceptEffects: history.rename.descriptor.effects };
  assert.equal((await history.rename.apply(input)).status, 'outcome_unknown');
  assert.equal(writes, 1);
  assert.equal((await history.rename.apply(input)).status, 'not_applied');
  assert.equal(writes, 1);
  assert.equal((await lookup(history)({ conversation: ref(history) })).title, 'Stored after lost response');
  await history.close();
  assert.equal(server.pendingRequests, 0);
});

test('OpenCode unexpected HTTP 200 and cancellation after PATCH entry cannot fabricate a confirmed mutation receipt', async (t) => {
  for (const mode of ['unexpected_status', 'cancelled'] as const) {
    const entered = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
    let writes = 0;
    const server = await peer(async (request, response) => {
      if (request.url === '/api/session/active') { openCodeJson(response, { data: {} }); return; }
      if (request.method !== 'PATCH') { openCodeJson(response, { data: openCodeHttpSession() }); return; }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      assert.deepEqual(JSON.parse(body), { title: 'Explicit uncertain title' });
      writes += 1;
      if (mode === 'unexpected_status') { openCodeJson(response, {}); return; }
      response.once('close', () => stopped.resolve());
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      entered.resolve();
    });
    t.after(() => server.close());
    const history = await createOpenCodeHistory({ ...options(server.endpoint), management: ['rename'] });
    t.after(() => history.close());
    if (history.rename.status !== 'supported') assert.fail('Rename was selected.');
    const controller = new AbortController();
    const applying = history.rename.apply({ conversation: ref(history), title: 'Explicit uncertain title',
      acceptEffects: history.rename.descriptor.effects }, { signal: controller.signal });
    if (mode === 'cancelled') { await entered.promise; controller.abort(); }
    assert.equal((await applying).status, 'outcome_unknown', mode);
    if (mode === 'cancelled') await stopped.promise;
    assert.equal(writes, 1, mode);
    assert.equal((await lookup(history)({ conversation: ref(history) })).title, 'Stored HTTP fixture conversation');
    await history.close();
    assert.equal(server.pendingRequests, 0, mode);
  }
});

test('OpenCode construction verifies the supplied server compatibility before admitting history reads', { timeout: 10000 }, async (t) => {
  for (const fixture of [
    { body: { version: '2.1.3', pid: process.pid, urls: [], paths: { tmp: '/synthetic/server-tmp' } }, error: 'unsupported_scope' },
    { body: { pid: process.pid, urls: [], paths: { tmp: '/synthetic/server-tmp' } }, error: 'native_failure' },
  ]) {
    const server = await createOpenCodeHttpPeer((_request, response) => openCodeJson(response, fixture.body));
    t.after(() => server.close());
    await assert.rejects(createOpenCodeHistory(options(server.endpoint)), code(fixture.error));
    assert.deepEqual(server.requests.map((request) => ({ method: request.method, path: request.path })), [{ method: 'GET', path: '/api/info' }]);
    assert.equal(server.pendingRequests, 0);
  }
  const cancelled = Promise.withResolvers<void>();
  const stalled = await createOpenCodeHttpPeer((_request, response) => {
    response.once('close', () => cancelled.resolve());
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"version":');
  });
  t.after(() => stalled.close());
  await assert.rejects(createOpenCodeHistory({ ...options(stalled.endpoint), limits: { deadlineMs: 100 } }), code('deadline_exceeded'));
  await cancelled.promise;
  assert.equal(stalled.pendingRequests, 0);
});

test('OpenCode HTTP boundary distinguishes denied, missing, malformed and contradictory native metadata while healthy reads remain available', { timeout: 15000 }, async (t) => {
  const invalidUtf8 = Buffer.from(JSON.stringify({ data: openCodeHttpSession({ title: 'INVALID_UTF8_NATIVE_TITLE' }) }));
  invalidUtf8[invalidUtf8.indexOf('INVALID_UTF8_NATIVE_TITLE')] = 0xff;
  const cases = [
    { name: 'authentication required', status: 401, body: { _tag: 'UnauthorizedError', message: 'Synthetic authorization failure' }, error: 'access_denied' },
    { name: 'access forbidden', status: 403, body: { message: 'Synthetic forbidden project' }, error: 'access_denied' },
    { name: 'missing session', status: 404, body: { _tag: 'SessionNotFoundError', sessionID: 'ses_ms005_http', message: 'Synthetic missing session' }, error: 'not_found' },
    { name: 'invalid JSON', status: 200, raw: '{malformed-json', error: 'native_failure' },
    { name: 'invalid UTF-8', status: 200, raw: invalidUtf8, error: 'native_failure' },
    { name: 'wrong session ID', status: 200, body: { data: openCodeHttpSession({ id: 'ses_ms005_another' }) }, error: 'native_failure' },
    { name: 'wrong project directory', status: 200, body: { data: openCodeHttpSession({ location: { directory: '/synthetic/other-project' } }) }, error: 'unsupported_scope' },
    { name: 'wrong project identity', status: 200, body: { data: openCodeHttpSession({ projectID: 'project_ms005_another' }) }, error: 'unsupported_scope' },
    { name: 'malformed session', status: 200, body: { data: { id: 'ses_ms005_http' } }, error: 'native_failure' },
  ];
  for (const fixture of cases) {
    let faulty = true;
    const server = await peer((_request, response) => {
      if (!faulty) { openCodeJson(response, { data: openCodeHttpSession() }); return; }
      if ('raw' in fixture) { response.writeHead(fixture.status, { 'content-type': 'application/json' }); response.end(fixture.raw); }
      else openCodeJson(response, fixture.body, fixture.status);
    });
    t.after(() => server.close());
    const history = await createOpenCodeHistory({ ...options(server.endpoint), projectID: 'project_ms005_http' });
    t.after(() => history.close());
    await assert.rejects(lookup(history)({ conversation: ref(history) }), code(fixture.error), fixture.name);
    faulty = false;
    assert.equal((await lookup(history)({ conversation: ref(history) })).title, 'Stored HTTP fixture conversation', fixture.name);
    await history.close();
    assert.equal(server.pendingRequests, 0, fixture.name);
  }
});

test('OpenCode native catalog cursor failures stay distinct from empty pages and never become successful empty catalogs', { timeout: 10000 }, async (t) => {
  const server = await peer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.has('cursor')) {
      openCodeJson(response, { _tag: 'InvalidCursorError', message: 'Synthetic expired native cursor' }, 400); return;
    }
    openCodeJson(response, { data: [openCodeHttpSession()], cursor: { next: 'expired-native-cursor' } });
  });
  t.after(() => server.close());
  const history = await createOpenCodeHistory(options(server.endpoint));
  t.after(() => history.close());
  const first = await catalog(history)({ limit: 1 });
  assert.deepEqual(first.items.map((item) => item.title), ['Stored HTTP fixture conversation']);
  if (first.nextCursor === undefined) assert.fail('Native first page must expose its continuation.');
  await assert.rejects(catalog(history)({ limit: 1, cursor: first.nextCursor }), code('invalid_cursor'));
  assert.equal(server.requests.filter((request) => request.query.get('cursor') === 'expired-native-cursor').length, 1);
});

test('OpenCode repeated native catalog cursors and replaced transcript anchors cannot silently duplicate or skip saved records', { timeout: 10000 }, async (t) => {
  let replaced = false;
  const server = await peer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/session') {
      openCodeJson(response, { data: [openCodeHttpSession()], cursor: { next: 'repeated-native-cursor' } }); return;
    }
    if (!url.pathname.endsWith('/message')) { openCodeJson(response, { data: openCodeHttpSession() }); return; }
    openCodeJson(response, { data: [{ id: replaced ? 'msg_ms005_replaced' : 'msg_ms005_anchor', type: 'assistant',
      agent: 'build', model: { id: 'fixture-model', providerID: 'fixture-provider' },
      time: { created: 1000, completed: 2000 }, content: [
        { type: 'text', text: 'Stored text before tool' },
        { type: 'tool', id: 'call_ms005_anchor', name: 'read', executed: true, time: { created: 1000, completed: 2000 },
          state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'Stored result' }] } },
      ] }], cursor: {} });
  });
  t.after(() => server.close());
  const history = await createOpenCodeHistory(options(server.endpoint));
  t.after(() => history.close());
  await assert.rejects(catalog(history)({ limit: 2 }), code('native_failure'));
  const first = await transcript(history)({ conversation: ref(history), limit: 1 });
  assert.deepEqual(first.items.map((record) => record.kind === 'message' ? record.content : record), [[{ kind: 'text', text: 'Stored text before tool' }]]);
  if (first.nextCursor === undefined) assert.fail('A projected multi-record message needs a continuation.');
  replaced = true;
  await assert.rejects(transcript(history)({ conversation: ref(history), limit: 1, cursor: first.nextCursor }), code('invalid_cursor'));
});

test('OpenCode raw response guard cancels a streaming oversized body before JSON parsing and preserves subsequent server access', { timeout: 10000 }, async (t) => {
  const cancelled = Promise.withResolvers<void>();
  let overflow = true;
  const server = await peer((_request, response) => {
    if (!overflow) { openCodeJson(response, { data: openCodeHttpSession() }); return; }
    response.once('close', () => cancelled.resolve());
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"data":{"title":"');
    response.write('x'.repeat(1024 * 1024 + 65536));
  });
  t.after(() => server.close());
  const history = await createOpenCodeHistory(options(server.endpoint));
  t.after(() => history.close());
  await assert.rejects(lookup(history)({ conversation: ref(history) }), code('limit_exhausted'));
  await cancelled.promise;
  assert.equal(server.pendingRequests, 0);
  overflow = false;
  assert.equal((await lookup(history)({ conversation: ref(history) })).title, 'Stored HTTP fixture conversation');
});

test('OpenCode cancellation, deadline and close abort entered HTTP bodies without disposing the externally supplied server', { timeout: 15000 }, async (t) => {
  for (const action of ['cancel', 'deadline', 'close'] as const) {
    const entered = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>();
    let stall = false;
    const server = await peer((_request, response) => {
      if (!stall) { openCodeJson(response, { data: openCodeHttpSession() }); return; }
      response.once('close', () => cancelled.resolve());
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"data":');
      entered.resolve();
    });
    t.after(() => server.close());
    const history = await createOpenCodeHistory(options(server.endpoint));
    t.after(() => history.close());
    assert.equal((await lookup(history)({ conversation: ref(history) })).title, 'Stored HTTP fixture conversation');
    stall = true;
    const controller = new AbortController();
    const expected = action === 'cancel' ? 'cancelled' : action === 'close' ? 'closed' : 'deadline_exceeded';
    const pending = assert.rejects(lookup(history)({ conversation: ref(history) },
      { signal: controller.signal, ...(action === 'deadline' ? { deadlineMs: 100 } : {}) }), code(expected), action);
    await entered.promise;
    let closing: Promise<void> | undefined;
    if (action === 'cancel') controller.abort();
    if (action === 'close') closing = history.close();
    await pending;
    await cancelled.promise;
    if (closing) await closing;
    assert.equal(server.pendingRequests, 0, action);
    stall = false;
    if (action === 'close') {
      await assert.rejects(lookup(history)({ conversation: ref(history) }), code('closed'));
      const independent = await fetch(`${server.endpoint}/api/session/ses_ms005_http`);
      assert.equal(independent.status, 200);
      assert.deepEqual(await independent.json(), { data: openCodeHttpSession() });
    } else assert.equal((await lookup(history)({ conversation: ref(history) })).title, 'Stored HTTP fixture conversation', action);
  }
});

test('OpenCode HTTP disconnect cannot be mistaken for a missing or empty transcript', { timeout: 10000 }, async (t) => {
  let disconnect = true;
  const server = await peer((request, response) => {
    if (!request.url?.includes('/message')) { openCodeJson(response, { data: openCodeHttpSession() }); return; }
    if (disconnect) { response.destroy(); return; }
    openCodeJson(response, { data: [{ id: 'msg_ms005_recovered', type: 'user', text: 'Stored response after disconnect', time: { created: 1000 } }], cursor: {} });
  });
  t.after(() => server.close());
  const history = await createOpenCodeHistory(options(server.endpoint));
  t.after(() => history.close());
  await assert.rejects(transcript(history)({ conversation: ref(history), limit: 1 }), code('native_failure'));
  disconnect = false;
  const healthy = await transcript(history)({ conversation: ref(history), limit: 1 });
  assert.deepEqual(healthy.items, [{ kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Stored response after disconnect' }],
    native: { itemId: 'msg_ms005_recovered' }, timestamp: '1970-01-01T00:00:01.000Z' }]);
});

test('OpenCode unknown stored message variants remain inert notices with explicit coverage', { timeout: 10000 }, async (t) => {
  const server = await peer((request, response) => {
    if (!request.url?.includes('/message')) { openCodeJson(response, { data: openCodeHttpSession() }); return; }
    openCodeJson(response, { data: [{ id: 'msg_ms005_future', type: 'future-history-variant', time: { created: 1000 },
      command: 'NEVER_EXECUTE_STORED_PAYLOAD', payload: { arbitrary: 'inert' } }], cursor: {} });
  });
  t.after(() => server.close());
  const history = await createOpenCodeHistory(options(server.endpoint));
  t.after(() => history.close());
  const page = await transcript(history)({ conversation: ref(history), limit: 1 });
  assert.equal(page.items.length, 1);
  const notice = page.items[0];
  if (notice.kind !== 'notice') assert.fail('An unrecognized stored message must remain an inert notice.');
  assert.equal(notice.code, 'opencode.unsupported_record_kind');
  assert.deepEqual(notice.native, { itemId: 'msg_ms005_future' });
  assert.equal(notice.timestamp, '1970-01-01T00:00:01.000Z');
  assert.equal(page.coverage.omissions.includes('unsupported_record_kind'), true);
  assert.equal(server.requests.every((request) => request.method === 'GET'), true);
});
