// ------------------------------------------------------------------------------------------------
//                fixture.mjs - Checked borrowed scale fixture and independently owned small comparison
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { physicalDirectory } from '../scalability/configuration.mjs';
import { dataRecord, digestRecord, hashFile, records, writeRecord } from '../scalability/manifests.mjs';

export const artifactPath = 'artifacts/nested/result.bin';
export const archiveBudget = 8n * 1024n ** 2n;
export const manyPathCount = 513;

export async function verifyRetainedFixture(options) {
  await physicalDirectory(options.fixture);
  const identity = await lstat(options.fixture, { bigint: true });
  assert.equal(String(identity.dev), options.fixtureDevice, 'Retained fixture device changed.');
  assert.equal(String(identity.ino), options.fixtureInode, 'Retained fixture inode changed.');
  const manifestPath = join(options.fixture, 'control', 'source.jsonl');
  const manifest = await hashFile(manifestPath);
  assert.equal(manifest.sha256, options.fixtureManifestSha256, 'Retained source manifest changed.');
  const expectedReader = await hashFile(new URL('../scalability/guest.mjs', import.meta.url));
  assert.equal((await hashFile(join(options.fixture, 'control', 'guest.mjs'))).sha256, expectedReader.sha256, 'Retained independent reader changed.');
  let files = 0;
  let payloadBytes = 0n;
  let artifact;
  let previous = '';
  const digest = createHash('sha256');
  for await (const value of records(manifestPath)) {
    const entry = dataRecord(value);
    assert(entry.path > previous, 'Retained manifest must be uniquely ordered.');
    previous = entry.path;
    if (entry.path === artifactPath) artifact = entry;
    files += 1;
    payloadBytes += BigInt(entry.byteLength);
    digestRecord(digest, entry);
  }
  assert(artifact && artifact.byteLength === 4 * 1024 ** 2, 'Exact 4 MiB artifact required.');
  assert(files - 1 >= 25_000 && payloadBytes - BigInt(artifact.byteLength) >= 12n * 1024n ** 3n, 'Required unrelated workspace size/count not established.');
  return { directory: options.fixture, device: options.fixtureDevice, inode: options.fixtureInode, manifestPath,
    manifestSha256: manifest.sha256, files, payloadBytes: String(payloadBytes), aggregateSha256: digest.digest('hex'), artifact, borrowed: true };
}

export async function createSmallFixture(directory, retained) {
  for (const path of ['artifacts', 'artifacts/nested', 'dataset', 'control']) await mkdir(join(directory, path), { mode: 0o700 });
  const manifest = await open(join(directory, 'control', 'source.jsonl'), 'wx', 0o600);
  let files = 0;
  let payloadBytes = 0n;
  const digest = createHash('sha256');
  try {
    for await (const value of records(retained.manifestPath)) {
      const entry = dataRecord(value);
      if (entry.path !== artifactPath && entry.path !== 'dataset/00040.bin') continue;
      await copyFile(join(retained.directory, entry.path), join(directory, entry.path));
      const actual = await hashFile(join(directory, entry.path));
      assert.equal(actual.sha256, entry.sha256);
      await writeRecord(manifest, entry);
      digestRecord(digest, entry);
      files += 1;
      payloadBytes += BigInt(entry.byteLength);
      if (files === 2) break;
    }
  } finally { await manifest.close(); }
  assert.equal(files, 2);
  await copyFile(join(retained.directory, 'control', 'guest.mjs'), join(directory, 'control', 'guest.mjs'));
  return { directory, files, payloadBytes: String(payloadBytes), aggregateSha256: digest.digest('hex'), artifact: retained.artifact };
}

export async function* selectedSmallFiles(manifestPath) {
  let count = 0;
  for await (const value of records(manifestPath)) {
    const entry = dataRecord(value);
    if (!entry.path.startsWith('dataset/') || entry.byteLength > 64 * 1024) continue;
    yield entry;
    count += 1;
    if (count === manyPathCount) return;
  }
  assert.equal(count, manyPathCount, 'Retained manifest has insufficient small files.');
}
