// ------------------------------------------------------------------------------------------------
//                network-control.test.ts - Actual framed helper leases, readiness and shutdown settlement
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createConnection, createServer, type Socket } from 'node:net';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runEgressControl } from '../src/helpers/control.js';
import { createEgressHelperController } from '../src/network/controller.js';
import { EGRESS_PROTOCOL } from '../src/helpers/protocol.js';
import type { SandboxOperationError } from '@agen-ai/sandbox';

function multiplex(bytes: Uint8Array): Buffer {
  const frame = Buffer.alloc(8 + bytes.byteLength);
  frame[0] = 1;
  frame.writeUInt32BE(bytes.byteLength, 4);
  frame.set(bytes, 8);
  return frame;
}

async function listeningService() {
  const sockets = new Set<Socket>();
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => {});
  let closing = false;
  const server = createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('error', failed.reject);
  server.once('close', () => { if (!closing) failed.reject(new Error('Service closed unexpectedly.')); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP fixture.');
  return { port: address.port, failed: failed.promise, async close() {
    closing = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

test('real helper/control frames acknowledge readiness, retain a live service and close it on STOP', { timeout: 5000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = Duplex.from({ readable: output, writable: input });
  const closed = new Promise<void>((resolve) => transport.once('close', resolve));
  const errors: SandboxOperationError[] = [];
  const controller = createEgressHelperController({ attachment: { stream: transport, head: new Uint8Array(), closed }, role: 'broker',
    heartbeatMs: 20, leaseTimeoutMs: 500, onFailure: (error) => errors.push(error) });
  const service = await listeningService();
  const helperOutput = new Writable({ write(bytes: Buffer, _encoding, callback) { output.write(multiplex(bytes), callback); } });
  const helper = runEgressControl({ input, output: helperOutput, role: 'broker', leaseTimeoutMs: 500, start: async () => service });
  void helper.then(() => output.end(), () => output.destroy());
  let client: Socket | undefined;
  try {
    await controller.ready;
    client = createConnection({ host: '127.0.0.1', port: service.port });
    client.on('error', () => {});
    await new Promise<void>((resolve, reject) => { client?.once('connect', resolve); client?.once('error', reject); });
    await delay(60);
    const clientClosed = new Promise<void>((resolve) => client?.once('close', resolve));
    await controller.close();
    assert.equal(await helper, 'stop');
    await clientClosed;
    assert.equal(client.destroyed, true);
    assert.deepEqual(errors, []);
    await controller.close();
  } finally { client?.destroy(); await controller.close(); await helper; }
});

test('helper lease expiry before any controller heartbeat removes its actual service', { timeout: 5000 }, async () => {
  const service = await listeningService();
  const input = new PassThrough();
  const frames: unknown[] = [];
  const output = new Writable({ write(bytes: Buffer, _encoding, callback) { frames.push(JSON.parse(bytes.toString('utf8'))); callback(); } });
  assert.equal(await runEgressControl({ input, output, role: 'relay', leaseTimeoutMs: 40, start: async () => service }), 'lease_expired');
  assert.deepEqual(frames, [{ protocol: EGRESS_PROTOCOL, kind: 'closed', reason: 'lease_expired' }]);
  await assert.rejects(new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: service.port });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  }), { code: 'ECONNREFUSED' });
});

test('controller close before READY joins physical transport loss and disarms failure notification', { timeout: 5000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = Duplex.from({ readable: output, writable: input });
  const closed = new Promise<void>((resolve) => transport.once('close', resolve));
  const errors: SandboxOperationError[] = [];
  const controller = createEgressHelperController({ attachment: { stream: transport, head: new Uint8Array(), closed }, role: 'relay',
    heartbeatMs: 10, leaseTimeoutMs: 50, onFailure: (error) => errors.push(error) });
  const closing = controller.close();
  output.destroy();
  await closing;
  await assert.rejects(controller.ready, { name: 'SandboxOperationError', code: 'cancelled' });
  assert.equal(transport.destroyed, true);
  assert.deepEqual(errors, []);
});

test('controller rejects a wrong-role ready frame and reports one infrastructure failure', { timeout: 5000 }, async () => {
  const input = new PassThrough();
  input.resume();
  const output = new PassThrough();
  const transport = Duplex.from({ readable: output, writable: input });
  const closed = new Promise<void>((resolve) => transport.once('close', resolve));
  const errors: SandboxOperationError[] = [];
  const controller = createEgressHelperController({ attachment: { stream: transport, head: new Uint8Array(), closed }, role: 'broker',
    heartbeatMs: 10, leaseTimeoutMs: 100, onFailure: (error) => errors.push(error) });
  output.write(multiplex(Buffer.from(`${JSON.stringify({ protocol: EGRESS_PROTOCOL, kind: 'ready', role: 'relay' })}\n`)));
  await assert.rejects(controller.ready, { name: 'SandboxOperationError', code: 'driver_failure' });
  await controller.close();
  assert.deepEqual(errors.map((error) => error.message), ['Egress helper readiness differs from the reserved role.']);
});
