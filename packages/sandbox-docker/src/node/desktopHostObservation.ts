// ------------------------------------------------------------------------------------------------
//                desktopHostObservation.ts - Pinned prepared Darwin observation and joined execution
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { SandboxOperationError, SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { DockerDesktopRouteAuthorityIdentity } from '../network/desktopAuthority.js';
import { parseDesktopHostObservation } from '../network/desktop/observation/host.js';
import type { DesktopHostAuthorityObservation } from '../network/desktop/observation/host.js';
import { runPreparedRouteObserver } from './command.js';

async function executableIdentity(descriptor: FileHandle, path: string, sha256: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const before = await descriptor.stat({ bigint: true });
  const named = await lstat(path, { bigint: true });
  if (!before.isFile() || !named.isFile() || before.size > 32n * 1024n ** 2n || (before.mode & 0o111n) === 0n
    || before.dev !== named.dev || before.ino !== named.ino || await realpath(path) !== path) {
    throw new SandboxUnsupportedError('Desktop host observer must be an exact physical regular executable.');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  let position = 0;
  while (true) {
    const read = await descriptor.read(buffer, 0, buffer.length, position);
    if (read.bytesRead === 0) break;
    position += read.bytesRead;
    if (position > 32 * 1024 ** 2) throw new SandboxUnsupportedError('Desktop host observer exceeds its artifact bound.');
    hash.update(buffer.subarray(0, read.bytesRead));
    signal?.throwIfAborted();
  }
  const after = await descriptor.stat({ bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || hash.digest('hex') !== sha256) {
    throw new SandboxUnsupportedError('Desktop host observer digest or file identity differs or changed.');
  }
  return [after.dev, after.ino, after.mode, after.size, after.mtimeNs, after.ctimeNs].map(String).join(':');
}

export async function readDesktopHostObservation(identity: DockerDesktopRouteAuthorityIdentity, signal?: AbortSignal): Promise<DesktopHostAuthorityObservation> {
  const executable = identity.hostObserver.executable;
  signal?.throwIfAborted();
  const descriptor = await open(executable.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await executableIdentity(descriptor, executable.path, executable.sha256, signal);
    const output = await runPreparedRouteObserver(executable.path, identity, signal);
    const after = await executableIdentity(descriptor, executable.path, executable.sha256, signal);
    if (before !== after) throw new SandboxUnsupportedError('Desktop host observer changed during observation.');
    if (output.stderr.length !== 0) throw new SandboxOperationError('driver_failure', 'Desktop host observer emitted a failure diagnostic.');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.stdout));
    return Object.freeze({ ...parseDesktopHostObservation(value), executableIdentity: before });
  } finally { await descriptor.close(); }
}
