import assert from 'node:assert/strict';
import { Duplex, PassThrough } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { createEgressHelperController } from '../src/network/controller.js';
import { createDesktopVmObserverClient } from '../src/network/desktop/client.js';
import { DESKTOP_VM_CONTROLLER_PROTOCOL } from '../src/network/desktop/protocol.js';
import { FilesystemChannel } from '../src/workspace/live/channel.js';
import { filesystemConfiguration } from './fixtures/filesystem.js';

for (const role of ['observer', 'egress', 'filesystem'] as const) {
  test(`${role} readiness keeps the attached reader pending while start is queued and remains bounded after dispatch`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const input = new PassThrough(); const output = new PassThrough();
    const commands: Buffer[] = [];
    input.on('data', (bytes: Buffer) => commands.push(bytes));
    const transport = Duplex.from({ readable: output, writable: input });
    const closed = new Promise<void>((resolve) => transport.once('close', resolve));
    const attachment = { stream: transport, head: new Uint8Array(), closed };
    const failures: unknown[] = [];
    const controller = role === 'observer' ? createDesktopVmObserverClient({ attachment,
      configuration: { protocol: DESKTOP_VM_CONTROLLER_PROTOCOL, heartbeatMs: 10, leaseTimeoutMs: 1000,
        commandTimeoutMs: 50, maxOutputBytes: 65536 }, onFailure: (error) => failures.push(error) })
      : role === 'egress' ? createEgressHelperController({ attachment, role: 'broker', heartbeatMs: 10,
        leaseTimeoutMs: 1000, onFailure: (error) => failures.push(error) })
        : new FilesystemChannel(attachment, { ...filesystemConfiguration(), control: { heartbeatMs: 10, leaseTimeoutMs: 1000 } },
          (error) => failures.push(error));
    try {
      context.mock.timers.tick(60_001);
      await turn();
      assert.deepEqual(failures, [], 'Queue wait must not consume the helper readiness deadline.');
      assert.equal(transport.destroyed, false);
      assert.deepEqual(commands, [], 'An unstarted helper must not receive a lease-renewal command.');
      controller.beginReadiness();
      context.mock.timers.tick(role === 'observer' ? 51 : 1001);
      await assert.rejects(controller.ready, { name: 'SandboxOperationError', code: 'deadline_exceeded' });
      await controller.settled;
      assert.equal(failures.length, 1);
      assert.equal(transport.destroyed, true);
    } finally {
      transport.destroy();
      await controller.settled;
    }
  });
}
