// ------------------------------------------------------------------------------------------------
//                grok-binary.mjs - Explicit pinned ELF input with bounded reads and descriptor ownership
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export const GROK_SHA256 = '2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa';
export const GROK_VERSION = 'grok 1.0.62 (1474f9cbdd91)';

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export class GrokBinaryCleanupError extends AggregateError {
  constructor(primary, cleanup, owner) {
    super([primary, cleanup], 'Grok binary validation failed and its descriptor cleanup remains owned.');
    this.name = 'GrokBinaryCleanupError';
    this.primaryError = primary;
    this.retryCleanup = () => owner.close();
  }
}

/** Owns one descriptor; every import rehashes the exact bytes delivered to the sandbox. */
export async function openGrokBinary(filename, expectedSha256) {
  assert.equal(typeof filename, 'string');
  assert(path.isAbsolute(filename) && path.normalize(filename) === filename, 'Harness path must be canonical and absolute.');
  assert.equal(typeof expectedSha256, 'string');
  assert(/^[a-f0-9]{64}$/u.test(expectedSha256), 'Harness requires an exact SHA-256 pin.');
  const before = await lstat(filename, { bigint: true });
  assert(before.isFile(), 'Harness must be an explicit regular file, not a symlink or special file.');
  assert(before.size >= 64n && before.size <= BigInt(Number.MAX_SAFE_INTEGER), 'Harness length must fit the streaming file interface.');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let active;
  let closed = false;
  let closeActual;
  const identity = await handle.stat({ bigint: true }).catch(async (primary) => {
    try { await handle.close(); } catch (cleanup) {
      throw new GrokBinaryCleanupError(primary, cleanup, { close: () => handle.close() });
    }
    throw primary;
  });
  const owner = {
    byteLength: Number(identity.size),
    architecture: Object.freeze({ format: 'ELF64', byteOrder: 'little-endian', machine: 'x86_64' }),
    source() {
      return [{ kind: 'file', path: 'harness/grok', byteLength: Number(identity.size), executable: true,
        open({ signal }) { return chunks(signal); } }];
    },
    close() {
      closed = true;
      closeActual ??= (async () => { await active?.promise; await handle.close(); })().catch((error) => {
        closeActual = undefined;
        throw error;
      });
      return closeActual;
    },
  };
  async function* chunks(signal) {
    assert(!closed && !active, 'Harness reader is closed or already active.');
    const current = Promise.withResolvers();
    active = current;
    try {
      signal?.throwIfAborted();
      assert(sameFile(identity, await handle.stat({ bigint: true })) && sameFile(identity, await lstat(filename, { bigint: true })), 'Harness identity or length changed.');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const hash = createHash('sha256');
      let position = 0;
      while (position < owner.byteLength) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, owner.byteLength - position), position);
        assert(bytesRead > 0, 'Harness was truncated during import.');
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
      assert.equal((await handle.read(buffer, 0, 1, position)).bytesRead, 0, 'Harness grew during import.');
      assert(sameFile(identity, await handle.stat({ bigint: true })) && sameFile(identity, await lstat(filename, { bigint: true })), 'Harness changed during import.');
      assert.equal(hash.digest('hex'), expectedSha256, 'Harness bytes differ from the exact pinned binary.');
    } finally { active = undefined; current.resolve(); }
  }
  try {
    assert(identity.isFile() && sameFile(before, identity), 'Harness was replaced during acquisition.');
    const header = Buffer.alloc(64);
    assert.equal((await handle.read(header, 0, header.length, 0)).bytesRead, header.length);
    assert(header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && header[4] === 2 && header[5] === 1 && header[6] === 1
      && header.readUInt16LE(18) === 62 && [2, 3].includes(header.readUInt16LE(16)),
    'Harness must be a little-endian executable or PIE ELF64 for x86_64; host macOS binaries and arm64 ELF are not this harness.');
    for await (const _chunk of chunks()) { /* Hash the complete bounded stream before native acquisition. */ }
    return Object.freeze(owner);
  } catch (primary) {
    try { await owner.close(); } catch (cleanup) { throw new GrokBinaryCleanupError(primary, cleanup, owner); }
    throw primary;
  }
}
