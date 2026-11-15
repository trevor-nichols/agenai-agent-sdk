import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createNativeClient } from '../src/node/client.js';
import { nodeProviderToolDefinitions } from '@agen-ai/provider-tools/node';
import { openPluginEndpoint } from '../src/node/endpoint.js';
import plugin from '../src/node/plugin.js';
import { pluginContext } from './support/plugin.js';

const EVENT_BYTES = 32 * 1024 * 1024 + 65_536;
const BOUND = /An OpenCode event exceeded its bound\./u;
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

/** One `server.connected` event of exactly `bytes` wire bytes, framing included. */
function event(bytes: number, newline = '\n'): string {
  const frame = (blob: string) => `data: ${JSON.stringify({ type: 'server.connected', data: { blob } })}${newline}${newline}`;
  return frame('x'.repeat(bytes - Buffer.byteLength(frame(''))));
}

/** Serves `parts` as one event stream through loopback HTTP and reads it with the pinned OpenCode client. */
async function subscribe(t: test.TestContext, parts: readonly string[]) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    void (async () => {
      for (const part of parts) { response.write(part); await pause(); }
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const client = createNativeClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'password', lifetime.signal);
  const received: string[] = [];
  try {
    for await (const value of client.events(lifetime.signal)) received.push(createHash('sha256').update(JSON.stringify(value)).digest('hex'));
    return { received, error: undefined };
  } catch (error) {
    const messages: string[] = [];
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) messages.push(cause.message);
    return { received, error: messages.join(' <- ') };
  }
}

test('admitted escaped tool inputs survive their complete native argument and call events', { timeout: 30_000 }, async (t) => {
  const definitions = nodeProviderToolDefinitions();
  const broker = await openPluginEndpoint({ token: 'test-token', nonce: 'test-nonce', tools: definitions.map(({ name }) => `agenai_${name}`) });
  t.after(() => broker.close());
  const native = pluginContext({ port: broker.port, token: 'test-token', nonce: 'test-nonce', provider: 'anthropic', tools: definitions });
  const close = await plugin.setup(native.ctx as never);
  t.after(close);
  await broker.ready;
  const forwarded: string[] = [];
  broker.listen((signal) => {
    if (signal.type !== 'call') return;
    forwarded.push(createHash('sha256').update(JSON.stringify(signal.call.input)).digest('hex'));
    broker.reply(signal.call.id, { text: 'received', isError: false });
  });
  const events: unknown[] = [];
  for (const [index, content] of ['\0'.repeat(1_048_576), '\\'.repeat(8_000_000)].entries()) {
    const input = { file_path: 'generated.txt', content };
    const context = { sessionID: 'ses_1', messageID: 'msg_1', id: `call_${index}`, signal: new AbortController().signal };
    assert.deepEqual(await native.run('agenai_write', input, input, context), { content: 'received' });
    assert.equal(forwarded[index], createHash('sha256').update(JSON.stringify(input)).digest('hex'));
    const data = { sessionID: context.sessionID, assistantMessageID: context.messageID, id: context.id };
    events.push({ type: 'session.tool.input.ended', data: { ...data, text: JSON.stringify(input) } },
      { type: 'session.tool.called', data: { ...data, input, executed: false } });
  }
  const parts = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const { received, error } = await subscribe(t, parts);
  assert.equal(error, undefined);
  assert.deepEqual(received, events.map((event) => createHash('sha256').update(JSON.stringify(event)).digest('hex')));
});

for (const [name, parts] of [
  ['an event past its bound whose delimiter arrives in the crossing chunk', () => {
    const wire = event(EVENT_BYTES + 4_096);
    return [wire.slice(0, EVENT_BYTES - 1), wire.slice(EVENT_BYTES - 1)];
  }],
  ['an event one byte past its bound with CRLF framing', () => [event(EVENT_BYTES + 1, '\r\n')]],
  ['CRLF comment lines that grow one event past its bound', () => [':\r\n'.repeat(Math.ceil(EVENT_BYTES / 3)), `data: ${JSON.stringify({ type: 'server.connected', data: {} })}\r\n\r\n`]],
] as const) {
  test(`${name} fails the event stream`, async (t) => {
    const { received, error } = await subscribe(t, parts());
    assert.deepEqual(received, []);
    assert.match(error ?? '', BOUND);
  });
}

test('events within their bound arrive whatever their framing, and the stream as a whole is not capped', async (t) => {
  const wire = [event(EVENT_BYTES, '\r\n'), event(2 * 1024 * 1024), event(2 * 1024 * 1024), event(300, '\r'), event(EVENT_BYTES)];
  const parts = [wire[0]!.slice(0, 5), wire[0]!.slice(5) + wire[1]!.slice(0, 1_000), wire[1]!.slice(1_000) + wire[2] + wire[3], wire[4]!];
  const { received, error } = await subscribe(t, parts);
  assert.equal(error, undefined);
  assert.equal(received.length, wire.length);
});

test('event subscriptions authenticate once and release the connection on return or cancellation', { timeout: 5000 }, async (t) => {
  const requests: { url: string | undefined; authorization: string | undefined }[] = [];
  let closed: (() => void) | undefined;
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.on('close', () => closed?.());
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"server.connected","data":{}}\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const client = createNativeClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'password', lifetime.signal);
  for (const mode of ['return', 'abort'] as const) {
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const turn = new AbortController();
    const iterator = client.events(turn.signal)[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { done: false, value: { type: 'server.connected', data: {} } });
    if (mode === 'return') await iterator.return?.();
    else {
      const pending = iterator.next();
      turn.abort();
      await assert.rejects(pending);
    }
    await disconnected;
  }
  assert.deepEqual(requests, Array.from({ length: 2 }, () => ({
    url: '/api/event', authorization: `Basic ${Buffer.from('opencode:password').toString('base64')}`,
  })));
});

test('invalid event responses fail without accepting partial observations', async (t) => {
  for (const [status, contentType, body] of [
    [401, 'text/event-stream', 'data: {"type":"server.connected","data":{}}\n\n'],
    [200, 'application/json', '{}'],
    [200, 'text/event-stream', 'data: {invalid}\n\n'],
    [200, 'text/event-stream', Buffer.from([0xff, 0x0a, 0x0a])],
  ] as const) {
    const server = createServer((_request, response) => { response.writeHead(status, { 'content-type': contentType }); response.end(body); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const lifetime = new AbortController();
    t.after(() => lifetime.abort());
    const client = createNativeClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'password', lifetime.signal);
    await assert.rejects(client.events(lifetime.signal)[Symbol.asyncIterator]().next());
  }
});
