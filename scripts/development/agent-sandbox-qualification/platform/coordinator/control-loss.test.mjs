import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Evidence } from './evidence.mjs';
import { captureRetainedFence, installControlLoss } from './control-loss.mjs';

test('control loss captures the exact original upgrade without another reader and destroys only the selected member socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-cl-')); const socketPath = join(directory, 'e.sock');
  const evidence = new Evidence(join(directory, 'out')); await evidence.initialize(Buffer.from('{}'));
  const serverSockets = []; const clients = [];
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    serverSockets.push(socket); socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\noriginal-head');
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const resource = { role: 'route_observer', name: 'original-b-observer', identity: { kind: 'identified', id: 'b'.repeat(64), fingerprint: 'original' } };
  const member = { label: 'b', owner: { recoveryRecord: { resources: [resource] } } };
  const captured = installControlLoss({ socketPath, member: () => member, role: 'route_observer', evidence });
  const upgrade = (id) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: 'POST', path: `/v1.52/containers/${id}/attach?stream=1&stdin=1`,
      headers: { connection: 'Upgrade', upgrade: 'tcp' } });
    request.once('error', reject); request.once('upgrade', (_response, socket, head) => {
      socket.on('error', () => {}); clients.push(socket); resolve({ socket, head });
    }); request.end();
  });
  try {
    const a = await upgrade('a'.repeat(64)); const b = await upgrade(resource.identity.id);
    assert.equal(a.socket.listenerCount('data'), 0); assert.equal(b.socket.listenerCount('data'), 0);
    assert.equal(captured.report.captured.resource.identity.id, resource.identity.id);
    assert.deepEqual(b.head, Buffer.from('original-head'));
    const closed = new Promise((resolve) => b.socket.once('close', resolve));
    await captured.inject(); await closed;
    assert.equal(a.socket.destroyed, false); assert.equal(b.socket.destroyed, true);
    assert.equal(a.socket.listenerCount('data'), 0); assert.equal(b.socket.listenerCount('data'), 0);
    const result = await captured.close(); assert.equal(result.injected.resource.identity.id, resource.identity.id);
    assert.equal(result.failures.length, 0); assert.equal(typeof result.closedAt, 'string');
    assert.match(result.socketError.failure.message, /exact original member control socket/u);
    assert(result.injected.at <= result.socketError.at && result.socketError.at <= result.closedAt);
    assert.equal(result.closeHadError, true);
    assert.deepEqual(await readFile(result.captured.head.path), b.head);
    await assert.rejects(captured.inject());
  } finally {
    await captured.close(); for (const socket of [...clients, ...serverSockets]) socket.destroy();
    await evidence.close(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true });
  }
});

test('retained-fence observation preserves the original public error chain and cannot activate a healthy or closed owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-ce-')); const evidence = new Evidence(join(directory, 'out'));
  await evidence.initialize(Buffer.from('{}'));
  let activations = 0;
  const state = { kind: 'fenced', failure: { kind: 'authority_lost', source: 'control' } };
  const coordinator = { state, async activate() { activations++; throw original; } };
  const original = new Error('Original coordinator authority lost.', { cause: new Error('Original producer membership disappeared.') });
  original.owner = coordinator; original.failure = state.failure;
  try {
    const observed = await captureRetainedFence(coordinator, evidence);
    assert.equal(activations, 1); assert.equal(observed.captureFailure, null);
    assert.equal(observed.retainedError.cause.message, 'Original producer membership disappeared.');
    const retained = JSON.parse(await readFile(observed.evidence.path, 'utf8'));
    assert.equal(retained.retainedError.message, original.message); assert.equal(retained.retainedError.cause.message, original.cause.message);
    for (const kind of ['active', 'closed', 'recovering', 'inert']) {
      coordinator.state = { kind };
      await assert.rejects(captureRetainedFence(coordinator, evidence), /already fenced/u);
    }
    assert.equal(activations, 1);
  } finally { await evidence.close(); await rm(directory, { recursive: true }); }
});
