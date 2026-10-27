import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createTraceProxy } from '../../../selective/proxy/index.mjs';
import { until } from '../../../engine.mjs';
import { createRouteObserverCapture } from './observer-capture.mjs';

const protocol = 'agenai.sandbox.desktop-route-observer.v1';
const image = `sha256:${'b'.repeat(64)}`, workloadImage = `sha256:${'c'.repeat(64)}`;
const namespace = 'platform-net-12345678-case', operationId = '12345678-1234-4123-8123-123456789abc';
const configuration = { protocol, heartbeatMs: 1000, leaseTimeoutMs: 60000, commandTimeoutMs: 5000, maxOutputBytes: 4194304 };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const line = (value) => Buffer.from(JSON.stringify(value) + '\n');
function multiplex(payload) { const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(payload.length, 4); return Buffer.concat([header, payload]); }
function inspection(id, role = 'route_observer') {
  return { Id: id, Image: image, Config: { Image: image, User: '1000:1000',
    Env: [`AGENAI_DESKTOP_ROUTE_CONFIG=${JSON.stringify(configuration)}`], Labels: {
      'ai.agen.sandbox.role': role, 'ai.agen.sandbox.backend': 'agenai-docker',
      'ai.agen.sandbox.revision': 'engine-1.52-v6-desktop-apple-virtualization-native-arm64',
      'ai.agen.sandbox.image': workloadImage, 'ai.agen.sandbox.namespace': namespace, 'ai.agen.sandbox.operation': operationId } } };
}
const scope = (id) => ({ computeId: id, role: 'route_observer', namespace, operationId, imageDigest: image, keeperPid: 42 });
async function fixture(t, getInspection) {
  const root = await mkdtemp(join(tmpdir(), 'rc-')); const sockets = new Set(); const peers = new Map(); const requests = [];
  const upstream = http.createServer(async (request, response) => {
    requests.push(request.url); const id = /^\/v1\.52\/containers\/([a-f0-9]{64})\/json$/u.exec(request.url)?.[1];
    assert(id); response.end(JSON.stringify(await getInspection(id)));
  });
  upstream.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  upstream.on('upgrade', (request, socket) => {
    const id = /^\/v1\.52\/containers\/([a-f0-9]{64})\/attach\?/u.exec(request.url)[1];
    const peer = { socket, input: Buffer.alloc(0) }; peers.set(id, peer);
    socket.on('data', (chunk) => { peer.input = Buffer.concat([peer.input, chunk]); });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  });
  const upstreamPath = join(root, 'u'); await new Promise((resolve) => upstream.listen(upstreamPath, resolve));
  const capture = await createRouteObserverCapture({ directory: join(root, 'capture'), endpoint: `unix://${upstreamPath}`,
    profile: 'desktop-apple-virtualization-native-arm64', namespacePrefix: 'platform-net-12345678-', workloadImage,
    observerImage: image, observerUser: { uid: 1000, gid: 1000 }, configuration, requestMs: 5000,
    source: { path: '/qualification/observer-capture.mjs', sha256: 'd'.repeat(64) } });
  const proxy = await createTraceProxy({ socketPath: join(root, 'p'), upstreamEndpoint: `unix://${upstreamPath}`,
    tracePath: join(root, 'trace.jsonl'), observeUpgrade: capture.observeUpgrade });
  t.after(async () => { await proxy.close(); for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const attach = (id) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath: join(root, 'p'), method: 'POST',
      path: `/v1.52/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`, headers: { Connection: 'Upgrade', Upgrade: 'tcp' } });
    request.once('error', reject); request.once('upgrade', (_response, socket, head) => {
      const client = { socket, bytes: Buffer.from(head) }; socket.on('data', (chunk) => { client.bytes = Buffer.concat([client.bytes, chunk]); });
      socket.on('error', reject); resolve(client);
    }); request.end();
  });
  const send = async (id, client, chunks) => {
    for (const chunk of chunks) { const expected = client.bytes.length + chunk.length; peers.get(id).socket.write(chunk);
      await until(() => client.bytes.length >= expected, 5000, 'Original proxy bytes did not arrive.'); }
  };
  return { capture, proxy, peers, requests, attach, send };
}

test('passive capture retains split native observation bytes and forwards every original byte through a capture failure', async (t) => {
  const original = 'a'.repeat(64), unrelated = 'e'.repeat(64), broken = 'f'.repeat(64);
  const context = await fixture(t, (id) => inspection(id, id === unrelated ? 'compute' : 'route_observer'));
  const client = await context.attach(original);
  const command = line({ protocol, kind: 'observe', sequence: 7 });
  client.socket.write(command.subarray(0, 3)); client.socket.write(command.subarray(3));
  await until(() => context.peers.get(original).input.length === command.length, 5000, 'Original input was not forwarded.');
  assert.deepEqual(context.peers.get(original).input, command);
  const first = line({ protocol, kind: 'observation', sequence: 7, document: { opaque: 'native-é\u0000data' } });
  const second = line({ protocol, kind: 'observation', sequence: 9, document: { unparsed: [1, 2] } });
  const wire = Buffer.concat([multiplex(Buffer.concat([line({ protocol, kind: 'ready' }),
    line({ protocol, kind: 'heartbeat', sequence: 1 }), first, second.subarray(0, 17)])), multiplex(second.subarray(17))]);
  await context.send(original, client, [wire.subarray(0, 2), wire.subarray(2, 7), wire.subarray(7, 25), wire.subarray(25)]);
  assert.deepEqual(client.bytes, wire); client.socket.destroy();
  const other = await context.attach(unrelated); const opaque = Buffer.from([255, 0, 2, 3, 4, 5]);
  await context.send(unrelated, other, [opaque]); assert.deepEqual(other.bytes, opaque); other.socket.destroy();
  const invalid = await context.attach(broken); const invalidWire = multiplex(Buffer.from('{broken\n'));
  await context.send(broken, invalid, [invalidWire]); assert.deepEqual(invalid.bytes, invalidWire); invalid.socket.destroy();
  await context.proxy.close(); const receipt = await context.capture.close([scope(original), scope(broken)]);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.joined, true); assert.equal(receipt.observationFiles, 2); assert.equal(receipt.filesClosed, 2);
  assert.deepEqual(await context.capture.close([]), receipt);
  const bytes = await readFile(receipt.indexPath); assert.equal(receipt.sha256, sha(bytes));
  const index = JSON.parse(bytes); assert.equal(index.ignoredAttachments, 1); assert.equal(index.attachments.length, 2);
  const captured = index.attachments.find(({ containerId }) => containerId === original);
  assert.equal(captured.control[0].sequence, 7); assert.equal(captured.control[0].sha256, sha(command));
  assert.deepEqual(captured.observations.map(({ sequence }) => sequence), [7, 9]);
  for (const [position, expected] of [first, second].entries()) {
    const retained = captured.observations[position]; assert.deepEqual(await readFile(retained.path), expected);
    assert.equal(retained.bytes, expected.length); assert.equal(retained.sha256, sha(expected)); assert.equal(retained.state, 'closed');
  }
  assert.equal(index.failures.length, 1); assert.equal(index.failures[0].stage, 'observation-prefix');
  assert.equal(index.failures[0].containerId, broken);
  assert.equal(context.requests.filter((path) => path.endsWith('/json')).length, 3);
});

test('capture close joins its original identity read even when the attachment produces no response bytes', async (t) => {
  const id = 'a'.repeat(64), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const context = await fixture(t, async (actual) => { entered.resolve(); await release.promise; return inspection(actual); });
  const client = await context.attach(id); await entered.promise; client.socket.destroy(); await context.proxy.close();
  let settled = false; const closing = context.capture.close([scope(id)]).then((receipt) => { settled = true; return receipt; });
  await setImmediate(); assert.equal(settled, false); release.resolve(); const receipt = await closing;
  assert.equal(receipt.status, 'captured'); assert.equal(receipt.joined, true); assert.equal(receipt.observers, 1);
  assert.equal(receipt.observationFiles, 0); assert.equal(receipt.filesClosed, 0);
  assert.equal(context.requests.length, 1);
});
