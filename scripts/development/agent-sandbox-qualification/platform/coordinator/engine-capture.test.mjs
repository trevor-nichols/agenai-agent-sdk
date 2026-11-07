import assert from 'node:assert/strict';
import http, { request as namedRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Evidence, sha } from './evidence.mjs';
import { installEngineCapture } from './engine-capture.mjs';

async function fixture(handle) {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-ec-'));
  const socketPath = join(directory, 'e.sock'); const evidence = new Evidence(join(directory, 'out'));
  await evidence.initialize(Buffer.from('{}\n'));
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const originalRequest = http.request; const originalGet = http.get;
  const capture = await installEngineCapture({ socketPath, evidence });
  return { socketPath, capture,
    async index(summary) { return JSON.parse(await readFile(summary.index.path, 'utf8')); },
    async close() {
      await capture.close();
      assert.equal(http.request, originalRequest); assert.equal(http.get, originalGet);
      await evidence.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true });
    } };
}

function consume(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    assert.equal(response.listenerCount('data'), 0, 'Capture must not install a data listener or start response flow.');
    response.pause();
    setImmediate(() => {
      assert.equal(response.readableFlowing, false);
      response.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); chunk.fill(0); });
      response.once('end', () => resolve(Buffer.concat(chunks)));
      response.once('error', reject); response.resume();
    });
  });
}

test('passive Engine capture preserves original bytes and caller-controlled flow through default and named Node HTTP exports', async () => {
  const id = 'a'.repeat(64);
  const targets = ['/info', '/v1.52/networks', `/v1.52/networks/${id}`, `/v1.52/containers/${id}/json`,
    '/v1.52/networks/original-network', '/v1.52/containers/original-observer/json'];
  const arrived = [];
  const original = Buffer.from(' {\n  "Name": "bridge", "Options": null\n}\n');
  const owned = await fixture((request, response) => {
    arrived.push({ method: request.method, target: request.url });
    response.setHeader('content-type', 'application/json');
    response.write(original.subarray(0, 7)); setImmediate(() => response.end(original.subarray(7)));
  });
  const request = (method, path, get = false) => new Promise((resolve, reject) => {
    const options = { socketPath: owned.socketPath, method, path };
    const callback = (response) => { void consume(response).then(resolve, reject); };
    const call = get ? http.get(options, callback) : namedRequest(options, callback);
    call.once('error', reject); if (!get) call.end();
  });
  try {
    const before = Date.now() - 1;
    for (const [index, target] of targets.entries()) assert.deepEqual(await request('GET', target, index === 0), original);
    assert.equal(owned.capture.completedSince(/\/info$/u, before), 1);
    assert.equal(owned.capture.completedSince(/\/networks\//u, before), 2);
    assert.equal(owned.capture.completedSince(/\/info$/u, Date.now() + 1), 0);
    assert.deepEqual(await request('GET', '/version'), original);
    assert.deepEqual(await request('POST', '/v1.52/containers/create'), original);
    const summary = await owned.capture.close(); const index = await owned.index(summary);
    assert.equal(summary.completeness, 'complete'); assert.equal(summary.requests, targets.length);
    assert.deepEqual(index.entries.map(({ target }) => target), targets);
    for (const entry of index.entries) {
      assert.equal(entry.status, 200); assert.equal(entry.complete, true); assert.equal(entry.terminal, 'end');
      assert(entry.requestedAt <= entry.responseAt && entry.responseAt <= entry.finishedAt);
      assert.equal(entry.responseBytes, original.length); assert.equal(entry.body.sha256, sha(original));
      assert.deepEqual(await readFile(entry.body.path), original);
    }
    assert.deepEqual(arrived, [...targets.map((target) => ({ method: 'GET', target })),
      { method: 'GET', target: '/version' }, { method: 'POST', target: '/v1.52/containers/create' }]);
  } finally { await owned.close(); }
});

test('capture overflow records a bounded original prefix while the complete response still reaches its caller unchanged', async () => {
  const original = Buffer.alloc(4 * 1024 ** 2 + 17, 0x61);
  const owned = await fixture((_request, response) => response.end(original));
  try {
    const bytes = await new Promise((resolve, reject) => {
      const call = http.get({ socketPath: owned.socketPath, path: '/info' }, (response) => { void consume(response).then(resolve, reject); });
      call.once('error', reject);
    });
    assert.deepEqual(bytes, original);
    const summary = await owned.capture.close(); const index = await owned.index(summary);
    assert.equal(summary.completeness, 'failed'); assert.equal(summary.requests, 1);
    assert.equal(index.entries[0].responseBytes, original.length);
    assert.equal(index.entries[0].capturedBytes, 4 * 1024 ** 2); assert.equal(index.entries[0].complete, false);
    assert.deepEqual(await readFile(index.entries[0].body.path), original.subarray(0, 4 * 1024 ** 2));
    assert.match(summary.failures[0].message, /not completely captured/u);
  } finally { await owned.close(); }
});
