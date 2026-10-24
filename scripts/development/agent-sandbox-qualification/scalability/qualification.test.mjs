// ------------------------------------------------------------------------------------------------
//                qualification.test.mjs - Scale evidence admission and complete-content regressions
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseArguments } from './configuration.mjs';
import { datasetPlan, generateDataset } from './dataset.mjs';
import { censusDirectory, chunkBytes, records, verifyPublishedDataset } from './manifests.mjs';

const execute = promisify(execFile);
const image = `sha256:${'a'.repeat(64)}`;
const args = ['--engine', 'unix:///var/run/docker.sock', '--output', '/var/tmp/new-scale-run', '--consumer', '/var/tmp/installed-consumer',
  '--image', image, '--rss-budget-mib', '1024', '--external-budget-mib', '256'];

test('qualification requires explicit endpoint, image, fresh-root selection and representable memory budgets', () => {
  assert.deepEqual(parseArguments(args), { endpoint: 'unix:///var/run/docker.sock', output: '/var/tmp/new-scale-run',
    consumer: '/var/tmp/installed-consumer', image, prepare: false, retainSource: false,
    budgets: { rssBytes: 1024 ** 3, externalBytes: 256 * 1024 ** 2 } });
  assert.deepEqual(parseArguments(args.slice(0, 8)).budgets, { rssBytes: 1024 ** 3, externalBytes: 256 * 1024 ** 2 });
  for (const invalid of [args.slice(2), [...args, '--prepare-source-image', image], [...args.slice(0, -1), '0'],
    [...args.slice(0, -1), '9007199254740991'], args.map((value) => value === 'unix:///var/run/docker.sock' ? 'tcp://localhost:2375' : value),
    args.map((value) => value === '/var/tmp/new-scale-run' ? '/var/tmp/../other' : value), [...args, '--credential', '/secret']]) {
    assert.throws(() => parseArguments(invalid));
  }
});

test('the physical qualification profile exceeds aggregate/count gates and includes a bounded stable artifact', () => {
  let count = 0;
  let total = 0n;
  let largest = 0;
  let above16MiB = 0;
  let previous = '';
  for (const entry of datasetPlan()) {
    assert(entry.path > previous);
    previous = entry.path;
    count += 1;
    total += BigInt(entry.byteLength);
    largest = Math.max(largest, entry.byteLength);
    if (entry.byteLength > 16 * 1024 ** 2) above16MiB += 1;
    if (count === 1) assert.deepEqual(entry, { path: 'artifacts/nested/result.bin', byteLength: 4 * 1024 ** 2 });
  }
  assert.equal(count, 25_002);
  assert(total > 12n * 1024n ** 3n && total < 14n * 1024n ** 3n);
  assert.equal(largest, 512 * 1024 ** 2);
  assert.equal(above16MiB, 40);
});

async function fixture(t) {
  const root = await mkdtemp('/var/tmp/sandbox-scale-tooling-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'source');
  await mkdir(directory);
  const plan = [{ path: 'artifacts/nested/result.bin', byteLength: chunkBytes + 17 },
    { path: 'dataset/00000.bin', byteLength: 3 }, { path: 'dataset/00001.bin', byteLength: chunkBytes * 2 + 9 }];
  const generated = await generateDataset({ directory, seed: 'hermetic-independent-content-proof', plan });
  return { root, directory, plan, generated };
}

async function guest(directory) {
  return execute(process.execPath, [join(directory, 'control', 'guest.mjs'), directory], { timeout: 10_000,
    maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
}

test('producer, real guest and published sink independently hash every byte without manifest-order assumptions', async (t) => {
  const { root, directory, generated } = await fixture(t);
  const observed = JSON.parse((await guest(directory)).stdout);
  assert.equal(observed.files, 3);
  assert.equal(observed.aggregateSha256, generated.aggregateSha256);
  assert.equal(observed.payloadBytes, String(generated.payloadBytes));
  assert.equal(observed.census.files, 6);
  assert.equal(observed.census.controlFiles, 3);
  for await (const entry of records(generated.manifestPath)) {
    const bytes = await readFile(join(directory, entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(bytes.length, entry.byteLength);
    assert(bytes.some((value) => value !== 0), 'The generator must write actual varying content.');
  }
  const destination = join(root, 'published');
  await cp(directory, destination, { recursive: true, errorOnExist: true, force: false });
  const verified = await verifyPublishedDataset({ sourceManifest: generated.manifestPath,
    guestManifest: join(destination, 'control', 'guest.jsonl'), directory: destination, sinkManifest: join(root, 'sink.jsonl') });
  assert.equal(verified.files, 3);
  assert.equal(verified.aggregateSha256, generated.aggregateSha256);
  assert.equal(verified.payloadBytes, generated.payloadBytes);
  assert(verified.allocatedBytes >= verified.payloadBytes);
  const census = await censusDirectory(destination, { controlFiles: ['control/source.jsonl', 'control/guest.mjs', 'control/guest.jsonl'] });
  assert.equal(census.files, 6);
  assert.equal(census.dataFiles, 3);
  assert.equal(census.directories, 4);
});

test('guest census rejects an unexpected real file omitted from otherwise valid source hashes', async (t) => {
  const { directory } = await fixture(t);
  await writeFile(join(directory, 'dataset', '99999.bin'), new Uint8Array([42]), { flag: 'wx' });
  await assert.rejects(guest(directory), (error) => error.code === 1 && /4 !== 3/u.test(error.stderr));
});

test('sink verification rejects content corruption despite matching declared size and manifest counts', async (t) => {
  const { root, directory, generated } = await fixture(t);
  await guest(directory);
  await writeFile(join(directory, 'dataset', '00000.bin'), new Uint8Array([1, 2, 3]));
  await assert.rejects(verifyPublishedDataset({ sourceManifest: generated.manifestPath,
    guestManifest: join(directory, 'control', 'guest.jsonl'), directory, sinkManifest: join(root, 'sink.jsonl') }), /Sink content mismatch/u);
});

test('manifest reader rejects malformed late framing and a record exceeding its bounded envelope', async (t) => {
  const root = await mkdtemp('/var/tmp/sandbox-scale-manifest-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = join(root, 'records.jsonl');
  await writeFile(manifest, '{"ok":true}\n{"late":true}');
  const iterator = records(manifest)[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { ok: true });
  await assert.rejects(iterator.next(), /final newline/u);
  await writeFile(manifest, `"${'x'.repeat(4096)}"\n`);
  await assert.rejects(async () => { for await (const entry of records(manifest)) assert.fail(JSON.stringify(entry)); }, /record length/u);
});
