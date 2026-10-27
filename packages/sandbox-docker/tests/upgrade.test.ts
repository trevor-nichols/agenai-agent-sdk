// ------------------------------------------------------------------------------------------------
//                upgrade.test.ts - Engine attach/exec duplex ownership - Local Unix socket peers
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DockerEngine, DockerEngineTransportError, type DockerEngineTransportErrorCode } from '../src/engine/client.js';
import { DockerApi } from '../src/resources/api.js';

interface PeerRequest {
  readonly requestLine: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Buffer;
}

const responseHeaders = 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n';
const startBody = Buffer.from('{"Detach":false,"Tty":false}');
const startPath = '/v1.52/exec/owned-exec/start';
const startOptions = { timeoutMs: 1000, maxResponseBytes: 1024, body: startBody, contentType: 'application/json' } as const;

async function peer(t: TestContext, handler: (request: PeerRequest, socket: Socket) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'agenai-upgrade-'));
  const socketPath = join(directory, 'engine.sock');
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let bytes = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      const headerEnd = bytes.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const [requestLine = '', ...headerLines] = bytes.subarray(0, headerEnd).toString('ascii').split('\r\n');
      const headers = new Map(headerLines.map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
      }));
      const length = Number(headers.get('content-length'));
      if (bytes.byteLength < headerEnd + 4 + length) return;
      socket.removeListener('data', onData);
      handler({ requestLine, headers, body: bytes.subarray(headerEnd + 4) }, socket);
    };
    socket.on('data', onData);
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
  return new DockerEngine(socketPath);
}

function transportError(code: DockerEngineTransportErrorCode) {
  return (error: unknown) => error instanceof DockerEngineTransportError && error.code === code;
}

test('exec upgrade copies the explicit JSON request and preserves split/coalesced binary head once through half-close', { timeout: 3000 }, async (t) => {
  for (const splitHeaders of [false, true]) {
    await t.test(splitHeaders ? 'split headers' : 'coalesced headers', async (t) => {
      const observed = Promise.withResolvers<PeerRequest>();
      const receivedInput = Promise.withResolvers<Buffer>();
      const peerClosed = Promise.withResolvers<void>();
      const initialOutput = Buffer.from([0, 255, 10, 13]);
      const finalOutput = Buffer.from([254, 0, 128]);
      const client = await peer(t, (request, socket) => {
        observed.resolve(request);
        socket.once('close', () => peerClosed.resolve());
        const input: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => input.push(chunk));
        socket.once('end', () => {
          receivedInput.resolve(Buffer.concat(input));
          socket.end(finalOutput);
        });
        if (splitHeaders) {
          socket.write(responseHeaders.slice(0, 17));
          void nextTurn().then(() => socket.write(Buffer.concat([Buffer.from(responseHeaders.slice(17)), initialOutput])));
        } else {
          socket.write(Buffer.concat([Buffer.from(responseHeaders), initialOutput]));
        }
      });
      const body = Buffer.from(startBody);
      const controller = new AbortController();
      const pending = client.upgrade(startPath, { ...startOptions, timeoutMs: 80, body, signal: controller.signal });
      body.fill(120);
      const attached = await pending;
      assert.deepEqual([...attached.head], [0, 255, 10, 13]);
      const request = await observed.promise;
      assert.deepEqual({
        requestLine: request.requestLine,
        connection: request.headers.get('connection'),
        upgrade: request.headers.get('upgrade'),
        contentType: request.headers.get('content-type'),
        contentLength: request.headers.get('content-length'),
        body: request.body.toString(),
      }, {
        requestLine: 'POST /v1.52/exec/owned-exec/start HTTP/1.1',
        connection: 'Upgrade', upgrade: 'tcp', contentType: 'application/json', contentLength: '28',
        body: '{"Detach":false,"Tty":false}',
      });

      controller.abort();
      await delay(120);
      const output: Buffer[] = [Buffer.from(attached.head)];
      attached.stream.end(Buffer.from([0, 255, 65, 10]));
      for await (const chunk of attached.stream) output.push(Buffer.from(chunk));
      await attached.closed;
      await peerClosed.promise;
      assert.deepEqual([...await receivedInput.promise], [0, 255, 65, 10]);
      assert.deepEqual([...Buffer.concat(output)], [0, 255, 10, 13, 254, 0, 128]);
    });
  }
});

test('API upgrades isolate HTTP request bodies from attached stdin', { timeout: 3000 }, async (t) => {
  for (const kind of ['attach', 'exec'] as const) {
    await t.test(kind === 'attach' ? 'bodyless attach' : 'JSON exec-start', async (t) => {
      const observed = Promise.withResolvers<PeerRequest>();
      const receivedInput = Promise.withResolvers<Buffer>();
      const client = await peer(t, (request, socket) => {
        observed.resolve(request);
        // Attach hands raw connection bytes to stdin without consuming an HTTP body.
        const input: Buffer[] = kind === 'attach' ? [request.body] : [];
        socket.on('data', (chunk: Buffer) => input.push(Buffer.from(chunk)));
        socket.once('end', () => {
          receivedInput.resolve(Buffer.concat(input));
          socket.end(Buffer.from([0xff, 0x00, 0x80]));
        });
        socket.write(responseHeaders);
      });
      const api = new DockerApi(client, 1000);
      const path = kind === 'attach' ? '/v1.52/containers/owned-helper/attach?stream=true&stdin=true&stdout=true&stderr=true' : startPath;
      const attached = await api.upgrade(path, kind === 'attach' ? undefined : { Detach: false, Tty: false });
      const request = await observed.promise;
      assert.deepEqual({ requestLine: request.requestLine, contentType: request.headers.get('content-type'),
        contentLength: request.headers.get('content-length'), transferEncoding: request.headers.get('transfer-encoding'),
        body: request.body.toString() }, kind === 'attach' ? {
        requestLine: `POST ${path} HTTP/1.1`, contentType: 'text/plain', contentLength: '0', transferEncoding: undefined, body: '',
      } : {
        requestLine: `POST ${startPath} HTTP/1.1`, contentType: 'application/json', contentLength: '28', transferEncoding: undefined,
        body: '{"Detach":false,"Tty":false}',
      });
      attached.stream.end(Buffer.from([0x00, 0x00, 0x00, 0x0a, 0x7b, 0x7d]));
      const output: Buffer[] = [Buffer.from(attached.head)];
      for await (const chunk of attached.stream) output.push(Buffer.from(chunk));
      await attached.closed;
      assert.deepEqual([...await receivedInput.promise], [0x00, 0x00, 0x00, 0x0a, 0x7b, 0x7d]);
      assert.deepEqual([...Buffer.concat(output)], [0xff, 0x00, 0x80]);
    });
  }
});

test('only an actual tcp upgrade is handed off; ordinary responses, malformed headers and truncated bodies fail closed', { timeout: 3000 }, async (t) => {
  const cases = [
    ['ordinary success', 'HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody'],
    ['ordinary error', 'HTTP/1.1 409 Conflict\r\nContent-Length: 4\r\n\r\nfail'],
    ['redirect', 'HTTP/1.1 302 Found\r\nLocation: /other\r\nContent-Length: 0\r\n\r\n'],
    ['wrong protocol', 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'],
    ['missing protocol', 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n\r\n'],
    ['missing connection upgrade', 'HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\nUpgrade: tcp\r\n\r\n'],
    ['header limit', `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nX-Large: ${'x'.repeat(32_768)}\r\n\r\n`],
    ['invalid length', 'HTTP/1.1 500 Error\r\nContent-Length: -1\r\n\r\n'],
    ['truncated error', 'HTTP/1.1 500 Error\r\nContent-Length: 10\r\n\r\nshort'],
  ];
  for (const [name = '', wire = ''] of cases) {
    await t.test(name, async (t) => {
      const closed = Promise.withResolvers<void>();
      const requests: string[] = [];
      const client = await peer(t, (request, socket) => {
        requests.push(request.requestLine);
        socket.once('close', () => closed.resolve());
        socket.end(wire);
      });
      await assert.rejects(client.upgrade(startPath, startOptions), transportError('invalid_response'));
      await closed.promise;
      assert.deepEqual(requests, ['POST /v1.52/exec/owned-exec/start HTTP/1.1']);
    });
  }
});

test('ordinary handshake error responses enforce advertised and chunked byte ceilings', { timeout: 2000 }, async (t) => {
  for (const wire of [
    'HTTP/1.1 500 Error\r\nContent-Length: 9\r\n\r\n',
    'HTTP/1.1 500 Error\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n1234\r\n5\r\n56789\r\n0\r\n\r\n',
  ]) {
    const closed = Promise.withResolvers<void>();
    const client = await peer(t, (_request, socket) => {
      socket.once('close', () => closed.resolve());
      socket.write(wire);
      socket.on('end', () => socket.end());
    });
    await assert.rejects(client.upgrade(startPath, { ...startOptions, maxResponseBytes: 8 }), transportError('response_limit'));
    await closed.promise;
  }
});

test('early abort dispatches nothing and in-flight abort closes a partial handshake despite a late upgrade', { timeout: 2000 }, async (t) => {
  const entered = Promise.withResolvers<Socket>();
  const closed = Promise.withResolvers<void>();
  const requests: string[] = [];
  const client = await peer(t, (request, socket) => {
    requests.push(request.requestLine);
    socket.once('close', () => closed.resolve());
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\n');
    entered.resolve(socket);
  });
  const early = new AbortController();
  early.abort();
  await assert.rejects(client.upgrade(startPath, { ...startOptions, signal: early.signal }), transportError('aborted'));
  const active = new AbortController();
  const pending = client.upgrade(startPath, { ...startOptions, signal: active.signal });
  const rejected = assert.rejects(pending, transportError('aborted'));
  const socket = await entered.promise;
  active.abort();
  socket.end('Upgrade: tcp\r\n\r\nlate-output');
  await rejected;
  await closed.promise;
  assert.deepEqual(requests, ['POST /v1.52/exec/owned-exec/start HTTP/1.1']);
});

test('elapsed handshake deadlines survive periodic headers and error-body activity and close late responses', { timeout: 3000 }, async (t) => {
  for (const mode of ['headers', 'error body'] as const) {
    await t.test(mode, async (t) => {
      const closed = Promise.withResolvers<void>();
      const attemptedLateResponse = Promise.withResolvers<void>();
      const client = await peer(t, (_request, socket) => {
        socket.write(mode === 'headers'
          ? 'HTTP/1.1 101 Switching Protocols\r\nX-Slow: '
          : 'HTTP/1.1 500 Error\r\nTransfer-Encoding: chunked\r\n\r\n');
        const interval = setInterval(() => socket.write(mode === 'headers' ? 'x' : '1\r\nx\r\n'), 10);
        socket.once('close', () => {
          clearInterval(interval);
          closed.resolve();
        });
        socket.on('end', () => socket.end());
        setTimeout(() => {
          socket.end(mode === 'headers' ? '\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nlate' : '0\r\n\r\n');
          attemptedLateResponse.resolve();
        }, 140);
      });
      await assert.rejects(client.upgrade(startPath, { ...startOptions, timeoutMs: 70 }), transportError('deadline'));
      await closed.promise;
      await attemptedLateResponse.promise;
    });
  }
});

test('attachment closure observes stream errors without an unhandled rejection and settles after actual close', { timeout: 2000 }, async (t) => {
  const client = await peer(t, (_request, socket) => {
    socket.write(responseHeaders);
    socket.on('end', () => socket.end());
  });
  const attached = await client.upgrade(startPath, startOptions);
  let didClose = false;
  attached.stream.once('close', () => { didClose = true; });
  attached.stream.destroy(new Error('caller transport failure'));
  await nextTurn();
  await assert.rejects(attached.closed, transportError('connection'));
  assert.equal(didClose, true);
});

test('competing abort/deadline callbacks retain the first failure and close a later successful handshake', { timeout: 2000 }, async (t) => {
  for (const first of ['aborted', 'deadline'] as const) {
    await t.test(first, async (t) => {
      const closed = Promise.withResolvers<void>();
      const attemptedLateUpgrade = Promise.withResolvers<void>();
      const client = await peer(t, (_request, socket) => {
        socket.once('close', () => closed.resolve());
        socket.on('end', () => socket.end());
        setTimeout(() => {
          socket.end(responseHeaders);
          attemptedLateUpgrade.resolve();
        }, 80);
      });
      const controller = new AbortController();
      const abort = () => setTimeout(() => controller.abort(), 40);
      const earlierAbort = first === 'aborted' ? abort() : undefined;
      const pending = client.upgrade(startPath, { ...startOptions, timeoutMs: 40, signal: controller.signal });
      const laterAbort = first === 'deadline' ? abort() : undefined;
      t.after(() => {
        clearTimeout(earlierAbort);
        clearTimeout(laterAbort);
      });
      await assert.rejects(pending, transportError(first));
      await closed.promise;
      await attemptedLateUpgrade.promise;
    });
  }
});

test('peer disconnection before a handshake fails without replay', { timeout: 2000 }, async (t) => {
  const requests: string[] = [];
  const client = await peer(t, (request, socket) => {
    requests.push(request.requestLine);
    socket.destroy();
  });
  await assert.rejects(client.upgrade(startPath, startOptions), transportError('connection'));
  assert.deepEqual(requests, ['POST /v1.52/exec/owned-exec/start HTTP/1.1']);
});

test('upgrade admission requires bounded local targets and consistent empty or JSON bodies before dispatch', { timeout: 2000 }, async (t) => {
  const requests: string[] = [];
  const client = await peer(t, (request, socket) => {
    requests.push(request.requestLine);
    socket.end(responseHeaders);
  });
  for (const path of ['//remote/start', 'http://localhost/start', '/start#fragment', '/start\r\nInjected: true']) {
    await assert.rejects(client.upgrade(path, startOptions), TypeError);
  }
  for (const options of [
    { timeoutMs: 1000, maxResponseBytes: 10, contentType: 'application/json' as const },
    { timeoutMs: 1000, maxResponseBytes: 10, body: startBody },
    { ...startOptions, contentType: 'application/x-tar' as const },
    { ...startOptions, timeoutMs: 0 },
    { ...startOptions, maxResponseBytes: -1 },
  ]) await assert.rejects(client.upgrade(startPath, options), TypeError);
  const attached = await client.upgrade(startPath, startOptions);
  attached.stream.resume();
  await attached.closed;
  assert.deepEqual(requests, ['POST /v1.52/exec/owned-exec/start HTTP/1.1']);
});
