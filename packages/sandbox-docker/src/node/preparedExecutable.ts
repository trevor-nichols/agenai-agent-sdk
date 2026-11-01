import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { SandboxUnsupportedError } from '@agen-ai/sandbox';

export interface PreparedExecutable {
  readonly identity: string;
  verify(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

async function inspect(descriptor: FileHandle, path: string, sha256: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const before = await descriptor.stat({ bigint: true });
  const named = await lstat(path, { bigint: true });
  if (!before.isFile() || !named.isFile() || before.size > 32n * 1024n ** 2n || (before.mode & 0o111n) === 0n
    || before.dev !== named.dev || before.ino !== named.ino || await realpath(path) !== path) {
    throw new SandboxUnsupportedError('Prepared Desktop authority requires an exact physical regular executable.');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  let position = 0;
  for (;;) {
    const read = await descriptor.read(buffer, 0, buffer.length, position);
    if (read.bytesRead === 0) break;
    position += read.bytesRead;
    if (position > 32 * 1024 ** 2) throw new SandboxUnsupportedError('Prepared Desktop executable exceeds its artifact bound.');
    hash.update(buffer.subarray(0, read.bytesRead));
    signal?.throwIfAborted();
  }
  const after = await descriptor.stat({ bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || hash.digest('hex') !== sha256) {
    throw new SandboxUnsupportedError('Prepared Desktop executable digest or file identity differs or changed.');
  }
  return [after.dev, after.ino, after.mode, after.size, after.mtimeNs, after.ctimeNs].map(String).join(':');
}

export async function openPreparedExecutable(
  executable: Readonly<{ path: string; sha256: string }>, signal?: AbortSignal,
): Promise<PreparedExecutable> {
  const descriptor = await open(executable.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const identity = await inspect(descriptor, executable.path, executable.sha256, signal);
    return Object.freeze({ identity,
      async verify(checkSignal?: AbortSignal) {
        if (await inspect(descriptor, executable.path, executable.sha256, checkSignal) !== identity) {
          throw new SandboxUnsupportedError('Prepared Desktop executable changed after admission.');
        }
      },
      close: () => descriptor.close(),
    });
  } catch (error) {
    await descriptor.close();
    throw error;
  }
}
