// ------------------------------------------------------------------------------------------------
//                identity-stub.ts - Platform admission for owner tests; byte verification stays real
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyExecutable as verifyPinned, type ProcessIdentity, type VerifiedExecutable } from '../../src/node/identity.js';

export { assertExecutableUnchanged } from '../../src/node/identity.js';

/** Admits the test process as the qualified Linux x64 tuple under its actual identity. */
export function admitProcess(): ProcessIdentity {
  return { platform: 'linux-x64', uid: process.geteuid!(), gid: process.getegid!() };
}

export function toolPins(): Readonly<{ bubblewrap: string; helper: string }> {
  return { bubblewrap: 'test-launcher', helper: 'test-launcher' };
}

/** Pins each launcher to its own current bytes, then applies the real physical-file verification. */
export async function verifyExecutable(path: string, _pin: string, maxBytes: number, uid: number): Promise<VerifiedExecutable> {
  return verifyPinned(path, createHash('sha256').update(await readFile(path)).digest('hex'), maxBytes, uid);
}
