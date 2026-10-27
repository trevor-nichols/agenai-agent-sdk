// ------------------------------------------------------------------------------------------------
//                socketDirectory.ts - Read-only attestation of the explicitly copied private socket root
// ------------------------------------------------------------------------------------------------

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { EGRESS_SOCKET_DIRECTORY } from './protocol.js';

export async function verifyEgressSocketDirectory(): Promise<void> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0 || gid === 0) throw new Error('Egress helpers require explicit non-root Linux identities.');
  const named = await lstat(EGRESS_SOCKET_DIRECTORY);
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error('Egress socket copy-up did not produce a real directory.');
  const descriptor = await open(EGRESS_SOCKET_DIRECTORY, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const selected = await descriptor.stat();
    if (!selected.isDirectory() || named.dev !== selected.dev || named.ino !== selected.ino
      || selected.uid !== uid || selected.gid !== gid || (selected.mode & 0o7777) !== 0o700) {
      throw new Error('Egress socket copy-up differs from its exact private directory identity.');
    }
  } finally { await descriptor.close(); }
}
