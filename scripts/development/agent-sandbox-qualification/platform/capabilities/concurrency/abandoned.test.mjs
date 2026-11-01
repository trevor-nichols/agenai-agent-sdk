import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConcurrencyEvidence, createPhaseCollector, createConcurrencyCapture } from './evidence.mjs';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';

async function setup(t, maxResponseBytes = 65_536) {
  const parent = await mkdtemp(join(tmpdir(), 'abandoned-capture-')), directory = join(parent, 'attempt');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const evidence = new ConcurrencyEvidence(directory, 16 * 1024 ** 2); await evidence.initialize('{}');
  const budget = { maximumPhases: 8, maximumObservations: 640, maximumEngineResponses: 128, maximumEngineTerminals: 256,
    maximumVmFrames: 128, maximumVmControlFrames: 128, maximumObserverAttachments: 4, maximumNativeWireBytes: 128 * (65_536 + 4104),
    maximumObservationMetadataBytes: 16 * 1024, maximumObservationIndexBytes: 640 * 16 * 1024, maximumPhaseIndexBytes: 2 * 1024 ** 2,
    proxy: { maxActiveRequests: 16, maxRequestLifecycles: 16 }, networkTopology: { maximumNetworks: 8 } };
  const collector = createPhaseCollector({ evidence, budget, responseBytes: maxResponseBytes, requiredPhases: ['health'] });
  const capture = createConcurrencyCapture({ collector, budget, observerIds: new Map(), maxResponseBytes });
  return { directory, evidence, collector, capture };
}

// An Engine that sends chunked response headers and the given body chunks, then never finishes the body.
async function unfinishedEngine(t, directory, chunks, closeAfterMs) {
  const upstreamPath = join(directory, 'u.sock');
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n');
      for (const chunk of chunks) socket.write(Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from('\r\n')]));
      if (closeAfterMs !== undefined) setTimeout(() => socket.destroy(), closeAfterMs);
    });
  });
  server.listen(upstreamPath); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return upstreamPath;
}

function get(proxy, onResponse) {
  return new Promise((resolve) => {
    const request = http.request({ socketPath: proxy.endpoint.slice(7), method: 'GET', path: '/info', agent: false });
    request.on('error', () => {});
    request.once('response', (response) => {
      response.on('error', () => {});
      response.once('close', () => resolve({ complete: response.complete }));
      onResponse(request, response);
    });
    request.end();
  });
}

const traced = async (directory) => JSON.parse((await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim());

// Docker's chunked /info: headers and a body prefix, then the rest never arrives before the stated side closes.
for (const closedBy of ['client', 'engine', 'proxy']) test(`a GET whose ${closedBy} closes mid-body is ${closedBy === 'client' ? 'an unconsumed abandonment' : 'an incomplete original response'}`, { timeout: 5000 }, async (t) => {
  const { directory, evidence, collector, capture } = await setup(t);
  const prefix = Buffer.from('{"ID":"engine","SecurityOptions":["name=seccomp');
  const upstreamPath = await unfinishedEngine(t, directory, [prefix], closedBy === 'engine' ? 20 : undefined);
  const proxy = await createTraceProxy({ socketPath: join(directory, 'p.sock'), upstreamEndpoint: `unix://${upstreamPath}`,
    tracePath: join(directory, 'trace.jsonl'), observeRequest: capture.observeRequest, observeResponseBody: capture.observeResponseBody,
    observeRequestSettled: capture.observeRequestSettled });
  await collector.phase('health', { captureRequired: true });
  let closing;
  const received = await get(proxy, (request, response) => response.on('data', () => {
    // The SDK's stopHealth abort: response.destroy(); request.destroy() before the body completes.
    if (closedBy === 'client') { response.destroy(); request.destroy(); }
    // Proxy teardown destroys the client socket too, but the proxy cancelled first, so no client abandoned the read.
    if (closedBy === 'proxy') closing ??= proxy.close();
  }));
  assert.equal(received.complete, false);
  if (closedBy !== 'proxy') await proxy.idle();
  await proxy.close();
  const captured = await capture.close(), result = await collector.close(); await evidence.close();
  const record = await traced(directory);
  assert.equal(record.status, 200); assert.equal(record.upstreamBodyBytes, prefix.length); assert.equal(record.forwardedBodyBytes, prefix.length);
  if (closedBy !== 'proxy') assert.deepEqual(record.failure, { name: 'Error', message: 'aborted', code: 'ECONNRESET' });
  if (closedBy === 'client') {
    assert.deepEqual(result.failures, []);
    assert.equal(captured.completeness, 'complete'); assert.equal(captured.abandoned, 1); assert.equal(captured.incomplete, 0);
    assert.deepEqual(result.uncovered, [{ sequence: 1, name: 'health' }], 'An abandoned body is retained but never covers its phase.');
    assert.equal(result.observationIndex.incomplete, 0);
    assert.equal(record.terminal.downstreamAbandoned, true);
    const index = (await readFile(result.observationIndex.path, 'utf8')).trim().split('\n').map(JSON.parse);
    const body = index.find(({ kind }) => kind === 'engine'), terminal = index.find(({ kind }) => kind === 'engine-terminal');
    assert.equal(body.completeness, 'abandoned'); assert.deepEqual(await readFile(body.original.path), prefix);
    assert.equal(terminal.identity.outcome, 'response_abandoned');
  } else {
    assert.notEqual(record.failure, null);
    assert.equal(record.terminal.downstreamAbandoned, false);
    assert.equal(captured.completeness, 'incomplete');
    assert.match(result.failures[0].message, /Original Engine response incomplete: \/info/u);
  }
});

test('a client that closes while the proxy awaits drain abandons every byte the proxy handed its socket', { timeout: 5000 }, async (t) => {
  // The body must exceed the proxy server's 64 KiB write buffer and the socket buffers before any write is refused.
  const { directory, evidence, collector, capture } = await setup(t, 2 * 1024 ** 2);
  const chunks = Array.from({ length: 16 }, (_, index) => Buffer.alloc(65_536, 0x61 + index));
  const upstreamPath = await unfinishedEngine(t, directory, chunks);
  const proxy = await createTraceProxy({ socketPath: join(directory, 'p.sock'), upstreamEndpoint: `unix://${upstreamPath}`,
    tracePath: join(directory, 'trace.jsonl'), observeRequest: capture.observeRequest, observeResponseBody: capture.observeResponseBody,
    observeRequestSettled: capture.observeRequestSettled });
  await collector.phase('health', { captureRequired: true });
  const received = await get(proxy, (request, response) => {
    response.pause();
    setTimeout(() => { response.destroy(); request.destroy(); }, 200);
  });
  assert.equal(received.complete, false);
  await proxy.idle(); await proxy.close();
  const captured = await capture.close(), result = await collector.close(); await evidence.close();
  const record = await traced(directory);
  assert(record.upstreamBodyBytes > 0 && record.upstreamBodyBytes < 16 * 65_536, 'The proxy must stop reading upstream while it awaits drain.');
  assert.equal(record.forwardedBodyBytes, record.upstreamBodyBytes);
  assert.equal(record.terminal.downstreamAbandoned, true);
  assert.deepEqual(result.failures, []);
  assert.equal(captured.completeness, 'complete'); assert.equal(captured.abandoned, 1);
});

test('a client that closes on a fault-stalled response is not an attested abandonment', { timeout: 5000 }, async (t) => {
  const { directory, evidence, collector, capture } = await setup(t);
  const upstreamPath = await unfinishedEngine(t, directory, [Buffer.from('{"ID"')]);
  const proxy = await createTraceProxy({ socketPath: join(directory, 'p.sock'), upstreamEndpoint: `unix://${upstreamPath}`,
    tracePath: join(directory, 'trace.jsonl'), observeRequest: capture.observeRequest, observeResponseBody: capture.observeResponseBody,
    observeRequestSettled: capture.observeRequestSettled });
  await collector.phase('health', { captureRequired: true });
  const stalled = proxy.arm({ kind: 'stall', method: 'GET', target: '/info' });
  const received = await get(proxy, (request, response) => { void stalled.then(() => { response.destroy(); request.destroy(); }); });
  assert.equal(received.complete, false);
  await proxy.idle(); await proxy.close();
  const captured = await capture.close(), result = await collector.close(); await evidence.close();
  const record = await traced(directory);
  assert.equal(record.fault, 'stall'); assert.equal(record.terminal.downstreamAbandoned, true);
  assert.equal(captured.completeness, 'incomplete');
  assert.match(result.failures[0].message, /abandoned GET body lacks its proxy-attested client close/u);
});
