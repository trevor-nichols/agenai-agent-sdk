import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { FilesystemChannel } from '../src/workspace/live/channel.js';
import { filesystemConfiguration } from './fixtures/filesystem.js';
import { frame } from './fixtures/process.js';

test('filesystem renewal fencing survives an entered heartbeat and rejects a request waiting behind it', { timeout: 5000 }, async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const transport = Duplex.from({ readable: output, writable: input });
  const closed = new Promise<void>((resolve) => transport.once('close', resolve));
  const configuration = { ...filesystemConfiguration(), control: { heartbeatMs: 10, leaseTimeoutMs: 2000 } };
  const failures: unknown[] = [];
  const channel = new FilesystemChannel({ stream: transport, head: new Uint8Array(), closed }, configuration,
    (error) => failures.push(error));
  channel.beginReadiness();
  const received = Promise.withResolvers<void>(); const commands: string[] = [];
  input.on('data', (bytes: Buffer) => { commands.push(bytes.toString('hex')); received.resolve(); });
  const send = (kind: number, text = '') => {
    const body = Buffer.from(text); const header = Buffer.alloc(8);
    header.writeUInt32BE(kind); header.writeUInt32BE(body.length, 4);
    output.write(frame(1, Buffer.concat([header, body])));
  };
  try {
    send(4, JSON.stringify({ protocol: configuration.protocol, layout: configuration.layout, uid: 65534, gid: 65534 }));
    await channel.ready; await received.promise;
    const waiting = channel.request({ operation: 'stat', path: '.' }, new AbortController().signal);
    void waiting.catch(() => {});
    channel.stopRenewal(); channel.stopRenewal();
    send(5);
    await assert.rejects(waiting, { name: 'SandboxStateError', message: 'Filesystem operation admission is closed.' });
    await delay(60);
    assert.deepEqual(commands, ['0000000a000000000000000000000000']);
    assert.equal(transport.destroyed, false, 'Renewal revocation must retain the original control attachment until owned close.');
    await channel.close();
    assert.equal(transport.destroyed, true);
    assert.deepEqual(failures, []);
  } finally { await channel.close(); }
});
