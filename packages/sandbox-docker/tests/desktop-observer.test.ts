import assert from 'node:assert/strict';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';
import { runDesktopVmObserverControl } from '../src/network/desktop/controller.js';
import { DESKTOP_VM_CONTROLLER_PROTOCOL, parseDesktopVmObserverCommand, parseDesktopVmObserverConfiguration } from '../src/network/desktop/protocol.js';

const configuration = parseDesktopVmObserverConfiguration({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL,
  heartbeatMs: 1, leaseTimeoutMs: 100, commandTimeoutMs: 10, maxOutputBytes: 1024 });
const command = (kind: string, sequence: number) => `${JSON.stringify({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind, sequence })}\n`;

async function control(input: Readable) {
  const output = new PassThrough();
  const frames: unknown[] = [];
  output.on('data', (bytes: Buffer) => frames.push(JSON.parse(bytes.toString('utf8'))));
  const reason = await runDesktopVmObserverControl({ input, output, configuration });
  output.destroy();
  return { reason, frames };
}

test('Desktop observer acknowledges ordered heartbeats and explicit stop without an observation', { timeout: 1000 }, async () => {
  const result = await control(Readable.from([Buffer.from(command('heartbeat', 1) + command('heartbeat', 2) + command('stop', 3))]));
  assert.deepEqual(result, { reason: 'stop', frames: [
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'ready', observationProtocol: 'agenai.desktop-vm-network.v1' },
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'heartbeat', sequence: 1 },
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'heartbeat', sequence: 2 },
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'closed', reason: 'stop' },
  ] });
});

test('Desktop observer retires replayed control and an expired controller lease', { timeout: 1000 }, async () => {
  const replay = await control(Readable.from([Buffer.from(command('heartbeat', 1) + command('heartbeat', 1))]));
  assert.deepEqual(replay, { reason: 'invalid_control', frames: [
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'ready', observationProtocol: 'agenai.desktop-vm-network.v1' },
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'heartbeat', sequence: 1 },
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'closed', reason: 'invalid_control' },
  ] });
  const expired = await control(new PassThrough());
  assert.deepEqual(expired, { reason: 'lease_expired', frames: [
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'ready', observationProtocol: 'agenai.desktop-vm-network.v1' },
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'closed', reason: 'lease_expired' },
  ] });
});

test('Desktop observer joins a stalled output write after its bounded failure', { timeout: 1000 }, async () => {
  const output = new Writable({ write() { /* Deliberately never acknowledges the entered transport write. */ } });
  assert.equal(await runDesktopVmObserverControl({ input: new PassThrough(), output, configuration }), 'output_failure');
  assert.equal(output.destroyed, true);
});

test('Desktop observer protocol has no execution or arbitrary observation arguments', () => {
  for (const value of [
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'exec', sequence: 1 },
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'observe', sequence: 1, executable: '/bin/sh' },
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'heartbeat', sequence: 0 },
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'stop', sequence: 1, arguments: [] },
  ]) assert.throws(() => parseDesktopVmObserverCommand(value), TypeError);
  assert.deepEqual(parseDesktopVmObserverCommand({ protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'observe', sequence: 7 }),
    { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, kind: 'observe', sequence: 7 });
});
