// ------------------------------------------------------------------------------------------------
//                desktopEngineSocket.ts - Explicit physical local Engine socket observation
// ------------------------------------------------------------------------------------------------

import { lstat, realpath } from 'node:fs/promises';
import { SandboxUnsupportedError } from '@agen-ai/sandbox';
import type { DockerDesktopEngineSocketIdentity } from '../network/routeAuthority.js';

export async function inspectDesktopEngineSocket(endpoint: string, signal?: AbortSignal): Promise<DockerDesktopEngineSocketIdentity> {
  signal?.throwIfAborted();
  const path = endpoint.slice('unix://'.length);
  const before = await lstat(path, { bigint: true });
  if (!before.isSocket() || await realpath(path) !== path) throw new SandboxUnsupportedError('Desktop Engine requires an exact physical local Unix socket.');
  const after = await lstat(path, { bigint: true });
  if (!after.isSocket() || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) {
    throw new SandboxUnsupportedError('Desktop Engine socket changed during physical admission.');
  }
  signal?.throwIfAborted();
  return Object.freeze({ path, device: after.dev.toString(), inode: after.ino.toString(), mode: after.mode.toString() });
}
