// ------------------------------------------------------------------------------------------------
//                link.ts - Raw symbolic-link observations within a stable caller-owned hierarchy
// ------------------------------------------------------------------------------------------------

import type { BigIntStats } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { SandboxOperationError } from '../../errors.js';
import { sameIdentity } from '../hostPath.js';

export async function readStableLink(path: string, expected: BigIntStats, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const target = await readlink(path, { encoding: 'buffer' });
  signal?.throwIfAborted();
  const current = await lstat(path, { bigint: true });
  if (!expected.isSymbolicLink() || !current.isSymbolicLink() || !sameIdentity(current, expected)
    || current.size !== expected.size || current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs
    || current.size !== BigInt(target.byteLength)) {
    throw new SandboxOperationError('input_limit', 'Host symbolic-link identity or target changed during the transfer.');
  }
  const repeated = await readlink(path, { encoding: 'buffer' });
  signal?.throwIfAborted();
  if (!target.equals(repeated)) throw new SandboxOperationError('input_limit', 'Host symbolic-link target changed during the transfer.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(target); }
  catch (cause) { throw new SandboxOperationError('input_limit', 'Symbolic-link targets must contain valid UTF-8.', { cause }); }
}
