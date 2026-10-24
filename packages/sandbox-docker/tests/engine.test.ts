// ------------------------------------------------------------------------------------------------
//                engine.test.ts - Local Engine HTTP limits and ownership - Node test and HTTP
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { DockerEngine, DockerEngineTransportError, type DockerEngineTransportErrorCode } from '../src/engine/client.js';

async function fakeEngine(t: TestContext, handler: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), 'agenai-engine-'));
  const socketPath = join(directory, 'engine.sock');
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return { client: new DockerEngine(socketPath), socketPath };
}

function transportError(code: DockerEngineTransportErrorCode) {
  return (error: unknown) => error instanceof DockerEngineTransportError && error.code === code;
}

test('explicit Unix transport copies binary input and preserves the exact method, target, headers and response', async (t) => {
  const observed = Promise.withResolvers<{
    method: string | undefined;
    target: string | undefined;
    type: string | undefined;
    length: string | undefined;
    bytes: number[];
  }>();
  const { client } = await fakeEngine(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.once('end', () => {
      const body = Buffer.concat(chunks);
      observed.resolve({
        method: request.method,
        target: request.url,
        type: request.headers['content-type'],
        length: request.headers['content-length'],
        bytes: [...body],
      });
      response.writeHead(201, { 'content-length': body.byteLength });
      response.end(body);
    });
  });
  const body = Uint8Array.of(0, 255, 13, 65);
  const pending = client.request('PUT', '/v1.52/containers/owned/archive?path=%2Fworkspace', {
    timeoutMs: 1000,
    maxResponseBytes: 4,
    body,
    contentType: 'application/x-tar',
  });
  body.fill(7);
  const response = await pending;
  assert.deepEqual({ statusCode: response.statusCode, body: [...response.body] }, { statusCode: 201, body: [0, 255, 13, 65] });
  assert.deepEqual(await observed.promise, {
    method: 'PUT', target: '/v1.52/containers/owned/archive?path=%2Fworkspace',
    type: 'application/x-tar', length: '4', bytes: [0, 255, 13, 65],
  });
});

test('non-success statuses remain raw responses and redirects never dispatch a second request', async (t) => {
  const targets: Array<string | undefined> = [];
  const { client } = await fakeEngine(t, (request, response) => {
    targets.push(request.url);
    response.writeHead(302, { location: '/v1.52/containers/unowned/json', 'content-length': 5 });
    response.end('moved');
  });
  const response = await client.request('GET', '/version', { timeoutMs: 1000, maxResponseBytes: 5 });
  assert.deepEqual({ statusCode: response.statusCode, body: [...response.body] }, { statusCode: 302, body: [109, 111, 118, 101, 100] });
  assert.deepEqual(targets, ['/version']);
});

test('deadline spans both silent headers and a response that continually sends bytes', { timeout: 2000 }, async (t) => {
  for (const mode of ['silent', 'periodic'] as const) {
    await t.test(mode, async (t) => {
      const closed = Promise.withResolvers<void>();
      const { client } = await fakeEngine(t, (_request, response) => {
        const interval = mode === 'periodic' ? setInterval(() => response.write('x'), 10) : undefined;
        response.once('close', () => {
          clearInterval(interval);
          closed.resolve();
        });
        if (mode === 'periodic') response.write('start');
      });
      await assert.rejects(client.request('GET', '/info', { timeoutMs: 80, maxResponseBytes: 1024 }), transportError('deadline'));
      await closed.promise;
    });
  }
});

test('abort before dispatch is inert and an entered response is closed when cancellation settles', { timeout: 2000 }, async (t) => {
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const targets: Array<string | undefined> = [];
  const { client } = await fakeEngine(t, (request, response) => {
    targets.push(request.url);
    response.once('close', () => closed.resolve());
    response.write('entered');
    entered.resolve();
  });
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(client.request('GET', '/version', {
    timeoutMs: 1000, maxResponseBytes: 100, signal: preAborted.signal,
  }), transportError('aborted'));

  const active = new AbortController();
  const pending = client.request('GET', '/info', { timeoutMs: 1000, maxResponseBytes: 100, signal: active.signal });
  const rejected = assert.rejects(pending, transportError('aborted'));
  await entered.promise;
  active.abort();
  await rejected;
  await closed.promise;
  assert.deepEqual(targets, ['/info']);
});

test('advertised and chunked response overflows reject before retaining an excessive body', async (t) => {
  for (const mode of ['advertised', 'chunked'] as const) {
    await t.test(mode, async (t) => {
      const closed = Promise.withResolvers<void>();
      const { client } = await fakeEngine(t, (_request, response) => {
        response.once('close', () => closed.resolve());
        if (mode === 'advertised') {
          response.writeHead(200, { 'content-length': 9 });
          response.flushHeaders();
        } else {
          response.write('1234');
          response.end('56789');
        }
      });
      await assert.rejects(client.request('GET', '/info', { timeoutMs: 1000, maxResponseBytes: 8 }), transportError('response_limit'));
      await closed.promise;
    });
  }
});

test('invalid length, truncation and oversized headers fail while an exact zero-byte response succeeds', async (t) => {
  const hostileResponses = new Map([
    ['/version', 'HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nshort'],
    ['/info', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabc'],
    ['/v1.52/containers/negative/json', 'HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n'],
    ['/v1.52/containers/duplicate/json', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nab'],
    ['/v1.52/containers/excess/json', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nabcd'],
    ['/v1.52/containers/headers/json', `HTTP/1.1 200 OK\r\nX-Excess: ${'x'.repeat(32_768)}\r\n\r\n`],
  ]);
  const { client } = await fakeEngine(t, (request, response) => {
    if (request.url === '/v1.52/containers/owned/stop') {
      response.writeHead(204);
      response.end();
      return;
    }
    const hostileResponse = hostileResponses.get(request.url ?? '');
    if (hostileResponse === undefined) throw new Error('Unexpected fake Engine request target');
    request.socket.end(hostileResponse);
  });
  for (const path of hostileResponses.keys()) {
    await assert.rejects(client.request('GET', path, { timeoutMs: 1000, maxResponseBytes: 20 }), transportError('invalid_response'));
  }
  const response = await client.request('POST', '/v1.52/containers/owned/stop', { timeoutMs: 1000, maxResponseBytes: 0 });
  assert.deepEqual({ statusCode: response.statusCode, body: [...response.body] }, { statusCode: 204, body: [] });
});

test('a peer failure rejects once without replaying the request', async (t) => {
  const targets: Array<string | undefined> = [];
  const { client } = await fakeEngine(t, (request) => {
    targets.push(request.url);
    request.socket.destroy();
  });
  await assert.rejects(client.request('POST', '/v1.52/containers/create?name=one-operation', {
    timeoutMs: 1000, maxResponseBytes: 100, body: Buffer.from('{}'), contentType: 'application/json',
  }), transportError('connection'));
  assert.deepEqual(targets, ['/v1.52/containers/create?name=one-operation']);
});

test('unexpected HTTP upgrade is rejected and its owned connection is closed', { timeout: 2000 }, async (t) => {
  const closed = Promise.withResolvers<void>();
  const { client } = await fakeEngine(t, (request) => {
    request.socket.once('close', () => closed.resolve());
    request.socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  });
  await assert.rejects(client.request('GET', '/info', { timeoutMs: 1000, maxResponseBytes: 100 }), transportError('invalid_response'));
  await closed.promise;
});

test('endpoint and request admission reject remote authority and invalid timer or byte limits before dispatch', async (t) => {
  for (const endpoint of ['http://localhost:2375', 'unix:///var/run/docker.sock', 'relative.sock', '//remote/socket', '/tmp/invalid\0socket']) {
    assert.throws(() => new DockerEngine(endpoint), TypeError);
  }
  const targets: Array<string | undefined> = [];
  const { client } = await fakeEngine(t, (request, response) => {
    targets.push(request.url);
    response.end('ok');
  });
  for (const path of ['http://localhost/info', '//localhost/info', '/info#fragment', '/info\r\nInjected: value', '/info\\other']) {
    await assert.rejects(client.request('GET', path, { timeoutMs: 1000, maxResponseBytes: 2 }), TypeError);
  }
  for (const limits of [
    { timeoutMs: 0, maxResponseBytes: 2 },
    { timeoutMs: 2_147_483_648, maxResponseBytes: 2 },
    { timeoutMs: 1000, maxResponseBytes: -1 },
    { timeoutMs: 1000, maxResponseBytes: Number.POSITIVE_INFINITY },
  ]) await assert.rejects(client.request('GET', '/info', limits), TypeError);
  const response = await client.request('GET', '/info', { timeoutMs: 1000, maxResponseBytes: 2 });
  assert.deepEqual({ statusCode: response.statusCode, body: [...response.body] }, { statusCode: 200, body: [111, 107] });
  assert.deepEqual(targets, ['/info']);
});
