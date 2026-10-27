// ------------------------------------------------------------------------------------------------
//                desktop-client.test.ts - Real Unix upgrade, correlated observation and joined close
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { DockerEngine } from '../src/engine/client.js';
import { createDesktopVmObserverClient } from '../src/network/desktop/client.js';
import type { DesktopVmObserverClient } from '../src/network/desktop/client.js';
import { DESKTOP_VM_CONTROLLER_PROTOCOL, parseDesktopVmObserverCommand, parseDesktopVmObserverConfiguration } from '../src/network/desktop/protocol.js';
import type { DesktopVmObserverCommand } from '../src/network/desktop/protocol.js';
import type { SandboxOperationError } from '@agen-ai/sandbox';
import { desktopVmDocument, netlinkAttribute, netlinkInteger, netlinkRecord } from './fixtures/desktopObservation.js';

interface Peer {
  readonly commands: DesktopVmObserverCommand[];
  send(value: unknown): Promise<void>;
  end(): void;
  destroy(): void;
}
async function withObserver(handle: (command: DesktopVmObserverCommand, peer: Peer) => Promise<boolean>,
  use: (client: DesktopVmObserverClient, peer: Peer, failures: SandboxOperationError[]) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'desktop-client-')));
  const path = join(directory, 'engine.sock');
  const sockets = new Set<Socket>();
  const peerReady = Promise.withResolvers<Peer>();
  const fixtureFailures: unknown[] = [];
  const server = createServer();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers['content-length'], '0'); assert.equal(head.length, 0);
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    let writes = Promise.resolve();
    const commands: DesktopVmObserverCommand[] = [];
    const peer: Peer = { commands, end() { socket.end(); }, destroy() { socket.destroy(); }, send(value) {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      writes = writes.then(async () => {
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          const payload = bytes.subarray(offset, offset + 8192); const frame = Buffer.alloc(payload.length + 8);
          frame[0] = 1; frame.writeUInt32BE(payload.length, 4); payload.copy(frame, 8);
          await new Promise<void>((resolve, reject) => socket.write(frame, (error) => error ? reject(error) : resolve()));
        }
      });
      return writes;
    } };
    let pending = Buffer.alloc(0);
    socket.on('data', (bytes: Buffer) => {
      pending = Buffer.concat([pending, bytes]);
      while (pending.includes(10)) {
        const newline = pending.indexOf(10);
        const command = parseDesktopVmObserverCommand(JSON.parse(pending.subarray(0, newline).toString('utf8')));
        pending = pending.subarray(newline + 1); commands.push(command);
        void (async () => {
          if (await handle(command, peer)) return;
          if (command.kind === 'heartbeat') await peer.send({ ...command });
          else if (command.kind === 'stop') { await peer.send({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'closed', reason: 'stop' }); peer.end(); }
        })().catch((cause: unknown) => { fixtureFailures.push(cause); socket.destroy(); });
      }
    });
    void peer.send({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'ready', observationProtocol: 'agenai.desktop-vm-network.v1' });
    peerReady.resolve(peer);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  let client: DesktopVmObserverClient | undefined;
  try {
    const attachment = await new DockerEngine(path).upgrade('/attach', { timeoutMs: 2000, maxResponseBytes: 262144 });
    const failures: SandboxOperationError[] = [];
    client = createDesktopVmObserverClient({ attachment,
      configuration: parseDesktopVmObserverConfiguration({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, heartbeatMs: 20,
        leaseTimeoutMs: 5000, commandTimeoutMs: 2000, maxOutputBytes: 262144 }), onFailure: (error) => failures.push(error) });
    await use(client, await peerReady.promise, failures);
    assert.deepEqual(fixtureFailures, []);
  } finally {
    if (client) await client.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed; await rm(directory, { recursive: true, force: true });
  }
}

test('Desktop client streams a fragmented complete observation while renewing the helper and joins STOP', { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<number>(); const observationRelease = Promise.withResolvers<void>();
  const heartbeatRenewed = Promise.withResolvers<void>(); const stopEntered = Promise.withResolvers<void>();
  const nativeJoined = Promise.withResolvers<void>();
  let heartbeats = 0;
  const document = desktopVmDocument();
  const routes: Buffer[] = [];
  for (let index = 0; index < 1024; index += 1) routes.push(netlinkRecord(24, Buffer.from([2, 32, 0, 0, 254, 4, 0, 1, 0, 0, 0, 0]),
    [netlinkAttribute(1, Buffer.from([11, 2, index >> 8, index & 255])), netlinkAttribute(4, netlinkInteger(7))]));
  document.routes += Buffer.concat(routes).toString('hex');
  await withObserver(async (command, peer) => {
    if (command.kind === 'heartbeat') { heartbeats += 1; if (heartbeats === 2) heartbeatRenewed.resolve(); return false; }
    if (command.kind === 'observe') {
      entered.resolve(command.sequence); await observationRelease.promise;
      await peer.send({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'observation', sequence: command.sequence, document }); return true;
    }
    stopEntered.resolve(); await nativeJoined.promise;
    await peer.send({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'closed', reason: 'stop' }); peer.end(); return true;
  }, async (client, peer, failures) => {
    await client.ready;
    const observation = client.observe(); await entered.promise;
    await assert.rejects(client.observe(), { name: 'SandboxStateError' });
    await heartbeatRenewed.promise; observationRelease.resolve();
    const result = await observation;
    assert.equal(result.snapshot.routes.length, 1025);
    assert(result.excludedCidrs.includes('11.2.3.255/32'));
    let closed = false; const closing = client.close().then((value) => { closed = true; return value; });
    await stopEntered.promise; await turn(); assert.equal(closed, false);
    nativeJoined.resolve(); assert.deepEqual(await closing, { kind: 'confirmed_stop' });
    assert.deepEqual(await client.close(), { kind: 'confirmed_stop' });
    assert.deepEqual(peer.commands.map((command) => command.sequence), peer.commands.map((_command, index) => index + 1));
    assert.deepEqual(failures, []);
  });
});

test('Desktop client fences an uncorrelated observation and keeps its original failure through joined close', { timeout: 10_000 }, async () => {
  await withObserver(async (command, peer) => {
    if (command.kind !== 'observe') return false;
    await peer.send({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'observation', sequence: command.sequence + 1, document: desktopVmDocument() });
    return true;
  }, async (client, _peer, failures) => {
    await client.ready;
    await assert.rejects(client.observe(), { name: 'SandboxOperationError', code: 'driver_failure' });
    const close = await client.close();
    assert.equal(close.kind, 'attachment_joined');
    if (close.kind !== 'attachment_joined') throw new Error('Expected retained observer failure.');
    assert.equal(close.failure, failures[0]); assert.equal(failures.length, 1);
    assert.equal(await client.close(), close);
  });
});

test('Desktop observation cancellation waits for stop receipt and attachment join', { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<void>(); const stopped = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  await withObserver(async (command, peer) => {
    if (command.kind === 'observe') { entered.resolve(); return true; }
    if (command.kind !== 'stop') return false;
    stopped.resolve(); await release.promise;
    await peer.send({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'closed', reason: 'stop' }); peer.end(); return true;
  }, async (client, _peer, failures) => {
    await client.ready; const cancellation = new AbortController();
    let settled = false;
    const observation = client.observe(cancellation.signal).finally(() => { settled = true; });
    void observation.catch(() => {});
    await entered.promise; cancellation.abort(); await stopped.promise; await turn(); assert.equal(settled, false);
    release.resolve(); await assert.rejects(observation, { name: 'SandboxOperationError', code: 'cancelled' });
    assert.deepEqual(await client.close(), { kind: 'confirmed_stop' }); assert.deepEqual(failures, []);
  });
});
