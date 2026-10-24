// ------------------------------------------------------------------------------------------------
//                dataset.mjs - Real non-sparse mixed-size fixture generation with incremental hashes
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { copyFile, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkBytes, digestRecord, writeAll, writeRecord } from './manifests.mjs';

export function* datasetPlan() {
  yield { path: 'artifacts/nested/result.bin', byteLength: 4 * 1024 ** 2 };
  for (let index = 0; index < 25_001; index += 1) {
    const byteLength = index < 24 ? 512 * 1024 ** 2 : index < 40 ? (index - 7) * 1024 ** 2 : 1024 + (index * 73 % (63 * 1024));
    yield { path: `dataset/${String(index).padStart(5, '0')}.bin`, byteLength };
  }
}

export async function generateDataset({ directory, seed, plan, signal }) {
  await mkdir(join(directory, 'dataset'), { mode: 0o700 });
  await mkdir(join(directory, 'control'), { mode: 0o700 });
  await mkdir(join(directory, 'artifacts'), { mode: 0o700 });
  await mkdir(join(directory, 'artifacts', 'nested'), { mode: 0o700 });
  const manifestPath = join(directory, 'control', 'source.jsonl');
  const manifest = await open(manifestPath, 'wx', 0o600);
  const aggregate = createHash('sha256');
  const zeroes = Buffer.alloc(chunkBytes);
  const key = createHash('sha256').update(seed).digest();
  let files = 0;
  let payloadBytes = 0n;
  let allocatedBytes = 0n;
  let largestFileBytes = 0;
  let previous = '';
  try {
    for (const entry of plan) {
      signal?.throwIfAborted();
      assert(/^(?:dataset\/[0-9]{5}\.bin|artifacts\/nested\/result\.bin)$/u.test(entry.path) && entry.path > previous, 'Fixture paths must be unique and ordered.');
      assert(Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0 && entry.byteLength <= 512 * 1024 ** 2, 'Invalid fixture size.');
      previous = entry.path;
      const target = join(directory, entry.path);
      const file = await open(target, 'wx', 0o600);
      const hash = createHash('sha256');
      const cipher = createCipheriv('aes-256-ctr', key, createHash('sha256').update(entry.path).digest().subarray(0, 16));
      try {
        let remaining = entry.byteLength;
        while (remaining > 0) {
          signal?.throwIfAborted();
          const bytes = cipher.update(zeroes.subarray(0, Math.min(remaining, chunkBytes)));
          await writeAll(file, bytes);
          hash.update(bytes);
          remaining -= bytes.length;
        }
        assert.equal(cipher.final().length, 0);
        const actual = await file.stat({ bigint: true });
        assert(actual.isFile() && actual.size === BigInt(entry.byteLength) && actual.blocks * 512n >= actual.size, 'Fixture must have real allocated data.');
        allocatedBytes += actual.blocks * 512n;
      } finally { await file.close(); }
      const record = { ...entry, sha256: hash.digest('hex') };
      await writeRecord(manifest, record);
      digestRecord(aggregate, record);
      files += 1;
      payloadBytes += BigInt(entry.byteLength);
      largestFileBytes = Math.max(largestFileBytes, entry.byteLength);
    }
  } finally { await manifest.close(); }
  await copyFile(new URL('./guest.mjs', import.meta.url), join(directory, 'control', 'guest.mjs'));
  const controlBytes = BigInt((await stat(manifestPath)).size + (await stat(join(directory, 'control', 'guest.mjs'))).size);
  return { directory, manifestPath, files, payloadBytes, allocatedBytes, largestFileBytes,
    aggregateSha256: aggregate.digest('hex'), importFiles: files + 2, importPayloadBytes: payloadBytes + controlBytes };
}
