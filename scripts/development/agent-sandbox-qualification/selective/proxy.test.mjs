// ------------------------------------------------------------------------------------------------
//                proxy.test.mjs - Real Unix streaming forwarding, bounded pressure and wire faults
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  return { proxy, directory, server };
}

function request(endpoint, method, path) {
  const req = http.request({ socketPath: endpoint.slice(7), method, path, agent: false });
  const response = new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
  return { req, response };
}

test('opt-in admission waits for original body and terminal evidence before dispatching the next sequential content-length request', { timeout: 5000 }, async (t) => {
  const bodyEntered = Promise.withResolvers(), bodyRelease = Promise.withResolvers();
  const terminalEntered = Promise.withResolvers(), terminalRelease = Promise.withResolvers(), nextEntered = Promise.withResolvers();
  const forwarded = [];
  const upload = Buffer.from('exact queued request bytes\n'.repeat(4096)); let receivedUpload;
  const { proxy } = await setup(t, async (incoming, response) => {
    forwarded.push(incoming.url); const bytes = Buffer.from(incoming.url);
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    if (incoming.url === '/second') receivedUpload = Buffer.concat(chunks);
    response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes);
  }, { maxConnections: 4, maxActiveRequests: 1, maxPendingRequests: 2,
    observeRequest({ target }) { if (target === '/second') nextEntered.resolve(); },
    observeResponseBody({ target }) { return { body() {}, async complete() {
      if (target === '/first') { bodyEntered.resolve(); await bodyRelease.promise; }
    } }; },
    async observeRequestSettled(receipt) {
      if (JSON.parse(receipt.bytes).target === '/first') { terminalEntered.resolve(); await terminalRelease.promise; }
    },
  });
  const consume = async (path) => {
    const pending = request(proxy.endpoint, path === '/second' ? 'PUT' : 'GET', path);
    if (path === '/second') pending.req.setHeader('content-length', upload.length);
    pending.req.end(path === '/second' ? upload : undefined); const response = await pending.response;
    assert.equal(response.headers['content-length'], String(Buffer.byteLength(path)));
    const chunks = []; for await (const bytes of response) chunks.push(bytes);
    assert.equal(Buffer.concat(chunks).toString(), path);
  };
  let second;
  try {
    await consume('/first'); await bodyEntered.promise;
    second = consume('/second'); void second.catch(() => {});
    await Promise.race([nextEntered.promise, second]);
    assert.deepEqual(forwarded, ['/first']);
    bodyRelease.resolve(); await terminalEntered.promise;
    assert.deepEqual(forwarded, ['/first']);
    assert.equal(proxy.capacity().requests.current, 1); assert.equal(proxy.capacity().pendingRequests.current, 1);
    terminalRelease.resolve(); await second; await proxy.idle();
    assert.deepEqual(forwarded, ['/first', '/second']);
    assert.deepEqual(receivedUpload, upload);
    assert.equal(proxy.capacity().requests.rejected, 0); assert.equal(proxy.capacity().pendingRequests.promoted, 1);
  } finally { bodyRelease.resolve(); terminalRelease.resolve(); await Promise.allSettled([second]); }
});

test('queued cancellation retains its bounded slot through terminal evidence and never dispatches or retries the cancelled request', { timeout: 5000 }, async (t) => {
  const bodyEntered = Promise.withResolvers(), bodyRelease = Promise.withResolvers(), queued = Promise.withResolvers();
  const cancelled = Promise.withResolvers(), terminalRelease = Promise.withResolvers(), terminalReturned = Promise.withResolvers();
  const forwarded = [];
  const { proxy, directory } = await setup(t, (incoming, response) => {
    forwarded.push(incoming.url); response.writeHead(200, { 'content-length': incoming.url.length }); response.end(incoming.url);
  }, { maxConnections: 6, maxActiveRequests: 1, maxPendingRequests: 1,
    observeRequest({ target }) { if (target === '/cancelled') queued.resolve(); },
    observeResponseBody({ target }) { return { body() {}, async complete() {
      if (target === '/active') { bodyEntered.resolve(); await bodyRelease.promise; }
    } }; },
    async observeRequestSettled(receipt) {
      const record = JSON.parse(receipt.bytes);
      if (record.target === '/cancelled') { cancelled.resolve(record); await terminalRelease.promise; terminalReturned.resolve(); }
    },
  });
  const consume = async (pending) => { const chunks = []; for await (const bytes of await pending.response) chunks.push(bytes); return Buffer.concat(chunks).toString(); };
  try {
    const first = request(proxy.endpoint, 'GET', '/active'); first.req.end(); assert.equal(await consume(first), '/active'); await bodyEntered.promise;
    const second = request(proxy.endpoint, 'GET', '/cancelled'); void second.response.catch(() => {}); second.req.end(); await queued.promise;
    second.req.destroy(); await assert.rejects(second.response);
    const record = await cancelled.promise;
    assert.deepEqual(record.terminal, { kind: 'http_not_forwarded', upstreamAcquisition: 'not_entered', downstreamResponseClosed: true, reason: 'downstream_closed' });
    assert.equal(record.status, null); assert.equal(record.uploadedBytes, 0); assert.equal(record.upstreamBodyBytes, 0);
    assert.equal(record.waiting.releasedAt, undefined);
    assert.equal(proxy.capacity().pendingRequests.current, 1); assert.equal(proxy.capacity().pendingRequests.retiring, 1);
    const excess = request(proxy.endpoint, 'GET', '/queue-overflow'); excess.req.end();
    await assert.rejects(excess.response, (error) => ['ECONNRESET', 'EPIPE'].includes(error.code));
    assert.deepEqual(forwarded, ['/active']);
    terminalRelease.resolve(); await terminalReturned.promise; await new Promise(setImmediate);
    assert.equal(proxy.capacity().pendingRequests.current, 0);
    const next = request(proxy.endpoint, 'GET', '/after-cancellation'); next.req.end();
    assert.equal(proxy.capacity().requests.current, 1);
    bodyRelease.resolve(); assert.equal(await consume(next), '/after-cancellation'); await proxy.idle();
    assert.deepEqual(forwarded, ['/active', '/after-cancellation']);
    assert.equal(proxy.capacity().pendingRequests.highWater, 1); assert.equal(proxy.capacity().pendingRequests.cancelled, 1);
    assert.equal(proxy.capacity().requests.rejected, 1);
    const records = (await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(({ target, kind }) => target === '/cancelled' && kind !== 'admission_rejected').length, 1);
  } finally { bodyRelease.resolve(); terminalRelease.resolve(); }
});

test('proxy close joins active evidence and queued pre-dispatch retirement without acquiring upstream for the queued request', { timeout: 5000 }, async (t) => {
  const bodyEntered = Promise.withResolvers(), bodyRelease = Promise.withResolvers(), queued = Promise.withResolvers();
  const terminalEntered = Promise.withResolvers(), terminalRelease = Promise.withResolvers();
  let bodyReturned = false, terminalReturned = false;
  const forwarded = [];
  const { proxy } = await setup(t, (incoming, response) => {
    forwarded.push(incoming.url); response.writeHead(200, { 'content-length': 4 }); response.end('body');
  }, { maxConnections: 4, maxActiveRequests: 1, maxPendingRequests: 1,
    observeRequest({ target }) { if (target === '/queued') queued.resolve(); },
    observeResponseBody() { return { body() {}, async complete() { bodyEntered.resolve(); await bodyRelease.promise; bodyReturned = true; } }; },
    async observeRequestSettled(receipt) {
      const record = JSON.parse(receipt.bytes);
      if (record.target === '/queued') { terminalEntered.resolve(record); await terminalRelease.promise; terminalReturned = true; }
    },
  });
  let closing, timer;
  try {
    const first = request(proxy.endpoint, 'GET', '/active'); first.req.end();
    const response = await first.response; response.resume(); await once(response, 'end'); await bodyEntered.promise;
    const second = request(proxy.endpoint, 'GET', '/queued'); void second.response.catch(() => {}); second.req.end(); await queued.promise;
    closing = proxy.close(); const repeated = proxy.close();
    await assert.rejects(second.response);
    const terminal = await terminalEntered.promise;
    assert.deepEqual(terminal.terminal, { kind: 'http_not_forwarded', upstreamAcquisition: 'not_entered', downstreamResponseClosed: true, reason: 'proxy_closing' });
    assert.equal(await Promise.race([closing.then(() => 'closed'), new Promise((resolve) => { timer = setTimeout(() => resolve('owned'), 100); })]), 'owned');
    assert.equal(bodyReturned, false); assert.equal(terminalReturned, false);
    bodyRelease.resolve(); terminalRelease.resolve(); await Promise.all([closing, repeated]);
    assert.equal(bodyReturned, true); assert.equal(terminalReturned, true); assert.deepEqual(forwarded, ['/active']);
    assert.equal(proxy.capacity().requests.current, 0); assert.equal(proxy.capacity().pendingRequests.current, 0);
    assert.equal(proxy.capacity().pendingRequests.retiring, 0); assert.equal(proxy.capacity().connections.current, 0);
  } finally { clearTimeout(timer); bodyRelease.resolve(); terminalRelease.resolve(); await closing; }
});

test('a queued exec upgrade preserves fragmented control bytes, initial binary head and later duplex input', { timeout: 5000 }, async (t) => {
  const bodyEntered = Promise.withResolvers(), bodyRelease = Promise.withResolvers(), queued = Promise.withResolvers();
  const payload = Buffer.from('{"Detach":false,"Tty":false}'), input = Buffer.from([0, 255, 17, 3]);
  const frame = Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 65, 66]);
  let control, upgrades = 0, clientSocket;
  const { proxy, server } = await setup(t, (_request, response) => { response.writeHead(200, { 'content-length': 4 }); response.end('body'); }, {
    maxConnections: 4, maxActiveRequests: 1, maxPendingRequests: 1,
    observeRequest({ target }) { if (target === '/v1.52/exec/queued/start') queued.resolve(); },
    observeResponseBody() { return { body() {}, async complete() { bodyEntered.resolve(); await bodyRelease.promise; } }; },
  });
  server.on('upgrade', (_request, socket, head) => {
    upgrades++; socket.on('error', () => {}); socket.once('end', () => socket.destroy());
    let bytes = Buffer.from(head);
    const accept = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]); if (bytes.length < payload.length) return;
      control = bytes; socket.removeListener('data', accept);
      socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'); socket.write(frame);
      socket.once('data', (received) => socket.end(received));
    };
    socket.on('data', accept); accept(Buffer.alloc(0));
  });
  const client = http.request({ socketPath: proxy.endpoint.slice(7), method: 'POST', path: '/v1.52/exec/queued/start', agent: false,
    headers: { connection: 'Upgrade', upgrade: 'tcp', 'content-length': payload.length } });
  try {
    const first = request(proxy.endpoint, 'GET', '/active'); first.req.end();
    const response = await first.response; response.resume(); await once(response, 'end'); await bodyEntered.promise;
    const opening = once(client, 'upgrade'); client.write(payload.subarray(0, 3));
    await Promise.race([queued.promise, opening]); assert.equal(upgrades, 0);
    client.end(payload.subarray(3)); bodyRelease.resolve();
    const [, socket, head] = await opening; clientSocket = socket;
    const chunks = [head]; socket.on('data', (bytes) => chunks.push(bytes));
    const ended = once(socket, 'end'); socket.write(input); await ended; socket.destroy();
    await proxy.idle();
    assert.deepEqual(control, payload); assert.deepEqual(Buffer.concat(chunks), Buffer.concat([frame, input]));
    assert.equal(upgrades, 1); assert.equal(proxy.capacity().pendingRequests.promoted, 1);
  } finally { bodyRelease.resolve(); client.destroy(); clientSocket?.destroy(); }
});

test('invalid proxy capacities fail before acquiring trace files or a listener', async (t) => {
  const directory = await mkdtemp('/var/tmp/sandbox-proxy-capacity-');
  t.after(() => rm(directory, { recursive: true }));
  for (const [name, invalid, message] of [
    ['maxConnections', [0, 65, 1.5, Infinity], /capacity must be an integer from one through sixty-four/u],
    ['maxActiveRequests', [0, 65, 1.5, Infinity], /capacity must be an integer from one through sixty-four/u],
    ['maxPendingRequests', [-1, 65, 1.5, Infinity], /capacity must be an integer from zero through sixty-four/u],
  ]) for (const value of invalid) {
    await assert.rejects(createTraceProxy({ socketPath: join(directory, 'proxy.sock'), upstreamEndpoint: `unix://${join(directory, 'upstream.sock')}`,
      tracePath: join(directory, 'trace.jsonl'), [name]: value }), message);
  }
  assert.deepEqual(await readdir(directory), []);
});

for (const configured of [false, true]) test(`trace proxy ${configured ? 'explicit concurrency budget admits the paired workflow above sixteen' : 'default retains sixteen connections'} and records saturation before request parsing`, { timeout: 10_000 }, async (t) => {
  const limit = configured ? 32 : 16;
  const downstream = [], upstream = [], responses = [], received = [];
  const { proxy, directory, server } = await setup(t, (_request, response) => {
    responses.push(response); response.writeHead(200); response.write('entered');
  }, configured ? { maxConnections: 32, maxActiveRequests: 32 } : {});
  t.after(() => { for (const socket of [...downstream, ...upstream]) socket.destroy(); });
  server.on('upgrade', (_request, socket) => {
    upstream.push(socket); socket.on('error', () => {});
    socket.once('end', () => socket.destroy());
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.on('data', (bytes) => socket.write(bytes));
  });
  // Two members retain four helper controls and one primary each, plus two marker controls.
  for (let index = 0; index < 12; index += 1) {
    const client = http.request({ socketPath: proxy.endpoint.slice(7), method: 'POST', path: `/v1.52/containers/retained-${index}/attach?stream=true`,
      headers: { connection: 'Upgrade', upgrade: 'tcp' }, agent: false });
    const opening = once(client, 'upgrade'); client.end();
    const [, socket] = await opening; downstream.push(socket); socket.on('error', () => {});
  }
  for (let index = 12; index < limit; index += 1) {
    const pending = request(proxy.endpoint, 'GET', `/v1.52/containers/entered-${index}/json`); pending.req.end();
    const response = await pending.response; downstream.push(response.socket);
    received.push((async () => {
      const chunks = []; for await (const chunk of response) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), 'enteredexact response');
    })());
  }
  const excess = request(proxy.endpoint, 'GET', '/v1.52/containers/never-forwarded/json'); excess.req.end();
  await assert.rejects(excess.response, (error) => ['ECONNRESET', 'EPIPE'].includes(error.code));
  assert.equal(upstream.length, 12); assert.equal(responses.length, limit - 12);
  const message = Buffer.from('original retained control\n');
  const echoed = once(downstream[0], 'data'); downstream[0].write(message);
  assert.deepEqual((await echoed)[0], message, 'Saturation must preserve an already-admitted control stream.');
  for (const response of responses) response.end('exact response');
  for (const socket of downstream.slice(0, 12)) socket.destroy();
  await Promise.all(received);
  await proxy.idle();
  await proxy.close();
  assert.deepEqual(proxy.capacity(), {
    limits: { connections: limit, activeRequests: limit, pendingRequests: 0 },
    connections: { accepted: limit, rejected: 1, current: 0, highWater: limit },
    requests: { accepted: limit, rejected: 0, current: 0, highWater: limit },
    pendingRequests: { accepted: 0, promoted: 0, cancelled: 0, rejected: 0, current: 0, retiring: 0, highWater: 0 },
  });
  const trace = (await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const rejected = trace.filter(({ kind }) => kind === 'admission_rejected');
  assert.equal(rejected.length, 1); assert.equal(rejected[0].boundary, 'connection');
  assert.equal(rejected[0].admission.connections.rejected, 1);
  assert.equal(trace.filter(({ method }) => method === 'GET').length, limit - 12);
  assert.equal(trace.findLast(({ method }) => method)?.admission.connections.rejected, 1);
});

test('the active-request ceiling rejects a parsed request independently of socket admission and releases its capacity', async (t) => {
  let held;
  const forwarded = [];
  const { proxy, directory } = await setup(t, (incoming, response) => {
    forwarded.push(incoming.url);
    if (incoming.url.endsWith('/held')) { held = response; response.writeHead(200); response.write('entered'); }
    else { response.writeHead(204); response.end(); }
  }, { maxConnections: 3, maxActiveRequests: 1 });
  const first = request(proxy.endpoint, 'GET', '/v1.52/held'); first.req.end();
  const response = await first.response; response.resume();
  const rejected = request(proxy.endpoint, 'GET', '/v1.52/denied'); rejected.req.end();
  await assert.rejects(rejected.response, (error) => ['ECONNRESET', 'EPIPE'].includes(error.code));
  held.end(); await once(response, 'end'); await proxy.idle();
  const next = request(proxy.endpoint, 'GET', '/v1.52/after-release'); next.req.end();
  const completed = await next.response; completed.resume(); await once(completed, 'end');
  await proxy.idle(); await proxy.close();
  assert.deepEqual(forwarded, ['/v1.52/held', '/v1.52/after-release']);
  assert.deepEqual(proxy.capacity(), {
    limits: { connections: 3, activeRequests: 1, pendingRequests: 0 },
    connections: { accepted: 3, rejected: 0, current: 0, highWater: 2 },
    requests: { accepted: 2, rejected: 1, current: 0, highWater: 1 },
    pendingRequests: { accepted: 0, promoted: 0, cancelled: 0, rejected: 1, current: 0, retiring: 0, highWater: 0 },
  });
  const trace = (await readFile(join(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const denied = trace.find(({ kind }) => kind === 'admission_rejected');
  assert.equal(denied.boundary, 'request'); assert.equal(denied.target, '/v1.52/denied');
  assert.equal(denied.admission.requests.rejected, 1); assert.equal(denied.admission.connections.rejected, 0);
});

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

test('an observed upgrade forwards its retained tail before relaying upstream EOF', { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp('/var/tmp/sandbox-observed-tail-');
  const upstreamPath = join(directory, 'upstream.sock'); const tracePath = join(directory, 'trace.jsonl');
  const server = http.createServer(); const peers = new Set();
  const initial = Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 65, 66]);
  const stop = Buffer.from('{"kind":"stop","sequence":22}\n');
  const tail = Buffer.from([1, 0, 0, 0, 0, 0, 0, 3, 67, 68, 10]);
  // Native nn13r10s1: the route observer answers stop and exits, so its upstream EOF races the retained reply.
  server.on('upgrade', (_request, peer) => {
    peers.add(peer); peer.on('error', () => {});
    peer.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'); peer.write(initial);
    let input = Buffer.alloc(0);
    peer.on('data', (bytes) => { input = Buffer.concat([input, bytes]); if (input.equals(stop)) peer.end(tail); });
  });
  server.listen(upstreamPath); await once(server, 'listening');
  let connection; let upstreamClosedBeforeForward = false; const forwarded = Promise.withResolvers();
  const proxy = await createTraceProxy({ socketPath: join(directory, 'proxy.sock'), upstreamEndpoint: `unix://${upstreamPath}`, tracePath,
    observeUpgrade(value) {
      connection = value.connection;
      return { async input() {}, async response(bytes, forward) {
        if (!bytes.includes(67)) { await forward(bytes); return; }
        const deadline = Date.now() + 2000;
        while (!connection().upstream.destroyed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        upstreamClosedBeforeForward = connection().upstream.destroyed;
        try { await forward(bytes); forwarded.resolve('forwarded'); }
        catch (error) { forwarded.resolve(`${error.name}: ${error.cause?.message ?? error.message}`); throw error; }
      } };
    },
  });
  t.after(async () => { await proxy.close(); for (const peer of peers) peer.destroy(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const client = http.request({ socketPath: proxy.endpoint.slice(7), method: 'POST', path: '/v1.52/containers/exact-owned/attach?stream=true',
    headers: { connection: 'Upgrade', upgrade: 'tcp' }, agent: false });
  const opening = once(client, 'upgrade'); client.end();
  const [, socket, head] = await opening;
  const chunks = [head]; socket.on('data', (bytes) => chunks.push(bytes)); socket.on('error', () => {});
  const ended = once(socket, 'end'); const closed = once(socket, 'close');
  socket.write(stop);
  assert.equal(await forwarded.promise, 'forwarded');
  await Promise.race([ended, closed]);
  assert.equal(upstreamClosedBeforeForward, true);
  assert.equal(socket.readableEnded, true, 'The original reader must receive EOF after its tail, not a destroyed tunnel.');
  socket.destroy(); await proxy.idle();
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([initial, tail]));
  const records = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 1); assert.equal(records[0].status, 101); assert.equal(records[0].failure, null);
});

test('an observed duplex upgrade joins input released after its upstream peer closes', { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp('/var/tmp/sandbox-observed-retirement-');
  const upstreamPath = join(directory, 'upstream.sock'); const tracePath = join(directory, 'trace.jsonl');
  const server = http.createServer(); const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const returned = Promise.withResolvers(); let peer, socket, client, proxy, retirement;
  const input = Buffer.from('{"kind":"stop","sequence":24}\n');
  const initial = Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 65, 66]);
  let inputReturned = false; let receivedInput = Buffer.alloc(0); let connection;
  const bounded = async (promise, message, milliseconds = 2000) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const retire = () => {
    if (!retirement && proxy) { retirement = proxy.close(); void retirement.catch(() => {}); }
    return retirement;
  };
  const abort = () => { release.resolve(); socket?.destroy(); peer?.destroy(); client?.destroy(); };
  t.signal.addEventListener('abort', abort, { once: true });
  t.after(async () => {
    abort(); retire();
    // RED must release physical sockets/listeners even if the original forwarding join is stuck.
    await bounded(Promise.resolve(retirement).catch(() => {}), 'Original retirement remained pending during failed-test cleanup.', 100).catch(() => {});
    server.closeAllConnections();
    if (server.listening) await bounded(new Promise((resolve) => server.close(resolve)), 'Fixture listener did not close.');
    await rm(directory, { recursive: true, force: true });
    t.signal.removeEventListener('abort', abort);
  });
  server.on('upgrade', (_request, upgraded) => {
    peer = upgraded; peer.on('data', (bytes) => { receivedInput = Buffer.concat([receivedInput, bytes]); });
    peer.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'); peer.write(initial);
  });
  server.listen(upstreamPath); await bounded(once(server, 'listening'), 'Fixture listener did not start.');
  proxy = await createTraceProxy({ socketPath: join(directory, 'proxy.sock'), upstreamEndpoint: `unix://${upstreamPath}`, tracePath,
    observeUpgrade(value) {
      connection = value.connection;
      return { async input(bytes) {
        entered.resolve(Buffer.from(bytes)); await release.promise; inputReturned = true; returned.resolve();
      }, async response(bytes, forward) { await forward(bytes); } };
    },
  });
  client = http.request({ socketPath: proxy.endpoint.slice(7), method: 'POST', path: '/v1.52/containers/exact-owned/attach?stream=true',
    headers: { connection: 'Upgrade', upgrade: 'tcp' }, agent: false, signal: t.signal });
  const opening = once(client, 'upgrade'); client.end();
  const [, upgraded, head] = await bounded(opening, 'Observed attachment did not upgrade.'); socket = upgraded;
  const response = [head]; const initialReceived = Promise.withResolvers();
  const received = (bytes) => { response.push(bytes); if (Buffer.concat(response).length >= initial.length) initialReceived.resolve(); };
  socket.on('data', received); if (head.length >= initial.length) initialReceived.resolve();
  socket.on('error', () => {}); const clientClosed = new Promise((resolve) => socket.once('close', resolve));
  await bounded(initialReceived.promise, 'Original upstream binary bytes did not arrive before the fault.');
  socket.write(input); assert.deepEqual(await bounded(entered.promise, 'Original async input did not enter.'), input);
  const peerClosed = new Promise((resolve) => peer.once('close', resolve)); peer.destroy();
  await bounded(Promise.all([peerClosed, clientClosed]), 'Peer closure did not retire the physical duplex sockets.');
  assert.equal(inputReturned, false); assert.equal(connection().upstream.destroyed, true);
  assert.deepEqual(receivedInput, Buffer.alloc(0));
  assert.deepEqual(Buffer.concat(response), initial);
  release.resolve(); await bounded(returned.promise, 'Entered input callback did not return after its acknowledgement release.');
  await bounded(retire(), 'Original observed upgrade did not join after peer close and callback release.');
  const records = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 1); assert.equal(records[0].status, 101);
  assert.equal(records[0].target, '/v1.52/containers/exact-owned/attach?stream=true');
  assert.equal(typeof records[0].finishedAt, 'string'); assert.equal(inputReturned, true);
});

async function upgradeFixture(t, prefix, onUpgrade, options = {}) {
  const directory = await mkdtemp(`/var/tmp/${prefix}-`);
  const upstreamPath = join(directory, 'upstream.sock'); const tracePath = join(directory, 'trace.jsonl');
  const server = http.createServer(); const peers = new Set();
  server.on('upgrade', (_request, peer) => {
    peers.add(peer); peer.on('error', () => {});
    peer.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'); onUpgrade(peer);
  });
  server.listen(upstreamPath); await once(server, 'listening');
  const proxy = await createTraceProxy({ socketPath: join(directory, 'proxy.sock'), upstreamEndpoint: `unix://${upstreamPath}`, tracePath, ...options });
  t.after(async () => { await proxy.close(); for (const peer of peers) peer.destroy(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const client = http.request({ socketPath: proxy.endpoint.slice(7), method: 'POST', path: '/v1.52/containers/exact-owned/attach?stream=true',
    headers: { connection: 'Upgrade', upgrade: 'tcp' }, agent: false });
  const opening = once(client, 'upgrade'); client.end();
  const [, socket, head] = await opening; socket.on('error', () => {});
  const records = async () => { await proxy.idle(); return (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); };
  return { socket, head, proxy, records };
}

test('an upgraded stdin half-close preserves delayed output until upstream EOF', { timeout: 10_000 }, async (t) => {
  const initial = Buffer.from('initial output\n'), tail = Buffer.from('output after stdin EOF\n');
  const input = Buffer.from('complete stdin\n'), inputEnded = Promise.withResolvers();
  let received = Buffer.alloc(0), tailTimer;
  t.after(() => clearTimeout(tailTimer));
  const { socket, head, records } = await upgradeFixture(t, 'sandbox-input-half-close', (peer) => {
    peer.write(initial);
    peer.on('data', (bytes) => { received = Buffer.concat([received, bytes]); });
    peer.once('end', () => {
      inputEnded.resolve();
      tailTimer = setTimeout(() => peer.end(tail), 50);
    });
  });
  const chunks = [head]; socket.on('data', (bytes) => chunks.push(bytes));
  const ended = once(socket, 'end');
  socket.end(input);
  await Promise.all([inputEnded.promise, ended]);
  assert.deepEqual(received, input);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([initial, tail]));
  const [record] = await records();
  assert.equal(record.failure, null);
});

test('an observed upgrade keeps its received tail when late input meets Docker full close', { timeout: 10_000 }, async (t) => {
  const first = Buffer.alloc(1024, 1); const second = Buffer.alloc(1024, 2);
  const late = Buffer.from('{"kind":"heartbeat"}\n');
  const upstreamGone = Promise.withResolvers(); const lateObserved = Promise.withResolvers(); let connection;
  // Review of the MS007 tail fix: Docker writes its last frames and closes both directions while the observer still holds a frame.
  const { socket, head, records } = await upgradeFixture(t, 'sandbox-observed-late-input', (peer) => {
    peer.write(first); setTimeout(() => peer.end(second, () => { peer.destroy(); upstreamGone.resolve(); }), 50);
  }, { observeUpgrade: (value) => { connection = value.connection; return {
    async input(bytes) { if (bytes.equals(late)) lateObserved.resolve(); },
    async response(bytes, forward) {
      if (bytes[0] === 1) { await lateObserved.promise; await new Promise((resolve) => setTimeout(resolve, 200)); }
      await forward(bytes);
    },
  }; } });
  const chunks = [head]; socket.on('data', (bytes) => chunks.push(bytes));
  const ended = once(socket, 'end');
  await upstreamGone.promise;
  for (const deadline = Date.now() + 1000; !connection().upstream.readableEnded && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 5));
  socket.write(late);
  await ended; socket.destroy();
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, second]));
  const [record] = await records();
  assert.equal(record.failure, null); assert.equal(record.droppedInputBytes, late.length);
});

test('an unobserved upgrade flushes its whole stream to a slow reader after upstream EOF', { timeout: 20_000 }, async (t) => {
  const body = Buffer.alloc(4 * 1024 * 1024); for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
  const { socket, head, records } = await upgradeFixture(t, 'sandbox-unobserved-slow-reader', (peer) => { peer.end(body); });
  const chunks = [head];
  socket.on('data', (bytes) => { chunks.push(bytes); socket.pause(); setTimeout(() => socket.resume(), 1); });
  await once(socket, 'end'); socket.destroy();
  assert.equal(Buffer.concat(chunks).length, body.length);
  assert(Buffer.concat(chunks).equals(body));
  const [record] = await records();
  assert.equal(record.failure, null);
});

test('an unobserved upgrade whose client closes during backpressure is cancelled, not failed', { timeout: 10_000 }, async (t) => {
  const { socket, records } = await upgradeFixture(t, 'sandbox-unobserved-backpressure-close', (peer) => { peer.write(Buffer.alloc(4 * 1024 * 1024, 3)); });
  socket.pause();
  await new Promise((resolve) => setTimeout(resolve, 200));
  socket.destroy();
  const [record] = await records();
  assert.equal(record.failure, null);
});

test('an unobserved upgrade drains late input after Docker full close until its half-open client closes', { timeout: 10_000 }, async (t) => {
  const body = Buffer.from('exited\n'); const late = Buffer.alloc(64 * 1024, 7);
  const { socket, head, records } = await upgradeFixture(t, 'sandbox-unobserved-late-input', (peer) => { peer.end(body, () => peer.destroy()); });
  socket.allowHalfOpen = true;
  const chunks = [head]; socket.on('data', (bytes) => chunks.push(bytes));
  const closed = once(socket, 'close');
  await once(socket, 'end');
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.end(late);
  await closed;
  assert.deepEqual(Buffer.concat(chunks), body);
  const [record] = await records();
  assert.equal(record.failure, null); assert.equal(record.droppedInputBytes, late.length);
});

test('an unobserved upgrade keeps its tail for a slow reader when late input meets Docker full close', { timeout: 10_000 }, async (t) => {
  // Review of the r15 relay: late input written against Docker's full close failed while the slow reader's tail was still
  // unread upstream, and the client lost that tail without a recorded failure.
  const body = Buffer.alloc(512 * 1024); for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
  const late = Buffer.alloc(1024, 7); const upstreamGone = Promise.withResolvers();
  const { socket, head, records } = await upgradeFixture(t, 'sandbox-unobserved-slow-late-input', (peer) => {
    peer.end(body, () => { peer.destroy(); upstreamGone.resolve(); });
  });
  const chunks = [head];
  socket.on('data', (bytes) => { chunks.push(bytes); socket.pause(); setTimeout(() => socket.resume(), 20); });
  const ended = once(socket, 'end');
  await upstreamGone.promise; await new Promise((resolve) => setTimeout(resolve, 50));
  socket.write(late);
  await ended; socket.destroy();
  assert(Buffer.concat(chunks).equals(body));
  const [record] = await records();
  assert.equal(record.failure, null); assert.equal(record.droppedInputBytes, late.length);
});

test('an observed upgrade records an input observer failure after its response completed', { timeout: 10_000 }, async (t) => {
  const responded = Promise.withResolvers();
  const { socket, records } = await upgradeFixture(t, 'sandbox-observed-input-failure', (peer) => { peer.end(); }, {
    observeUpgrade: () => ({
      async input() { await responded.promise; throw new Error('Observed attach input exceeded its fixture bound.'); },
      async response(bytes, forward) { await forward(bytes); },
    }),
  });
  socket.on('data', () => {}); const closed = once(socket, 'close');
  socket.write(Buffer.from('{"kind":"stop"}\n')); socket.once('end', () => responded.resolve());
  await closed;
  const [record] = await records();
  assert.deepEqual(record.failure, { name: 'Error', message: 'Observed attach input exceeded its fixture bound.' });
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
