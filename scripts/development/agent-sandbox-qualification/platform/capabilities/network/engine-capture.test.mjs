import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { until } from '../../../engine.mjs';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';
import { createEngineNetworkCapture } from './engine-capture.mjs';

const profile = 'desktop-apple-virtualization-native-arm64';
const namespace = 'platform-net-12345678-case', image = `sha256:${'c'.repeat(64)}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function network(id) {
  return { Id: id, Name: `owned-${id.slice(0, 8)}`, Labels: { 'ai.agen.sandbox.role': 'network',
    'ai.agen.sandbox.backend': 'agenai-docker', 'ai.agen.sandbox.revision': `engine-1.52-v6-${profile}`,
    'ai.agen.sandbox.namespace': namespace, 'ai.agen.sandbox.image': image,
    'ai.agen.sandbox.operation': '12345678-1234-4123-8123-123456789abc',
    'ai.agen.sandbox.record': `sha256:${'d'.repeat(64)}`, 'ai.agen.sandbox.configuration': `sha256:${'e'.repeat(64)}`,
    'ai.agen.sandbox.policy': `sha256:${'f'.repeat(64)}` },
  Options: { 'com.docker.network.enable_ipv4': 'true' }, Opaque: 'Unmodified é bytes\u0000' };
}
async function fixture(t, handle, wrap = (observer) => observer) {
  const root = await mkdtemp(join(tmpdir(), 'ec-'));
  const upstreamPath = join(root, 'u'); const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(upstreamPath, resolve));
  const capture = await createEngineNetworkCapture({ directory: join(root, 'capture'), profile,
    namespacePrefix: 'platform-net-12345678-', workloadImage: image,
    source: { path: '/qualification/engine-capture.mjs', byteLength: 1, sha256: 'a'.repeat(64), allocatedBytes: '4096' } });
  const proxy = await createTraceProxy({ socketPath: join(root, 'p'), upstreamEndpoint: `unix://${upstreamPath}`,
    tracePath: join(root, 'trace.jsonl'), observeResponseBody: (event) => wrap(capture.observeResponseBody(event), event) });
  t.after(async () => {
    try { await proxy.close(); await capture.close(); }
    finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
  });
  const get = (id) => {
    const received = { bytes: Buffer.alloc(0), status: null, headers: null };
    const ready = Promise.withResolvers(), done = Promise.withResolvers();
    const request = http.get({ socketPath: join(root, 'p'), path: `/v1.52/networks/${id}`, agent: false, signal: t.signal }, (response) => {
      received.status = response.statusCode; received.headers = response.headers; received.response = response; ready.resolve();
      response.on('data', (chunk) => { received.bytes = Buffer.concat([received.bytes, chunk]); });
      response.once('error', done.reject); response.once('end', () => done.resolve(received));
    });
    request.setTimeout(5000, () => request.destroy(new Error('Fixture HTTP response deadline.')));
    request.once('error', (error) => { ready.reject(error); done.reject(error); });
    void ready.promise.catch(() => {}); void done.promise.catch(() => {});
    return { received, ready: ready.promise, done: done.promise, request };
  };
  return { root, capture, proxy, get };
}

test('Engine capture preserves fragmented HTTP bytes and joins complete capture while a real file collision remains sticky', { timeout: 15_000 }, async (t) => {
  const original = '1'.repeat(64), collision = '2'.repeat(64), unrelated = '3'.repeat(64);
  const raw = Buffer.from(` \n${JSON.stringify(network(original), null, 2)}\n`);
  const collisionRaw = Buffer.from(JSON.stringify(network(collision)));
  const unrelatedRaw = Buffer.from(JSON.stringify({ Id: unrelated, Labels: { caller: 'unrelated' } }));
  const responses = new Map(); const release = Promise.withResolvers(); let completeEntered = false;
  t.signal.addEventListener('abort', () => release.resolve(), { once: true });
  const context = await fixture(t, (request, response) => {
    const id = request.url.split('/').at(-1); responses.set(id, response);
    const bytes = id === original ? raw : id === collision ? collisionRaw : unrelatedRaw;
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length }); response.flushHeaders();
    if (id !== original) response.end(bytes);
  }, (observer, event) => !observer || !event.target.endsWith(original) ? observer : {
    body: observer.body, async complete(outcome) { completeEntered = true; await release.promise; await observer.complete(outcome); },
  });
  try {
    const request = context.get(original);
    await until(() => responses.has(original), 5000, 'Original upstream request did not enter.');
    responses.get(original).write(raw.subarray(0, 2)); await request.ready;
    await until(() => request.received.bytes.length === 2, 5000, 'First original HTTP fragment was not forwarded.');
    for (const chunk of [raw.subarray(2, 17), raw.subarray(17)]) {
      const expected = request.received.bytes.length + chunk.length; responses.get(original).write(chunk);
      await until(() => request.received.bytes.length >= expected, 5000, 'Original HTTP fragment was not forwarded.');
    }
    responses.get(original).end(); const received = await request.done;
    await until(() => completeEntered, 5000, 'Original body completion did not enter.');
    assert.equal(received.status, 200); assert.equal(received.headers['content-length'], String(raw.length)); assert.deepEqual(received.bytes, raw);
    let idleSettled = false; const idle = context.proxy.idle().then(() => { idleSettled = true; });
    await setImmediate(); assert.equal(idleSettled, false); release.resolve(); await idle;
    const preservedPath = join(context.root, 'capture', `${collision}-01.json`); const sentinel = Buffer.from('original collision sentinel');
    await writeFile(preservedPath, sentinel, { flag: 'wx' });
    assert.deepEqual((await context.get(collision).done).bytes, collisionRaw);
    assert.deepEqual((await context.get(unrelated).done).bytes, unrelatedRaw);
    await context.proxy.idle(); await context.proxy.close(); const receipt = await context.capture.close();
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.joined, true); assert.equal(receipt.inspectionFiles, 2); assert.equal(receipt.filesClosed, 1);
    const indexBytes = await readFile(receipt.indexPath); assert.equal(receipt.sha256, sha(indexBytes));
    const index = JSON.parse(indexBytes); assert.equal(index.ignoredResponses, 1); assert.equal(index.networks.length, 2);
    const inspection = index.networks.find(({ id }) => id === original).inspections[0];
    assert.equal(inspection.state, 'closed'); assert.equal(inspection.bytes, raw.length); assert.equal(inspection.sha256, sha(raw));
    assert.deepEqual(await readFile(inspection.path), raw); assert.deepEqual(await readFile(preservedPath), sentinel);
    const trace = (await readFile(join(context.root, 'trace.jsonl'), 'utf8')).trim().split('\n').map((text) => JSON.parse(text));
    assert.equal(trace.find(({ id }) => id === inspection.traceId).target, inspection.target);
    assert.equal(index.failures.length, 1); assert.equal(index.failures[0].failure.code, 'EEXIST');
  } finally { release.resolve(); }
});

test('partial Engine response closes with an unconfirmed byte witness and joins its entered completion', { timeout: 15_000 }, async (t) => {
  const id = '1'.repeat(64), partial = Buffer.from('{"Id":"partial');
  const release = Promise.withResolvers(); let response, outcome;
  t.signal.addEventListener('abort', () => release.resolve(), { once: true });
  const context = await fixture(t, (_request, actual) => { response = actual;
    actual.writeHead(200, { 'content-type': 'application/json', 'content-length': partial.length + 100 }); actual.flushHeaders();
  }, (observer) => ({ body: observer.body, async complete(value) { outcome = value; await release.promise; await observer.complete(value); } }));
  try {
    const request = context.get(id); await until(() => response, 5000, 'Partial upstream request did not enter.');
    response.write(partial); await request.ready;
    await until(() => request.received.bytes.length === partial.length, 5000, 'Partial original bytes were not forwarded.');
    const closed = new Promise((resolve) => request.received.response.once('close', resolve)); request.received.response.destroy(); await closed;
    await until(() => outcome, 5000, 'Partial body completion did not enter.'); assert.equal(outcome.complete, false);
    let settled = false; const closing = context.proxy.close().then(() => { settled = true; });
    await setImmediate(); assert.equal(settled, false); release.resolve(); await closing;
    const receipt = await context.capture.close(); assert.equal(receipt.status, 'captured'); assert.equal(receipt.failures, 0);
    assert.equal(receipt.inspectionFiles, 0); assert.equal(receipt.incompleteResponses, 1); assert.equal(receipt.joined, true);
    const index = JSON.parse(await readFile(receipt.indexPath)); assert.equal(index.networks.length, 0);
    assert.equal(index.incomplete[0].bytes, partial.length); assert.equal(index.incomplete[0].sha256, sha(partial));
    assert.equal(index.incomplete[0].disposition, 'incomplete_unconfirmed'); assert.equal(index.incomplete[0].retainedAsCompleteInspection, false);
  } finally { release.resolve(); }
});
