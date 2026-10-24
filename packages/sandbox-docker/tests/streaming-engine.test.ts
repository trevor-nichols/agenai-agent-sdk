// ------------------------------------------------------------------------------------------------
//                streaming-engine.test.ts - Backpressured Unix transfers - Actual source/socket joins
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DockerEngine } from '../src/engine/client.js';
import type { DockerEngineStreamResponse } from '../src/engine/contracts.js';

async function withEngine(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, use: (client: DockerEngine) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agenai-stream-'));
  const socketPath = join(directory, 'engine.sock');
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch((error: unknown) => { failures.push(error); response.destroy(); }); });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try { await use(new DockerEngine(socketPath)); assert.deepEqual(failures, []); }
  finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
}

async function smallResponse({ body }: DockerEngineStreamResponse): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) { size += chunk.length; assert(size <= 4096); chunks.push(Uint8Array.from(chunk)); }
  return Buffer.concat(chunks).toString();
}

test('streaming PUT stalls its caller producer behind a slow reader and joins the actual writer', { timeout: 10_000 }, async () => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const chunk = Buffer.alloc(65536, 7);
  let produced = 0;
  let finalized = false;
  await withEngine(async (request, response) => {
    arrived.resolve();
    await release.promise;
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const value of request) { assert(value instanceof Uint8Array); bytes += value.length; hash.update(value); await turn(); }
    response.end(JSON.stringify({ bytes, digest: hash.digest('hex') }));
  }, async (client) => {
    async function* body() { try { for (let index = 0; index < 128; index += 1) { produced += 1; yield chunk; } } finally { finalized = true; } }
    const work = client.stream('PUT', '/archive', { body: body(), chunkBytes: 65536 }, smallResponse);
    await arrived.promise;
    await delay(20);
    const stopped = produced;
    await delay(20);
    assert.equal(produced, stopped);
    assert(stopped > 0 && stopped < 128);
    release.resolve();
    const result = await work;
    const hash = createHash('sha256');
    for (let index = 0; index < 128; index += 1) hash.update(chunk);
    assert.deepEqual(JSON.parse(result.value), { bytes: 8 * 1024 ** 2, digest: hash.digest('hex') });
    assert.equal(result.uploadedBytes, 8n * 1024n ** 2n);
    assert.equal(finalized, true);
  });
});

test('response chunks remain bounded through a slow consumer with no whole-transfer header timer', { timeout: 5000 }, async () => {
  await withEngine(async (_request, response) => {
    response.flushHeaders();
    for (let index = 0; index < 32; index += 1) if (!response.write(Buffer.alloc(65536, 11))) await once(response, 'drain');
    response.end();
  }, async (client) => {
    const result = await client.stream('GET', '/archive', { chunkBytes: 65536, headerTimeoutMs: 30 }, async ({ body }) => {
      let bytes = 0;
      for await (const chunk of body) { assert(chunk.length <= 65536); bytes += chunk.length; if (bytes === chunk.length) await delay(60); else await turn(); }
      return bytes;
    });
    assert.equal(result.value, 2 * 1024 ** 2);
    assert.equal(result.downloadedBytes, 2n * 1024n ** 2n);
  });
});

test('streaming HEAD drains an empty body while retaining nonzero representation Content-Length', async () => {
  await withEngine((_request, response) => { response.setHeader('content-length', '98765'); response.end(); }, async (client) => {
    const result = await client.stream('HEAD', '/archive', { chunkBytes: 65536 }, async (response) => {
      assert.equal(response.headers['content-length'], '98765');
      return smallResponse(response);
    });
    assert.equal(result.value, '');
    assert.equal(result.downloadedBytes, 0n);
  });
});

test('abort waits for cooperative producer finally and does not fabricate noncooperative joins', { timeout: 5000 }, async (context) => {
  for (const cooperative of [true, false]) await context.test(cooperative ? 'cooperative' : 'noncooperative', async () => {
    const controller = new AbortController();
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let finalized = false;
    let settled = false;
    await withEngine(async (request) => { try { for await (const _chunk of request) { /* Drain until controlled client cancellation. */ } } catch { /* Client cancellation is the fixture outcome. */ } }, async (client) => {
      async function* source(signal: AbortSignal) {
        try {
          yield Buffer.from('entered');
          waiting.resolve();
          if (cooperative) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
          else await release.promise;
        } finally { if (cooperative) await release.promise; finalized = true; }
      }
      const work = client.stream('PUT', '/archive', { body: source, signal: controller.signal, chunkBytes: 65536 }, smallResponse);
      void work.finally(() => { settled = true; }).catch(() => {});
      await waiting.promise;
      controller.abort();
      await turn();
      assert.equal(settled, false);
      assert.equal(finalized, false);
      release.resolve();
      await assert.rejects(work);
      assert.equal(finalized, true);
    });
  });
});

test('falsy callback failures, abandoned bodies and concurrent response pulls preserve failure ownership', async () => {
  await withEngine((_request, response) => { response.end('visible bytes'); }, async (client) => {
    for (const marker of [undefined, null, false, 0, '']) await assert.rejects(client.stream('GET', '/archive', { chunkBytes: 65536 }, () => Promise.reject(marker)), (error) => error === marker);
    await assert.rejects(client.stream('GET', '/archive', { chunkBytes: 65536 }, async ({ body }) => {
      for await (const chunk of body) { assert.equal(Buffer.from(chunk).toString(), 'visible bytes'); break; }
    }), /abandoned|drain/);
    await assert.rejects(client.stream('GET', '/archive', { chunkBytes: 65536 }, async ({ body }) => {
      const iterator = body[Symbol.asyncIterator]();
      const first = iterator.next();
      await assert.rejects(iterator.next(), /Concurrent/);
      assert.equal(Buffer.from((await first).value).toString(), 'visible bytes');
    }), /Concurrent/);
  });
});
