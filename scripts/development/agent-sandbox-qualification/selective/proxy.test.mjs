// ------------------------------------------------------------------------------------------------
//                proxy.test.mjs - Real Unix streaming forwarding, bounded pressure and wire faults
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createTraceProxy } from './proxy/index.mjs';

async function setup(t, handle, options = {}) {
  const directory = await mkdtemp('/var/tmp/sandbox-selected-proxy-');
  const upstreamPath = join(directory, 'upstream.sock');
  const server = http.createServer(handle);
  server.listen(upstreamPath);
  await once(server, 'listening');
  const proxy = await createTraceProxy({ socketPath: join(directory, 'proxy.sock'), upstreamEndpoint: `unix://${upstreamPath}`,
    tracePath: join(directory, 'trace.jsonl'), ...options });
  t.after(async () => { await proxy.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); });
  return { proxy, directory };
}

function request(endpoint, method, path) {
  const req = http.request({ socketPath: endpoint.slice(7), method, path, agent: false });
  const response = new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
  return { req, response };
}

test('trace proxy forwards chunked uploads and HEAD without changing archive bytes or inventing a HEAD body', async (t) => {
  const data = Buffer.alloc(64 * 1024, 37);
  let uploaded;
  const { proxy } = await setup(t, async (req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { 'x-docker-container-path-stat': 'exact-stat', 'content-length': '999999' }); res.end(); return; }
    assert.equal(req.headers['transfer-encoding'], 'chunked');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of req) { hash.update(chunk); bytes += chunk.length; }
    uploaded = { bytes, sha256: hash.digest('hex') };
    res.writeHead(200); res.end();
  });
  proxy.setRow('upload');
  const upload = request(proxy.endpoint, 'PUT', '/v1.52/containers/owned/archive?path=%2Fworkspace');
  const expected = createHash('sha256');
  for (let index = 0; index < 20; index += 1) { expected.update(data); if (!upload.req.write(data)) await once(upload.req, 'drain'); }
  upload.req.end();
  for await (const chunk of await upload.response) assert.equal(chunk.length, 0);
  assert.deepEqual(uploaded, { bytes: 20 * data.length, sha256: expected.digest('hex') });
  proxy.setRow('head');
  const head = request(proxy.endpoint, 'HEAD', '/v1.52/containers/owned/archive?path=%2Fworkspace%2Fwork');
  head.req.end();
  const response = await head.response;
  assert.equal(response.headers['x-docker-container-path-stat'], 'exact-stat');
  let body = 0;
  for await (const chunk of response) body += chunk.length;
  assert.equal(body, 0);
  await proxy.idle();
  assert.equal(proxy.summary('head').archiveHeads, 1);
});

test('slow selected-archive reader prevents the proxy from draining a whole upstream payload into memory', async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 81);
  const total = 256 * chunk.length;
  let produced = 0;
  const { proxy } = await setup(t, async (_req, res) => {
    for (let index = 0; index < 256; index += 1) {
      produced += chunk.length;
      if (!res.write(chunk)) await once(res, 'drain');
    }
    res.end();
  });
  proxy.setRow('selected');
  const download = request(proxy.endpoint, 'GET', '/v1.52/containers/owned/archive?path=%2Fworkspace%2Fwork%2Fartifact.bin');
  download.req.end();
  const response = await download.response;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(produced < total, 'A paused downstream must apply upstream pressure before the entire body is drained.');
  const hash = createHash('sha256');
  let received = 0;
  for await (const bytes of response) { received += bytes.length; hash.update(bytes); }
  const expected = createHash('sha256');
  for (let index = 0; index < 256; index += 1) expected.update(chunk);
  assert.equal(received, total);
  assert.equal(hash.digest('hex'), expected.digest('hex'));
  await proxy.idle();
  assert.equal(proxy.summary('selected').archiveBytes, BigInt(total));
  assert.equal(proxy.summary('selected').rootArchiveGets, 0);
});

test('narrow faults append a genuine late body byte and lose only an exact cleanup acknowledgement', async (t) => {
  let removed = false;
  const { proxy } = await setup(t, (_req, res) => { if (_req.method === 'DELETE') { removed = true; res.writeHead(204); res.end(); }
    else { res.writeHead(200, { 'content-length': 3 }); res.end(Buffer.from([7, 8, 9])); } });
  const target = '/v1.52/containers/owned/archive?path=%2Fworkspace%2Fwork%2Fartifact.bin';
  proxy.setRow('late'); proxy.arm({ method: 'GET', target, kind: 'late-trailer' });
  const download = request(proxy.endpoint, 'GET', target); download.req.end();
  const chunks = [];
  for await (const chunk of await download.response) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([7, 8, 9, 1]));
  proxy.setRow('cleanup'); proxy.arm({ method: 'DELETE', target: '/v1.52/containers/exact-owned?force=true', kind: 'drop-response' });
  const cleanup = request(proxy.endpoint, 'DELETE', '/v1.52/containers/exact-owned?force=true'); cleanup.req.end();
  await assert.rejects(cleanup.response, /socket hang up/u);
  assert.equal(removed, true);
  await proxy.idle();
  assert.equal(proxy.summary('late').archiveBytes, 4n);
  assert.equal(proxy.summary('cleanup').requests, 1);
});

test('Docker attach upgrade preserves initial binary head and bidirectional stream bytes', async (t) => {
  const directory = await mkdtemp('/var/tmp/sandbox-selected-upgrade-');
  const upstreamPath = join(directory, 'upstream.sock');
  const server = http.createServer();
  const initial = Buffer.from([1, 0, 0, 0, 0, 0, 0, 3, 0, 255, 17]);
  const input = Buffer.from([9, 8, 0, 255]);
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.write(initial);
    socket.once('data', (bytes) => { assert.deepEqual(bytes, input); socket.end(bytes); });
  });
  server.listen(upstreamPath); await once(server, 'listening');
  const proxy = await createTraceProxy({ socketPath: join(directory, 'proxy.sock'), upstreamEndpoint: `unix://${upstreamPath}`, tracePath: join(directory, 'trace.jsonl') });
  t.after(async () => { await proxy.close(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); });
  const client = http.request({ socketPath: proxy.endpoint.slice(7), method: 'POST', path: '/v1.52/containers/owned/attach?stream=true',
    headers: { connection: 'Upgrade', upgrade: 'tcp' }, agent: false });
  const opening = once(client, 'upgrade'); client.end();
  const [, socket, head] = await opening;
  const chunks = [head]; socket.on('data', (bytes) => chunks.push(bytes));
  socket.write(input);
  await once(socket, 'end'); socket.destroy();
  await proxy.idle();
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([initial, input]));
});

test('Docker exec-start upgrade forwards its fragmented declared JSON body before waiting for upgrade acknowledgement', async (t) => {
  const directory = await mkdtemp('/var/tmp/sandbox-selected-exec-');
  const upstreamPath = join(directory, 'upstream.sock');
  const payload = Buffer.from('{"Detach":false,"Tty":false}');
  const frame = Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 65, 66]);
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    assert.equal(req.headers['content-length'], String(payload.length));
    let body = Buffer.from(head);
    const accept = (bytes) => {
      body = Buffer.concat([body, bytes]);
      if (body.length < payload.length) return;
      assert.deepEqual(body, payload); socket.removeListener('data', accept);
      socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'); socket.end(frame);
    };
    socket.on('data', accept); accept(Buffer.alloc(0));
  });
  server.listen(upstreamPath); await once(server, 'listening');
  const proxy = await createTraceProxy({ socketPath: join(directory, 'proxy.sock'), upstreamEndpoint: `unix://${upstreamPath}`, tracePath: join(directory, 'trace.jsonl') });
  t.after(async () => { await proxy.close(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); });
  const client = http.request({ socketPath: proxy.endpoint.slice(7), method: 'POST', path: '/v1.52/exec/owned/start',
    headers: { connection: 'Upgrade', upgrade: 'tcp', 'content-type': 'application/json', 'content-length': payload.length }, agent: false });
  const timeout = setTimeout(() => client.destroy(new Error('Declared upgrade request body was not forwarded.')), 500);
  let socket;
  try {
    const opening = once(client, 'upgrade'); client.write(payload.subarray(0, 3));
    setTimeout(() => client.end(payload.subarray(3)), 5);
    const [, upgraded, head] = await opening; socket = upgraded;
    const chunks = [head]; socket.on('data', (bytes) => chunks.push(bytes));
    await once(socket, 'end'); socket.destroy();
    assert.deepEqual(Buffer.concat(chunks), frame);
    await proxy.idle();
  } finally { clearTimeout(timeout); client.destroy(); socket?.destroy(); }
});

async function refusedUpgrade(t, chunked, keepOpen = false) {
  const directory = await mkdtemp('/var/tmp/sandbox-refused-upgrade-');
  const upstreamPath = join(directory, 'upstream.sock');
  const payload = Buffer.from('{"Detach":false,"Tty":false}');
  const body = Buffer.from([123, 34, 101, 114, 114, 111, 114, 34, 58, 34, 0, 255, 34, 125]);
  const server = http.createServer();
  const peers = new Set();
  server.on('upgrade', (_request, socket, head) => {
    peers.add(socket); socket.once('close', () => peers.delete(socket));
    let received = Buffer.from(head);
    const accept = (bytes) => {
      received = Buffer.concat([received, bytes]);
      if (received.length < payload.length) return;
      assert.deepEqual(received, payload);
      socket.removeListener('data', accept);
      const framing = chunked ? 'Transfer-Encoding: chunked\r\nTrailer: X-Engine-Reason' : `Content-Length: ${body.length}`;
      const wireBody = chunked ? Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`), body,
        Buffer.from('\r\n0\r\nX-Engine-Reason: removed\r\n\r\n')]) : body;
      const response = Buffer.concat([Buffer.from(`HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n${framing}\r\n${keepOpen ? '' : 'Connection: close\r\n'}\r\n`), wireBody]);
      if (keepOpen) socket.write(response);
      else socket.end(response);
    };
    socket.on('data', accept); accept(Buffer.alloc(0));
  });
  server.listen(upstreamPath); await once(server, 'listening');
  const proxy = await createTraceProxy({ socketPath: join(directory, 'proxy.sock'), upstreamEndpoint: `unix://${upstreamPath}`,
    tracePath: join(directory, 'trace.jsonl') });
  t.after(async () => { await proxy.close(); for (const peer of peers) peer.destroy(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true }); });
  return { proxy, directory, payload, body };
}

for (const chunked of [false, true]) test(`an Engine refusal of an exec upgrade preserves its ordinary HTTP status and exact ${chunked ? 'chunked' : 'declared-length'} binary body`, async (t) => {
  const { proxy, directory, payload, body } = await refusedUpgrade(t, chunked);
  const client = http.request({ socketPath: proxy.endpoint.slice(7), method: 'POST', path: '/v1.52/exec/removed/start',
    headers: { connection: 'Upgrade', upgrade: 'tcp', 'content-type': 'application/json', 'content-length': payload.length }, agent: false });
  const response = new Promise((resolve, reject) => { client.once('response', resolve); client.once('error', reject); });
  client.end(payload);
  const result = await response;
  assert.equal(result.statusCode, 404);
  assert.equal(result.headers['content-type'], 'application/json');
  const received = [];
  for await (const chunk of result) received.push(chunk);
  assert.deepEqual(Buffer.concat(received), body);
  if (chunked) {
    assert.equal(result.headers['transfer-encoding'], 'chunked');
    assert.equal(result.trailers['x-engine-reason'], 'removed');
  } else assert.equal(result.headers['content-length'], String(body.length));
  await proxy.idle();
  const trace = JSON.parse((await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim());
  assert.equal(trace.status, 404);
  assert.equal(trace.uploadedBytes, payload.length);
  assert.equal(trace.upstreamBodyBytes, body.length);
  assert.equal(trace.forwardedBodyBytes, body.length);
  assert.equal(trace.failure, null);
});

test('a raw held-upgrade client receives HTTP refusal EOF and releases both socket directions without closing first', async (t) => {
  const { proxy, directory, payload, body } = await refusedUpgrade(t, false, true);
  const client = createConnection({ path: proxy.endpoint.slice(7), allowHalfOpen: true });
  const chunks = [];
  let idleTimer;
  client.on('data', (chunk) => chunks.push(chunk));
  const ended = once(client, 'end', { signal: AbortSignal.timeout(1000) });
  const closed = once(client, 'close');
  try {
    await once(client, 'connect');
    client.write(Buffer.concat([Buffer.from(`POST /v1.52/exec/removed/start HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${payload.length}\r\n\r\n`), payload]));
    await ended;
    const received = Buffer.concat(chunks);
    const headerEnd = received.indexOf('\r\n\r\n');
    assert.match(received.subarray(0, headerEnd).toString('latin1'), /^HTTP\/1\.1 404 Not Found\r\n/u);
    assert.deepEqual(received.subarray(headerEnd + 4), body);
    client.end();
    await closed;
    await Promise.race([proxy.idle(), new Promise((_, reject) => {
      idleTimer = setTimeout(() => reject(new Error('HTTP refusal sockets did not retire after their complete response and both FINs.')), 1000);
      idleTimer.unref();
    })]);
    const record = JSON.parse((await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim());
    assert.equal(record.status, 404);
    assert.equal(record.forwardedBodyBytes, body.length);
    assert.equal(record.failure, null);
  } catch (error) {
    t.diagnostic(JSON.stringify({ client: { readableEnded: client.readableEnded, writableEnded: client.writableEnded,
      writableFinished: client.writableFinished, destroyed: client.destroyed },
    receivedBytes: Buffer.concat(chunks).length, received: Buffer.concat(chunks).toString('latin1'), traceSummary: proxy.summary('setup') },
    (_key, value) => typeof value === 'bigint' ? value.toString() : value));
    throw error;
  } finally { clearTimeout(idleTimer); client.destroy(); await closed; }
});

test('a rejecting independent response observer retains the entered upstream effect and withholds its acknowledgement', async (t) => {
  const primary = new Error('Kernel capture deliberately rejected the entered start.');
  let entered = false;
  let observed;
  const { proxy, directory } = await setup(t, (_request, response) => { entered = true; response.writeHead(204); response.end(); }, {
    async observeResponse(value) { observed = value; throw primary; },
  });
  const operation = request(proxy.endpoint, 'POST', '/v1.52/containers/exact-started/start'); operation.req.end();
  await assert.rejects(operation.response, /socket hang up/u);
  await proxy.idle();
  assert.equal(entered, true);
  assert.deepEqual(observed, { method: 'POST', target: '/v1.52/containers/exact-started/start', status: 204 });
  const trace = JSON.parse((await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim());
  assert.equal(trace.status, 204); assert.equal(trace.forwardedBodyBytes, 0);
  assert.equal(trace.failure.message, primary.message);
});
