// ------------------------------------------------------------------------------------------------
//                heldPeer.ts - Controlled native response writes through the public ACP client
// ------------------------------------------------------------------------------------------------

import { PassThrough, Writable } from 'node:stream';
import type { TestContext } from 'node:test';

import { createAcpClient, type CreateAcpClientOptions } from '../../src/index.js';

interface HeldWrite {
  readonly message: Record<string, unknown>;
  readonly finish: (error?: Error) => void;
}

export function heldPeer(t: TestContext, options: Partial<CreateAcpClientOptions> = {}) {
  const stdout = new PassThrough();
  const callbacks = new Set<() => void>();
  const writes: HeldWrite[] = [];
  const waiters: ((write: HeldWrite) => void)[] = [];
  const stdin = new Writable({ highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      const finish = (error?: Error) => { if (callbacks.delete(finish)) callback(error); };
      callbacks.add(finish);
      const write = { message: JSON.parse(chunk.toString('utf8')) as Record<string, unknown>, finish };
      const waiter = waiters.shift();
      if (waiter) waiter(write);
      else writes.push(write);
    },
  });
  const client = createAcpClient({ ...options, stdout, stdin, schemaChannel: options.schemaChannel ?? 'unstable',
    unknownExtensionPolicy: options.unknownExtensionPolicy ?? 'standard', limits: { shutdownDrainMs: 0, ...options.limits } });
  t.after(async () => {
    await client.dispose();
    for (const finish of callbacks) finish();
    stdout.destroy(); stdin.destroy();
  });
  return { client, stdin,
    send: (message: unknown) => stdout.write(JSON.stringify(message) + '\n'),
    nextWrite: () => {
      const write = writes.shift();
      return write ? Promise.resolve(write) : new Promise<HeldWrite>((resolve) => waiters.push(resolve));
    },
  };
}
