// ------------------------------------------------------------------------------------------------
//                manifests.mjs - Bounded JSONL records and descriptor-based complete payload hashes
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';

export const chunkBytes = 64 * 1024;
const recordBytes = 2048;

export async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    assert(bytesWritten > 0, 'File write made no progress.');
    offset += bytesWritten;
  }
}

export async function writeRecord(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  assert(bytes.length <= recordBytes, 'Qualification record exceeded its finite envelope.');
  await writeAll(file, bytes);
}

export async function* records(path, { signal } = {}) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let pending = Buffer.alloc(0);
  try {
    assert((await file.stat()).isFile(), 'Regular manifest required.');
    const buffer = Buffer.alloc(chunkBytes);
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const available = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let start = 0;
      for (let end = available.indexOf(10); end >= 0; end = available.indexOf(10, start)) {
        assert(end - start > 0 && end - start <= recordBytes, 'Invalid manifest record length.');
        const line = available.subarray(start, end);
        const text = line.toString('utf8');
        assert(Buffer.from(text).equals(line), 'Manifest UTF-8 must be exact.');
        yield JSON.parse(text);
        start = end + 1;
      }
      pending = Buffer.from(available.subarray(start));
      assert(pending.length <= recordBytes, 'Unterminated manifest record exceeded its envelope.');
    }
    assert.equal(pending.length, 0, 'Manifest requires a complete final newline.');
  } finally { await file.close(); }
}

export function dataRecord(value) {
  assert(value && Object.keys(value).sort().join(',') === 'byteLength,path,sha256', 'Exact data record required.');
  assert(typeof value.path === 'string' && /^(?:dataset\/[0-9]{5}\.bin|artifacts\/nested\/result\.bin)$/u.test(value.path), 'Generated dataset path required.');
  assert(Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= 512 * 1024 ** 2, 'Generated length out of profile.');
  assert(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256), 'SHA-256 required.');
  return value;
}

export function digestRecord(hash, value) {
  hash.update(`${value.path}\0${value.byteLength}\0${value.sha256}\n`);
}

export async function hashFile(path, { signal } = {}) {
  const before = await lstat(path, { bigint: true });
  assert(before.isFile() && !before.isSymbolicLink(), 'Hash input must be a regular file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    const entered = await file.stat({ bigint: true });
    assert(entered.isFile() && entered.dev === before.dev && entered.ino === before.ino && entered.size === before.size, 'Hash input replaced before open.');
    const buffer = Buffer.alloc(chunkBytes);
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    assert(BigInt(byteLength) === before.size && after.size === before.size && after.mtimeNs === before.mtimeNs
      && after.ctimeNs === before.ctimeNs, 'Hash input changed during its complete read.');
    return { byteLength, sha256: hash.digest('hex'), allocatedBytes: after.blocks * 512n };
  } finally { await file.close(); }
}

export async function censusDirectory(root, { controlFiles, signal } = {}) {
  let files = 0;
  let dataFiles = 0;
  let directories = 0;
  let payloadBytes = 0n;
  let allocatedBytes = 0n;
  const visit = async (prefix) => {
    const directory = await opendir(prefix ? join(root, prefix) : root, { bufferSize: 8 });
    for await (const entry of directory) {
      signal?.throwIfAborted();
      const local = prefix ? `${prefix}/${entry.name}` : entry.name;
      const actual = await lstat(join(root, local), { bigint: true });
      assert(!actual.isSymbolicLink(), 'Qualification census rejects symlinks.');
      if (actual.isDirectory()) {
        assert(['artifacts', 'artifacts/nested', 'dataset', 'control'].includes(local), `Unexpected fixture directory ${local}.`);
        directories += 1;
        await visit(local);
      } else {
        assert(actual.isFile(), 'Qualification census requires regular files.');
        if (/^(?:dataset\/[0-9]{5}\.bin|artifacts\/nested\/result\.bin)$/u.test(local)) dataFiles += 1;
        else assert(controlFiles.includes(local), `Unexpected fixture control ${local}.`);
        files += 1;
        payloadBytes += actual.size;
        allocatedBytes += actual.blocks * 512n;
      }
    }
  };
  await visit('');
  return { files, dataFiles, controlFiles: files - dataFiles, directories, payloadBytes, allocatedBytes };
}

export async function verifyPublishedDataset({ sourceManifest, guestManifest, directory, sinkManifest, signal }) {
  const guest = records(guestManifest, { signal })[Symbol.asyncIterator]();
  const sink = await open(sinkManifest, 'wx', 0o600);
  const digest = createHash('sha256');
  let files = 0;
  let payloadBytes = 0n;
  let allocatedBytes = 0n;
  let largestFileBytes = 0;
  let previous = '';
  try {
    for await (const input of records(sourceManifest, { signal })) {
      const expected = dataRecord(input);
      assert(expected.path > previous, 'Source manifest paths must be strictly ordered.');
      previous = expected.path;
      const observedGuest = await guest.next();
      assert(!observedGuest.done, 'Guest omitted a file.');
      assert.deepEqual(dataRecord(observedGuest.value), expected, `Guest content mismatch at ${expected.path}.`);
      const actual = await hashFile(join(directory, expected.path), { signal });
      assert.equal(actual.byteLength, expected.byteLength, `Sink length mismatch at ${expected.path}.`);
      assert.equal(actual.sha256, expected.sha256, `Sink content mismatch at ${expected.path}.`);
      assert(actual.allocatedBytes >= BigInt(actual.byteLength), 'Exported dataset contains sparse allocation.');
      const observedSink = { path: expected.path, byteLength: actual.byteLength, sha256: actual.sha256 };
      await writeRecord(sink, observedSink);
      digestRecord(digest, observedSink);
      files += 1;
      payloadBytes += BigInt(actual.byteLength);
      allocatedBytes += actual.allocatedBytes;
      largestFileBytes = Math.max(largestFileBytes, actual.byteLength);
    }
    assert.equal((await guest.next()).done, true, 'Guest emitted unexpected additional files.');
    return { files, payloadBytes, allocatedBytes, largestFileBytes, aggregateSha256: digest.digest('hex') };
  } finally { await Promise.all([guest.return(), sink.close()]); }
}
