// ------------------------------------------------------------------------------------------------
//                source.ts - Explicit private stable credential reads without source disclosure
// ------------------------------------------------------------------------------------------------

import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { SANDBOX_CREDENTIAL_MAX_BYTES } from './protocol.js';
import type { SandboxCredentialFileReadOptions } from './types.js';

function isPrivateFile(metadata: BigIntStats, uid: number): boolean {
  return metadata.isFile() && metadata.uid === BigInt(uid) && metadata.nlink === 1n
    && (metadata.mode & 0o7077n) === 0n && metadata.size >= 1n && metadata.size <= BigInt(SANDBOX_CREDENTIAL_MAX_BYTES);
}

function isUnchanged(current: BigIntStats, expected: BigIntStats): boolean {
  return current.isFile() && current.dev === expected.dev && current.ino === expected.ino
    && current.size === expected.size && current.mtimeNs === expected.mtimeNs && current.ctimeNs === expected.ctimeNs
    && current.mode === expected.mode && current.uid === expected.uid && current.gid === expected.gid && current.nlink === expected.nlink;
}

function rejectSource(): never {
  throw new TypeError('Sandbox credential source is unavailable or invalid.');
}

export async function readSandboxCredentialFile(options: SandboxCredentialFileReadOptions): Promise<Uint8Array> {
  let file: FileHandle | undefined;
  let bytes: Uint8Array | undefined;
  let returned = false;
  try {
    const { path, signal } = options;
    if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path) || normalize(path) !== path
      || path.endsWith('/') || (signal !== undefined && !(signal instanceof AbortSignal)) || typeof process.getuid !== 'function') rejectSource();
    signal?.throwIfAborted();
    const expected = await lstat(path, { bigint: true });
    signal?.throwIfAborted();
    if (!isPrivateFile(expected, process.getuid()) || await realpath(path) !== path) rejectSource();
    signal?.throwIfAborted();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    signal?.throwIfAborted();
    if (!isUnchanged(await file.stat({ bigint: true }), expected)) rejectSource();
    signal?.throwIfAborted();
    bytes = new Uint8Array(Number(expected.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      signal?.throwIfAborted();
      if (bytesRead === 0) rejectSource();
      offset += bytesRead;
    }
    const remainder = new Uint8Array(1);
    const { bytesRead } = await file.read(remainder, 0, 1, offset);
    remainder.fill(0);
    signal?.throwIfAborted();
    if (bytesRead !== 0 || !isUnchanged(await file.stat({ bigint: true }), expected)) rejectSource();
    signal?.throwIfAborted();
    if (!isUnchanged(await lstat(path, { bigint: true }), expected) || await realpath(path) !== path) rejectSource();
    signal?.throwIfAborted();
    await file.close();
    file = undefined;
    signal?.throwIfAborted();
    returned = true;
    return bytes;
  } catch {
    return rejectSource();
  } finally {
    if (!returned) bytes?.fill(0);
    if (file) {
      try { await file.close(); } catch { /* The public source error remains content-free. */ }
    }
  }
}
