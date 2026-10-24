// ------------------------------------------------------------------------------------------------
//                cases.mjs - Selected content, request-path and adversarial subtree observations
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportSandboxDirectory } from '@agen-ai/sandbox/node';
import { digestRecord, hashFile, records, writeRecord } from '../scalability/manifests.mjs';
import { archiveBudget, artifactPath, manyPathCount, selectedSmallFiles } from './fixture.mjs';

export async function consumeHash(entry, signal) {
  assert.equal(entry.kind, 'file');
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of entry.bytes) { signal?.throwIfAborted(); assert(chunk.length <= 64 * 1024); hash.update(chunk); byteLength += chunk.length; }
  assert.equal(byteLength, entry.byteLength);
  return { path: entry.path, byteLength, sha256: hash.digest('hex') };
}

export async function checkTrace(proxy, row, { gets, headPaths, getAllowed }) {
  await proxy.idle();
  let getCount = 0;
  let headCount = 0;
  for await (const request of records(proxy.tracePath)) {
    if (request.row !== row || request.archivePath === null) continue;
    assert(['HEAD', 'GET'].includes(request.method), 'Export rows cannot upload workspace data.');
    if (request.method === 'GET') {
      assert(!['/workspace', '/workspace/work', '/workspace/', '/workspace/work/'].includes(request.archivePath), 'Selection attempted a workspace-root scan.');
      if (getAllowed) assert(getAllowed(request.archivePath), `Unexpected selected GET ${request.archivePath}.`);
      getCount += 1;
    } else {
      assert(!request.archivePath.endsWith('/'), 'Ancestor HEAD must omit trailing slash.');
      if (headPaths) assert.equal(request.archivePath, headPaths[headCount], 'Unexpected ancestor HEAD sequence.');
      headCount += 1;
    }
  }
  assert.equal(getCount, gets);
  if (headPaths) assert.equal(headCount, headPaths.length);
  const summary = proxy.summary(row);
  assert.equal(summary.rootArchiveGets, 0);
  return summary;
}

export async function artifactCase({ sandbox, proxy, row, expected, signal }) {
  let observed;
  const summary = await sandbox.exportTree({ kind: 'files', paths: [artifactPath] }, async (entry) => {
    assert.equal(observed, undefined, 'Exact selection returned multiple entries.');
    observed = await consumeHash(entry, signal);
  }, { signal });
  assert.deepEqual(observed, expected);
  assert.equal(summary.files, 1n); assert.equal(summary.directories, 0n); assert.equal(summary.payloadBytes, 4n * 1024n ** 2n);
  assert(summary.archiveBytes <= archiveBudget);
  const trace = await checkTrace(proxy, row, { gets: 1, getAllowed: (path) => path === `/workspace/work/${artifactPath}`,
    headPaths: ['/workspace', '/workspace/work', '/workspace/work/artifacts', '/workspace/work/artifacts/nested', `/workspace/work/${artifactPath}`] });
  assert.equal(trace.archiveBytes, summary.archiveBytes);
  return { summary, observed, trace, archiveBudgetBytes: archiveBudget };
}

export async function subtreeCase({ sandbox, proxy, row, expected, directory, signal, onPublished }) {
  const exported = await exportSandboxDirectory(sandbox, { kind: 'subtree', path: 'artifacts' }, directory, { signal });
  await onPublished();
  const actual = await hashFile(join(exported.directory, artifactPath), { signal });
  assert.equal(actual.sha256, expected.sha256); assert.equal(actual.byteLength, expected.byteLength);
  assert.equal(exported.summary.files, 1n); assert.equal(exported.summary.directories, 2n);
  assert.equal(exported.summary.payloadBytes, 4n * 1024n ** 2n);
  assert(exported.summary.archiveBytes <= archiveBudget);
  const trace = await checkTrace(proxy, row, { gets: 1, getAllowed: (path) => path === '/workspace/work/artifacts',
    headPaths: ['/workspace', '/workspace/work', '/workspace/work/artifacts'] });
  assert.equal(trace.archiveBytes, exported.summary.archiveBytes);
  return { directory: exported.directory, summary: exported.summary, observed: { path: artifactPath, byteLength: actual.byteLength, sha256: actual.sha256 }, trace };
}

export async function manyCase({ sandbox, proxy, row, manifestPath, directory, signal }) {
  await mkdir(directory, { mode: 0o700 });
  const markers = join(directory, 'digests');
  await mkdir(markers, { mode: 0o700 });
  const paths = async function* () { for await (const entry of selectedSmallFiles(manifestPath)) yield entry.path; };
  let files = 0;
  let payloadBytes = 0n;
  const summary = await sandbox.exportTree({ kind: 'files', paths: paths() }, async (entry) => {
    assert(/^dataset\/[0-9]{5}\.bin$/u.test(entry.path));
    const observed = await consumeHash(entry, signal);
    await writeFile(join(markers, `${entry.path.slice(8)}.json`), JSON.stringify(observed), { flag: 'wx', mode: 0o600 });
    files += 1; payloadBytes += BigInt(observed.byteLength);
  }, { signal });
  assert.equal(files, manyPathCount); assert.equal(summary.files, BigInt(files)); assert.equal(summary.payloadBytes, payloadBytes);
  const manifest = await open(join(directory, 'verified-manifest.jsonl'), 'wx', 0o600);
  const digest = createHash('sha256');
  try {
    for await (const expected of selectedSmallFiles(manifestPath)) {
      const observed = JSON.parse(await readFile(join(markers, `${expected.path.slice(8)}.json`), 'utf8'));
      assert.deepEqual(observed, expected);
      await writeRecord(manifest, observed); digestRecord(digest, observed);
    }
  } finally { await manifest.close(); }
  const trace = await checkTrace(proxy, row, { gets: manyPathCount, getAllowed: (path) => /^\/workspace\/work\/dataset\/[0-9]{5}\.bin$/u.test(path) });
  assert.equal(trace.archiveBytes, summary.archiveBytes);
  assert.equal(trace.archiveHeads, manyPathCount * 4);
  return { selectedPaths: manyPathCount, files, payloadBytes, aggregateSha256: digest.digest('hex'), summary, trace,
    comparison: 'One per-file digest marker on disk; complete source/observed records compared incrementally.' };
}

export async function rejectSelection({ sandbox, proxy, row, kind, signal }) {
  let sourceJoined = false;
  const paths = async function* () {
    try { yield artifactPath; yield kind === 'duplicate' ? artifactPath : `${artifactPath}/child`; }
    finally { sourceJoined = true; }
  };
  let rejected;
  await assert.rejects(async () => sandbox.exportTree({ kind: 'files', paths: paths() }, async () => assert.fail('Rejected selection entered its sink.'), { signal }),
    (error) => { rejected = { name: error.name, code: error.code, message: error.message }; return error.code === (kind === 'duplicate' ? 'duplicate_path' : 'file_ancestor'); });
  assert(sourceJoined);
  const trace = await checkTrace(proxy, row, { gets: 0, headPaths: [] });
  return { rejected, sourceJoined, trace };
}
