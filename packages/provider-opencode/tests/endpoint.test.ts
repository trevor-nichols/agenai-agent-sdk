import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import test from 'node:test';
import { OWNED_TOOLS } from '../src/node/config.js';
import { CALL_FRAME_BYTES, openPluginEndpoint, type EndpointSignal } from '../src/node/endpoint.js';

const TOKEN = 'token-'.padEnd(43, 't');
const NONCE = 'nonce-'.padEnd(43, 'n');
const call = (id: number, extra: Record<string, unknown> = {}) =>
  ({ type: 'call', id, tool: 'read', input: { file_path: 'a.txt' }, sessionID: 'ses_1', messageID: 'msg_1', callID: `toolu_${id}`, ...extra });

async function open(t: test.TestContext) {
  const endpoint = await openPluginEndpoint({ token: TOKEN, nonce: NONCE, tools: OWNED_TOOLS });
  t.after(() => endpoint.close());
  return endpoint;
}

async function plugin(port: number): Promise<{ socket: Socket; send: (frame: unknown) => void; replies: unknown[] }> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const opened = connect({ host: '127.0.0.1', port }, () => resolve(opened));
    opened.once('error', reject);
  });
  const replies: unknown[] = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) { replies.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
  });
  socket.on('error', () => {});
  return { socket, replies, send: (frame) => socket.write(`${JSON.stringify(frame)}\n`) };
}

async function ready(t: test.TestContext) {
  const endpoint = await open(t);
  const client = await plugin(endpoint.port);
  client.send({ type: 'ready', token: TOKEN, nonce: NONCE, tools: [...OWNED_TOOLS].reverse() });
  await endpoint.ready;
  const signals: EndpointSignal[] = [];
  const failed = new Promise<string>((resolve) => {
    endpoint.listen((signal) => { signals.push(signal); if (signal.type === 'failed') resolve(signal.reason); });
  });
  return { endpoint, client, signals, failed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the loopback endpoint stops listening once its one plugin connects', async (t) => {
  const endpoint = await open(t);
  const client = await plugin(endpoint.port);
  client.send({ type: 'ready', token: TOKEN, nonce: NONCE, tools: OWNED_TOOLS });
  await endpoint.ready;
  await assert.rejects(plugin(endpoint.port), { code: 'ECONNREFUSED' });
  const failed = new Promise<EndpointSignal>((resolve) => endpoint.listen(resolve));
  client.socket.destroy();
  assert.deepEqual(await failed, { type: 'failed', reason: 'The plugin connection closed.' });
});

test('readiness must authenticate first and prove the exact inventory', async (t) => {
  for (const frame of [
    call(1),
    { type: 'ready', token: 'x'.repeat(43), nonce: NONCE, tools: OWNED_TOOLS },
    { type: 'ready', token: TOKEN, nonce: NONCE, tools: OWNED_TOOLS.slice(1) },
    { type: 'ready', token: TOKEN, nonce: NONCE, tools: [...OWNED_TOOLS.slice(1), 'agenai_shell'] },
  ]) {
    const endpoint = await open(t);
    (await plugin(endpoint.port)).send(frame);
    await assert.rejects(endpoint.ready);
  }
});

test('admitted calls are answered once and keep their native identities as data', async (t) => {
  const { endpoint, client, signals } = await ready(t);
  client.send(call(1, { callID: '../../etc/passwd' }));
  await settle();
  assert.deepEqual(signals, [{ type: 'call', call: { id: 1, tool: 'read', input: { file_path: 'a.txt' }, sessionID: 'ses_1', messageID: 'msg_1', callID: '../../etc/passwd' } }]);
  endpoint.reply(1, { text: 'ok', isError: false });
  assert.throws(() => endpoint.reply(1, { text: 'again', isError: false }), /already answered/u);
  client.send({ type: 'cancel', id: 1 });
  await settle();
  assert.deepEqual(client.replies, [{ type: 'result', id: 1, text: 'ok', isError: false }]);
  assert.equal(signals.length, 1);
});

for (const [name, frames] of [
  ['a malformed frame', ['{not json']],
  ['a reused call identity', [JSON.stringify(call(2)), JSON.stringify(call(2))]],
  ['a cancellation of a call never sent', [JSON.stringify({ type: 'cancel', id: 9 })]],
  ['an unknown tool', [JSON.stringify(call(1, { tool: 'shell' }))]],
  ['a second readiness frame', [JSON.stringify({ type: 'ready', token: TOKEN, nonce: NONCE, tools: OWNED_TOOLS })]],
] as const) {
  test(`${name} fails the endpoint`, async (t) => {
    const { client, failed } = await ready(t);
    for (const frame of frames) client.socket.write(`${frame}\n`);
    assert.ok(await failed);
  });
}

test('a frame past its byte bound fails the endpoint without buffering it', async (t) => {
  const { client, failed } = await ready(t);
  client.socket.write(Buffer.alloc(CALL_FRAME_BYTES + 1, 0x61));
  assert.match(await failed, /larger than its bound/u);
});

/** One valid call frame of exactly `bytes` bytes before its newline. */
function sized(id: number, bytes: number): Buffer {
  const frame = (padding: string) => JSON.stringify(call(id, { input: { file_path: 'a.txt', padding } }));
  return Buffer.from(frame('x'.repeat(bytes - Buffer.byteLength(frame('')))));
}
const NL = Buffer.from('\n');
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

for (const [name, chunks, admitted, bounded] of [
  ['a completed frame past its bound whose newline arrives in the crossing chunk', () => {
    const big = sized(1, CALL_FRAME_BYTES + 200);
    return [big.subarray(0, CALL_FRAME_BYTES - 1), Buffer.concat([big.subarray(CALL_FRAME_BYTES - 1), NL])];
  }, [], true],
  ['a frame past its bound after a valid frame in the same chunk', () => [Buffer.concat([sized(1, 200), NL, sized(2, CALL_FRAME_BYTES + 1), NL])], [1], true],
  ['frames of exactly their bound split anywhere, several per chunk', () => {
    const exact = sized(1, CALL_FRAME_BYTES);
    return [exact.subarray(0, 7), Buffer.concat([exact.subarray(7), NL, sized(2, 300), NL, sized(3, CALL_FRAME_BYTES).subarray(0, 9)]),
      Buffer.concat([sized(3, CALL_FRAME_BYTES).subarray(9), NL])];
  }, [1, 2, 3], false],
] as const) {
  test(`${name} ${bounded ? 'fails the endpoint at its bound' : 'is admitted whole'}`, async (t) => {
    const { client, signals } = await ready(t);
    for (const chunk of chunks()) { client.socket.write(chunk); await pause(); }
    await settle();
    assert.deepEqual(signals.flatMap((signal) => signal.type === 'call' ? [signal.call.id] : []), admitted);
    const failures = signals.flatMap((signal) => signal.type === 'failed' ? [signal.reason] : []);
    assert.deepEqual(failures, bounded ? ['The plugin sent a frame larger than its bound.'] : []);
  });
}
