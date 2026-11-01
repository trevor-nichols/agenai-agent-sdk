// ------------------------------------------------------------------------------------------------
//                desktop-client.test.ts - Real Unix upgrade, correlated observation and joined close
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DockerEngine } from '../src/engine/client.js';
import { createDesktopVmObserverClient } from '../src/network/desktop/client.js';
import type { DesktopVmObserverClient } from '../src/network/desktop/client.js';
import { runDesktopVmObserverControl } from '../src/network/desktop/controller.js';
import { DESKTOP_VM_CONTROLLER_PROTOCOL, parseDesktopVmObserverCommand, parseDesktopVmObserverConfiguration } from '../src/network/desktop/protocol.js';
import type { DesktopVmObserverCommand } from '../src/network/desktop/protocol.js';
import { captureDesktopCompleteObservation } from '../src/network/desktop/observation/complete.js';
import { captureDockerRouteAuthority } from '../src/network/routeAuthority.js';
import { createDockerDesktopRouteAuthority } from '../src/node/desktopRouteAuthority.js';
import { DockerApi, DockerResponseByteBudget } from '../src/resources/api.js';
import type { SandboxOperationError } from '@agen-ai/sandbox';
import { desktopHostDocument, desktopVmDocument, netlinkAttribute, netlinkInteger, netlinkRecord } from './fixtures/desktopObservation.js';
import { desktopRouteAuthorityOptions } from './fixtures/desktopRouteAuthority.js';

interface Peer {
  readonly commands: DesktopVmObserverCommand[];
  send(value: unknown): Promise<void>;
  sendRaw(bytes: Uint8Array): Promise<void>;
  end(): void;
  destroy(): void;
}
async function withObserver(handle: (command: DesktopVmObserverCommand, peer: Peer) => Promise<boolean>,
  use: (client: DesktopVmObserverClient, peer: Peer, failures: SandboxOperationError[], endpoint: string) => Promise<void>,
  requestHandler?: RequestListener) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'desktop-client-')));
  const path = join(directory, 'engine.sock');
  const sockets = new Set<Socket>();
  const peerReady = Promise.withResolvers<Peer>();
  const fixtureFailures: unknown[] = [];
  const server = createServer(requestHandler);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers['content-length'], '0'); assert.equal(head.length, 0);
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    let writes = Promise.resolve();
    const commands: DesktopVmObserverCommand[] = [];
    const peer: Peer = { commands, end() { socket.end(); }, destroy() { socket.destroy(); },
      send(value) { return peer.sendRaw(Buffer.from(`${JSON.stringify(value)}\n`)); }, sendRaw(bytes) {
      writes = writes.then(async () => {
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          const payload = bytes.subarray(offset, offset + 8192); const frame = Buffer.alloc(payload.length + 8);
          frame[0] = 1; frame.writeUInt32BE(payload.length, 4); frame.set(payload, 8);
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
    client.beginReadiness();
    await use(client, await peerReady.promise, failures, `unix://${path}`);
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

test('Desktop raw VM budget accumulates actual envelopes and rejects overflow before malformed JSON parsing', { timeout: 10_000 }, async () => {
  const document = desktopVmDocument();
  const frameBytes = Buffer.byteLength(`${JSON.stringify({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL,
    kind: 'observation', sequence: 1, document })}\n`);
  const budget = new DockerResponseByteBudget(2 * frameBytes);
  let observations = 0;
  await withObserver(async (command, peer) => {
    if (command.kind !== 'observe') return false;
    observations += 1;
    if (observations === 1) await peer.send({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'observation', sequence: command.sequence, document });
    else {
      const invalidJson = Buffer.alloc(2 * frameBytes, 0x21); invalidJson[invalidJson.length - 1] = 10;
      await peer.sendRaw(invalidJson);
    }
    return true;
  }, async (client, peer, failures) => {
    const first = await client.observe(undefined, budget);
    assert.equal(first.snapshot.kernel, '6.12.54-linuxkit');
    assert.equal(first.snapshot.routes.length, 1);
    await assert.rejects(client.observe(undefined, budget), {
      name: 'SandboxOperationError', code: 'output_limit', message: 'Docker JSON responses exceed their cumulative byte bound.',
    });
    const settlement = await client.close();
    assert.equal(settlement.kind, 'attachment_joined');
    if (settlement.kind !== 'attachment_joined') assert.fail('Overflow must retain the joined observer failure.');
    assert.equal(settlement.failure, failures[0]);
    assert.equal(failures.length, 1);
    assert.equal(peer.commands.filter((command) => command.kind === 'observe').length, 2);
  });
});

test('complete Desktop brackets share the actual host, VM and Engine raw byte limit independently of normalized retention',
  { timeout: 30_000 }, async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'desktop-bracket-')));
    const executable = join(directory, 'host-observer.cjs');
    const hostJson = JSON.stringify(desktopHostDocument());
    const source = `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(hostJson)});process.stdout.write(' '.repeat(${3 * 1024 ** 2 - Buffer.byteLength(hostJson)}));\n`;
    await writeFile(executable, source, { mode: 0o700 });
    const ids = Array.from({ length: 22 }, (_, index) => (index + 1).toString(16).padStart(64, '0'));
    let networkCount = 17;
    const requests: string[] = [];
    try {
      await withObserver(async (command, peer) => {
        if (command.kind !== 'observe') return false;
        await peer.send({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'observation', sequence: command.sequence,
          document: desktopVmDocument() });
        return true;
      }, async (client, peer, failures, endpoint) => {
        const descriptor = desktopRouteAuthorityOptions('desktop-apple-virtualization-native-arm64', endpoint);
        descriptor.hostObserver.executable = { path: executable, sha256: createHash('sha256').update(source).digest('hex') };
        descriptor.maxOutputBytes = 4 * 1024 ** 2; descriptor.commandTimeoutMs = 3000;
        const binding = captureDockerRouteAuthority(createDockerDesktopRouteAuthority(descriptor));
        if (binding.kind !== 'local_docker_desktop') assert.fail('Expected the original Desktop binding.');
        const expectedHost = await binding.observeHost();
        const originalSocket = await binding.observeEngineSocket();
        const api = new DockerApi(new DockerEngine(endpoint.slice(7)), 2000);
        const capture = () => captureDesktopCompleteObservation({ api, binding, observer: client, expectedHost,
          assertEndpoint: async (signal) => { assert.deepEqual(await binding.observeEngineSocket(signal), originalSocket); },
        }, AbortSignal.timeout(10_000));
        const complete = await capture();
        assert.equal(complete.engine.networks.length, 17);
        assert.equal(complete.vmBefore.snapshot.kernel, '6.12.54-linuxkit');
        assert.equal(complete.vmAfter.snapshot.kernel, '6.12.54-linuxkit');
        networkCount = 22; requests.length = 0;
        await assert.rejects(capture(), {
          name: 'SandboxOperationError', code: 'output_limit', message: 'Docker JSON responses exceed their cumulative byte bound.',
        });
        assert.deepEqual(requests, ['/info', '/v1.52/networks', ...ids.slice(0, 21).map((id) => `/v1.52/networks/${id}`)]);
        assert.equal(peer.commands.filter((command) => command.kind === 'observe').length, 3);
        assert.deepEqual(await client.close(), { kind: 'confirmed_stop' });
        assert.deepEqual(failures, []);
      }, (request, response) => {
        const path = request.url ?? ''; requests.push(path);
        const selectedId = path.startsWith('/v1.52/networks/') ? path.slice('/v1.52/networks/'.length) : undefined;
        const value = path === '/info' ? { ID: 'desktop-unit-daemon', Name: 'host', KernelVersion: '6.12.54-linuxkit' }
          : path === '/v1.52/networks' ? ids.slice(0, networkCount).map((Id) => ({ Id }))
            : selectedId !== undefined ? { Id: selectedId, Name: 'external-network', Created: '2026-10-26T00:00:00Z',
              Driver: 'bridge', Scope: 'local', Internal: false, Attachable: false, Ingress: false, EnableIPv6: false, ConfigOnly: false,
              IPAM: { Driver: 'default', Options: null, Config: [{ Subnet: '11.7.0.0/16', Gateway: '11.7.0.1' }] },
              Options: {}, Labels: {}, Containers: {} } : undefined;
        if (value === undefined) { response.writeHead(404); response.end(); return; }
        const json = JSON.stringify(value);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(selectedId === undefined ? json : json + ' '.repeat(1024 ** 2 - Buffer.byteLength(json)));
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });


test('Desktop renewal fencing rejects new observations and a late heartbeat acknowledgement cannot reopen it', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers<DesktopVmObserverCommand>();
  await withObserver(async (command) => {
    if (command.kind === 'heartbeat') { entered.resolve(command); return true; }
    return false;
  }, async (client, peer, failures) => {
    await client.ready;
    const heartbeat = await entered.promise;
    client.stopRenewal(); client.stopRenewal();
    await peer.send(heartbeat);
    await delay(80);
    await assert.rejects(client.observe(), { name: 'SandboxStateError', message: 'Desktop observer admission is closed.' });
    assert.deepEqual(peer.commands, [heartbeat]);
    assert.deepEqual(await client.close(), { kind: 'confirmed_stop' });
    assert.deepEqual(peer.commands.map((command) => command.kind), ['heartbeat', 'stop']);
    assert.deepEqual(failures, []);
  });
});

test('Desktop renewal fencing suppresses a queued heartbeat and the real helper accepts STOP without a sequence gap', { timeout: 5000 }, async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const commands: DesktopVmObserverCommand[] = [];
  const outbound = new Writable({ write(bytes: Buffer, _encoding, callback) {
    commands.push(parseDesktopVmObserverCommand(JSON.parse(bytes.toString('utf8')))); input.write(bytes, callback);
  } });
  const transport = Duplex.from({ readable: output, writable: outbound });
  const closed = new Promise<void>((resolve) => transport.once('close', resolve));
  const configuration = parseDesktopVmObserverConfiguration({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL,
    heartbeatMs: 20, leaseTimeoutMs: 2000, commandTimeoutMs: 500, maxOutputBytes: 65536 });
  const failures: SandboxOperationError[] = [];
  const client = createDesktopVmObserverClient({ attachment: { stream: transport, head: new Uint8Array(), closed }, configuration,
    onFailure: (error) => failures.push(error) });
  client.beginReadiness();
  const helperOutput = new Writable({ write(bytes: Buffer, _encoding, callback) {
    const frame = Buffer.alloc(bytes.length + 8); frame[0] = 1; frame.writeUInt32BE(bytes.length, 4); frame.set(bytes, 8);
    output.write(frame, callback);
  } });
  const helper = runDesktopVmObserverControl({ input, output: helperOutput, configuration });
  void helper.then(() => { output.end(); outbound.end(); }, () => { output.destroy(); outbound.destroy(); });
  try {
    await client.ready;
    client.stopRenewal();
    assert.deepEqual(commands, []);
    await turn();
    assert.deepEqual(commands, []);
    assert.equal(transport.destroyed, false);
    assert.deepEqual(await client.close(), { kind: 'confirmed_stop' });
    assert.equal(await helper, 'stop');
    assert.deepEqual(commands, [{ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'stop', sequence: 1 }]);
    assert.deepEqual(failures, []);
  } finally { await client.close(); await helper; }
});
