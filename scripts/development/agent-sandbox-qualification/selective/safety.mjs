// ------------------------------------------------------------------------------------------------
//                safety.mjs - Native selected-root rejection, provisional delivery and cancellation
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { checkTrace, consumeHash } from './cases.mjs';
import { artifactPath } from './fixture.mjs';

function causeContains(error, expected, depth = 0) {
  return error === expected || (depth < 5 && error instanceof Error && causeContains(error.cause, expected, depth + 1));
}

export async function rejectedPath({ sandbox, proxy, row, selection, finalPath, signal }) {
  let rejected;
  await assert.rejects(async () => sandbox.exportTree(selection, async () => assert.fail('Rejected symlink entered its sink.'), { signal }),
    (error) => { rejected = { name: error.name, code: error.code, message: error.message }; return error.code === 'driver_failure' && /without symlink traversal/u.test(error.message); });
  const parts = finalPath.split('/');
  const heads = ['/workspace', '/workspace/work'];
  for (let count = 1; count <= parts.length; count += 1) heads.push(`/workspace/work/${parts.slice(0, count).join('/')}`);
  const trace = await checkTrace(proxy, row, { gets: 0, headPaths: heads });
  return { rejected, trace };
}

export async function rejectedSubtree({ sandbox, proxy, row, root, signal }) {
  let files = 0;
  let rejected;
  await assert.rejects(async () => sandbox.exportTree({ kind: 'subtree', path: root }, async (entry) => {
    if (entry.kind === 'file') { await consumeHash(entry, signal); files += 1; }
  }, { signal }), (error) => { rejected = { name: error.name, code: error.code, message: error.message }; return error.code === 'driver_failure'; });
  const trace = await checkTrace(proxy, row, { gets: 1, getAllowed: (path) => path === `/workspace/work/${root}` });
  return { rejected, provisionalFiles: files, trace, acceptedOutput: false };
}

export async function failedSink({ sandbox, proxy, row, signal }) {
  const primary = new Error('Selected subtree sink deliberately failed after actual body entry.');
  let entered = false;
  await assert.rejects(async () => sandbox.exportTree({ kind: 'subtree', path: 'artifacts' }, async (entry) => {
    if (entry.kind !== 'file') return;
    for await (const chunk of entry.bytes) { assert(chunk.length > 0); entered = true; throw primary; }
  }, { signal }), (error) => causeContains(error, primary));
  assert(entered);
  const trace = await checkTrace(proxy, row, { gets: 1, getAllowed: (path) => path === '/workspace/work/artifacts' });
  return { expectedSinkFailure: primary.message, entered, trace, acceptedOutput: false };
}

export async function lateTrailer({ sandbox, owner, proxy, row, expected, signal }) {
  const accessor = owner.recoveryRecord.resources.find((entry) => entry.role === 'export');
  const target = `/v1.52/containers/${accessor.identity.id}/archive?path=${encodeURIComponent('/workspace/work/artifacts')}`;
  proxy.arm({ method: 'GET', target, kind: 'late-trailer' });
  let observed;
  let rejected;
  await assert.rejects(async () => sandbox.exportTree({ kind: 'subtree', path: 'artifacts' }, async (entry) => {
    if (entry.kind === 'file') observed = await consumeHash(entry, signal);
  }, { signal }), (error) => { rejected = { name: error.name, code: error.code, message: error.message }; return error.code === 'driver_failure'; });
  assert.deepEqual(observed, expected, 'The late framing fault must follow complete provisional file delivery.');
  const trace = await checkTrace(proxy, row, { gets: 1, getAllowed: (path) => path === '/workspace/work/artifacts' });
  return { rejected, provisional: observed, acceptedOutput: false, trace };
}

export async function stalledRead({ sandbox, owner, proxy, row, signal }) {
  const accessor = owner.recoveryRecord.resources.find((entry) => entry.role === 'export');
  const target = `/v1.52/containers/${accessor.identity.id}/archive?path=${encodeURIComponent('/workspace/work/artifacts')}`;
  const entered = proxy.arm({ method: 'GET', target, kind: 'stall' });
  const cancellation = new AbortController();
  let timer;
  const timing = entered.then(() => { timer = setTimeout(() => cancellation.abort(new Error('Selected response body deliberately stalled.')), 100); });
  let rejected;
  try {
    await assert.rejects(async () => sandbox.exportTree({ kind: 'subtree', path: 'artifacts' }, async () => assert.fail('Stalled body entered a consumer.'), {
      signal: AbortSignal.any([signal, cancellation.signal]),
    }), (error) => { rejected = { name: error.name, code: error.code, message: error.message }; return error.code === 'cancelled'; });
    await timing;
  } finally { clearTimeout(timer); }
  const trace = await checkTrace(proxy, row, { gets: 1, getAllowed: (path) => path === '/workspace/work/artifacts' });
  return { rejected, trace, bodyStallAfterHeaders: true, acceptedOutput: false };
}

export const symlinkRows = [
  { id: 'ancestor-link', selection: { kind: 'files', paths: ['safety/ancestor/nested/result.bin'] }, finalPath: 'safety/ancestor' },
  { id: 'final-link', selection: { kind: 'files', paths: ['safety/final.bin'] }, finalPath: 'safety/final.bin' },
  { id: 'subtree-root-link', selection: { kind: 'subtree', path: 'safety/root-link' }, finalPath: 'safety/root-link' },
];

export function assertComparison(small, large) {
  assert.deepEqual(small.observed, large.observed);
  assert.equal(small.observed.path, artifactPath);
  assert.equal(small.summary.payloadBytes, large.summary.payloadBytes);
  assert.equal(small.summary.archiveBytes, large.summary.archiveBytes, 'Unrelated workspace growth increased the selected archive body.');
  assert.equal(small.trace.archiveHeads, large.trace.archiveHeads);
  assert.equal(small.trace.archiveGets, large.trace.archiveGets);
}
