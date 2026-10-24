// ------------------------------------------------------------------------------------------------
//                fault-proxy.test.ts - Real socket forwarding and finite fault ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createFaultProxy } from './integration/support/fault-proxy.js';
import { DockerEngine } from '../src/engine/client.js';

async function fixture(replyDelayMs = 0, releaseMutationBody?: Promise<void>) {
  const directory = await mkdtemp('/tmp/agenai-proxy-');
  const backendPath = path.join(directory, 'backend.sock');
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let mutations = 0;
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.once('end', () => {
      const reply = () => {
        if (incoming.url === '/v1.52/mutate') {
          mutations += 1;
          const body = JSON.stringify({ Id: 'a'.repeat(64), mutations });
          response.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
          if (releaseMutationBody) {
            response.flushHeaders();
            void releaseMutationBody.then(() => response.end(body));
          } else response.end(body);
        } else {
          const bytes = Buffer.concat(chunks);
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': incoming.method === 'HEAD' ? 123 : bytes.byteLength,
            'x-proxy-request-framing': incoming.headers['transfer-encoding'] ?? 'none' });
          response.write(bytes.subarray(0, 13));
          setImmediate(() => response.end(bytes.subarray(13)));
        }
      };
      if (replyDelayMs === 0) reply();
      else {
        const timer = setTimeout(() => { timers.delete(timer); reply(); }, replyDelayMs);
        timers.add(timer);
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_incoming, socket, head) => {
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switch');
    setImmediate(() => socket.write(Buffer.concat([
      Buffer.from('ing Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'), Buffer.from([0, 255]), head,
    ])));
    socket.on('data', (chunk: Buffer) => socket.write(chunk));
    socket.once('end', () => socket.end(Buffer.from([128, 13, 10])));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(backendPath, resolve); });
  const proxy = await createFaultProxy({ upstreamEndpoint: `unix://${backendPath}`, directory });
  return { proxy, get mutations() { return mutations; }, async close() {
    try { await proxy.close(); }
    finally {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true });
    }
  } };
}

test('fault proxy preserves HTTP bodies and split upgrade headers, binary duplex and half-close', { timeout: 5000 }, async () => {
  const owned = await fixture();
  try {
    const input = Buffer.alloc(32_768);
    for (let index = 0; index < input.byteLength; index += 1) input[index] = (index * 71) & 255;
    const response = await new Promise<Buffer>((resolve, reject) => {
      const sent = request({ socketPath: owned.proxy.endpoint.slice(7), path: '/v1.52/echo', method: 'PUT', agent: false,
        headers: { connection: 'close', 'content-length': input.byteLength } }, (message) => {
        assert.equal(message.statusCode, 200);
        const chunks: Buffer[] = [];
        message.on('data', (chunk: Buffer) => chunks.push(chunk));
        message.once('error', reject);
        message.once('end', () => resolve(Buffer.concat(chunks)));
      });
      sent.once('error', reject);
      sent.end(input);
    });
    assert.deepEqual(response, input);
    const output = await new Promise<Buffer>((resolve, reject) => {
      const sent = request({ socketPath: owned.proxy.endpoint.slice(7), path: '/v1.52/exec/exact/start', method: 'POST', agent: false,
        headers: { connection: 'Upgrade', upgrade: 'tcp', 'content-length': 0 } });
      sent.once('error', reject);
      sent.once('response', () => reject(new Error('Proxy lost the explicit upgrade handshake.')));
      sent.once('upgrade', (message, socket, head) => {
        assert.equal(message.statusCode, 101);
        const chunks: Buffer[] = [head];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.once('error', reject);
        socket.once('end', () => { socket.destroy(); resolve(Buffer.concat(chunks)); });
        socket.end(input);
      });
      sent.end();
    });
    assert.deepEqual(output, Buffer.concat([Buffer.from([0, 255]), input, Buffer.from([128, 13, 10])]));
    assert.deepEqual(owned.proxy.observations.map(({ method, path: route, status, upgraded }) => ({ method, path: route, status, upgraded })), [
      { method: 'PUT', path: '/v1.52/echo', status: 200, upgraded: false },
      { method: 'POST', path: '/v1.52/exec/exact/start', status: 101, upgraded: true },
    ]);
  } finally { await owned.close(); }
});

test('fault proxy forwards the production streamed chunked PUT and exact-file HEAD bytes', { timeout: 5000 }, async (context) => {
  for (const method of ['PUT', 'HEAD'] as const) await context.test(method, async () => {
    const owned = await fixture();
    const client = new DockerEngine(owned.proxy.endpoint.slice(7));
    try {
      const input = Buffer.alloc(32768);
      for (let index = 0; index < input.length; index += 1) input[index] = (index * 71) & 255;
      async function* body() {
        for (let offset = 0; offset < input.length; offset += 2048) yield input.subarray(offset, offset + 2048);
      }
      const response = await client.stream(method, '/v1.52/echo', { chunkBytes: 65536,
        ...(method === 'PUT' ? { body: body(), contentType: 'application/x-tar' as const } : {}) }, async (message) => {
        assert.equal(message.statusCode, 200);
        assert.equal(message.headers['content-length'], method === 'HEAD' ? '123' : String(input.length));
        assert.equal(message.headers['x-proxy-request-framing'], method === 'PUT' ? 'chunked' : 'none');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of message.body) {
          size += chunk.length;
          assert(size <= input.length);
          chunks.push(Uint8Array.from(chunk));
        }
        return Buffer.concat(chunks);
      });
      assert.deepEqual(response.value, method === 'HEAD' ? Buffer.alloc(0) : input);
      assert.deepEqual(owned.proxy.observations.map(({ method: observed, path: route, status }) => ({ method: observed, path: route, status })),
        [{ method, path: '/v1.52/echo', status: 200 }]);
    } finally { await owned.close(); }
  });
});

test('held real dispatch remains owned after caller abort and joins its delayed original upstream reply', { timeout: 5000 }, async () => {
  const owned = await fixture(25);
  try {
    const gate = owned.proxy.arm({ method: 'POST', path: '/v1.52/mutate', mode: 'hold_request' });
    const sent = request({ socketPath: owned.proxy.endpoint.slice(7), path: '/v1.52/mutate', method: 'POST', agent: false,
      headers: { connection: 'close', 'content-length': 0 } });
    const rejected = new Promise<Error>((resolve) => sent.once('error', resolve));
    sent.end();
    await gate.entered;
    sent.destroy(new Error('Owned client cancellation.'));
    assert.equal((await rejected).message, 'Owned client cancellation.');
    assert.equal(owned.mutations, 0);
    gate.release();
    assert.equal((await gate.responded).status, 201);
    await gate.settled;
    assert.equal(owned.mutations, 1);
    assert.equal(owned.proxy.observations[0]?.responsePrefix.includes('"mutations":1'), true);
  } finally { await owned.close(); }
});

test('lost reply reports the completed original mutation and never resends it', { timeout: 5000 }, async () => {
  const owned = await fixture();
  try {
    const gate = owned.proxy.arm({ method: 'POST', path: '/v1.52/mutate', mode: 'drop_reply' });
    const rejected = new Promise<Error>((resolve, reject) => {
      const sent = request({ socketPath: owned.proxy.endpoint.slice(7), path: '/v1.52/mutate', method: 'POST', agent: false,
        headers: { connection: 'close', 'content-length': 0 } }, () => reject(new Error('The selected reply unexpectedly reached its caller.')));
      sent.once('error', resolve);
      sent.end();
    });
    assert.equal((await gate.responded).status, 201);
    gate.release();
    assert.equal((await rejected).message, 'socket hang up');
    await gate.settled;
    assert.equal(owned.mutations, 1);
    assert.equal(owned.proxy.observations.length, 1);
  } finally { await owned.close(); }
});

test('a held dispatch drains its split original response after its cancelled caller closes instead of draining', { timeout: 5000 }, async () => {
  const body = Promise.withResolvers<void>();
  const owned = await fixture(0, body.promise);
  try {
    const gate = owned.proxy.arm({ method: 'POST', path: '/v1.52/mutate', mode: 'hold_request', timeoutMs: 1000 });
    const sent = request({ socketPath: owned.proxy.endpoint.slice(7), path: '/v1.52/mutate', method: 'POST', agent: false,
      headers: { connection: 'close', 'content-length': 0 } });
    const rejected = new Promise<Error>((resolve) => sent.once('error', resolve));
    sent.end();
    await gate.entered;
    sent.destroy(new Error('Cancel this caller before original dispatch.'));
    assert.equal((await rejected).message, 'Cancel this caller before original dispatch.');
    gate.release();
    await gate.callerClosed;
    assert.equal(owned.mutations, 1);
    assert.deepEqual(owned.proxy.observations, [], 'Response headers alone do not settle the original reply.');
    body.resolve();
    const observed = await gate.responded;
    assert.equal(observed.status, 201);
    assert.deepEqual(JSON.parse(observed.responsePrefix), { Id: 'a'.repeat(64), mutations: 1 });
    await gate.settled;
    assert.equal(owned.mutations, 1);
    assert.equal(owned.proxy.observations.length, 1);
  } finally { body.resolve(); await owned.close(); }
});
