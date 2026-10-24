// ------------------------------------------------------------------------------------------------
//                controller.mjs - Installed selective export comparison and scoped native safety rows
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { failure } from '../scalability/configuration.mjs';
import { createTraceProxy } from './proxy/index.mjs';
import { createSmallFixture, verifyRetainedFixture } from './fixture.mjs';
import { artifactCase, manyCase, rejectSelection, subtreeCase } from './cases.mjs';
import { assertComparison, failedSink, lateTrailer, rejectedPath, rejectedSubtree, stalledRead, symlinkRows } from './safety.mjs';
import { withWorkspace } from './owner.mjs';

assert.equal(process.argv.length, 3);
assert((await lstat(process.argv[2])).size <= 32 * 1024);
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error('Selective qualification interrupted.'));
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
let phase = 'opening';
process.on('message', (message) => {
  if (message?.kind === 'memory' && Number.isSafeInteger(message.id) && process.connected) {
    process.send({ kind: 'memory', id: message.id, pid: process.pid, phase, memory: process.memoryUsage() });
  }
});
const report = { format: 'agenai.sandbox-selective-export.v1', status: 'running', startedAt: new Date().toISOString(),
  controller: { pid: process.pid, node: process.version, platform: process.platform, architecture: process.arch }, endpoint: options.endpoint,
  namespace: `selected-${randomUUID()}`, imageDigest: options.imageDigest, sourceEvidence: options.sourceEvidence,
  tracePath: join(options.output, 'engine-requests.jsonl'), primaryFailure: null, cleanupFailures: [], rows: [], workspaces: [],
  credentialReads: 0, modelCalls: 0, retainedSourceBorrowed: true, retainedSourceRemoved: false };
const encode = (value) => `${JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2)}\n`;
const checkpoint = async () => { const path = join(options.output, 'report.json'); await writeFile(`${path}.next`, encode(report), { mode: 0o600 }); await rename(`${path}.next`, path); };
let proxy;
let smallFixture;
let smallIdentity;
let publishedIdentity;
let smallArtifact;
let largeArtifact;
const publishedNamespace = join(options.output, 'published-subtree');

async function runRow(id, perform) {
  phase = id; proxy.setRow(id);
  const row = { id, status: 'running', primaryFailure: null, details: null };
  report.rows.push(row);
  try { row.details = await perform(); row.status = 'passed'; }
  catch (error) { row.primaryFailure = failure(error); row.status = 'failed'; throw error; }
  finally { await checkpoint(); }
  return row.details;
}

try {
  await checkpoint();
  report.retainedFixture = await verifyRetainedFixture(options);
  const smallRoot = join(options.output, 'small-fixture');
  await mkdir(smallRoot, { mode: 0o700 });
  smallIdentity = await lstat(smallRoot, { bigint: true });
  smallFixture = await createSmallFixture(smallRoot, report.retainedFixture);
  proxy = await createTraceProxy({ socketPath: join(options.output, 'engine-trace.sock'), upstreamEndpoint: options.endpoint, tracePath: report.tracePath });
  const backend = createDockerSandboxBackend({ endpoint: proxy.endpoint, namespace: report.namespace, imageDigest: options.imageDigest,
    spillDirectory: options.output, user: { uid: 65534, gid: 65534 } });
  const claimPublishedNamespace = async (path) => { assert.equal(path, publishedNamespace); publishedIdentity = await lstat(path, { bigint: true }); };
  const context = { backend, options, proxy, report, checkpoint, signal: cancellation.signal, claimPublishedNamespace,
    setPhase: (value) => { phase = value; } };
  await withWorkspace({ ...context, id: 'small', fixture: smallFixture }, async ({ sandbox, owner, evidence }) => {
    const base = { sandbox, owner, proxy, signal: cancellation.signal, expected: report.retainedFixture.artifact };
    smallArtifact = await runRow('small-artifact', () => artifactCase({ ...base, row: 'small-artifact' }));
    const subtree = await runRow('selected-subtree', () => subtreeCase({ ...base, row: 'selected-subtree', directory: publishedNamespace,
      onPublished: () => claimPublishedNamespace(publishedNamespace) }));
    assert.equal(subtree.observed.path, report.retainedFixture.artifact.path);
    await runRow('duplicate-path', () => rejectSelection({ ...base, row: 'duplicate-path', kind: 'duplicate' }));
    await runRow('file-prefix-overlap', () => rejectSelection({ ...base, row: 'file-prefix-overlap', kind: 'prefix' }));
    for (const row of symlinkRows) await runRow(row.id, () => rejectedPath({ ...base, ...row, row: row.id }));
    for (const [id, root] of [['subtree-link', 'safety/subtree-link'], ['subtree-fifo', 'safety/subtree-fifo']]) {
      await runRow(id, () => rejectedSubtree({ ...base, row: id, root }));
    }
    await runRow('subtree-sink-failure', () => failedSink({ ...base, row: 'subtree-sink-failure' }));
    await runRow('subtree-late-trailer', () => lateTrailer({ ...base, row: 'subtree-late-trailer' }));
    await runRow('subtree-stalled-cancel', () => stalledRead({ ...base, row: 'subtree-stalled-cancel' }));
    const accessor = owner.recoveryRecord.resources.find((resource) => resource.role === 'export');
    assert.equal(accessor.identity.kind, 'identified');
    proxy.setRow('uncertain-cleanup');
    proxy.arm({ method: 'DELETE', target: `/v1.52/containers/${accessor.identity.id}?force=true&v=false`, kind: 'drop-response' });
    evidence.expectCleanupAcknowledgementLoss = true;
  });
  await withWorkspace({ ...context, id: 'large', fixture: report.retainedFixture }, async ({ sandbox, owner, directory }) => {
    const base = { sandbox, owner, proxy, signal: cancellation.signal, expected: report.retainedFixture.artifact };
    largeArtifact = await runRow('large-artifact', () => artifactCase({ ...base, row: 'large-artifact' }));
    await runRow('many-exact-paths', () => manyCase({ ...base, row: 'many-exact-paths', manifestPath: report.retainedFixture.manifestPath,
      directory: join(directory, 'many-observations') }));
  });
  assertComparison(smallArtifact, largeArtifact);
  report.comparison = { passed: true, sameArtifactDepthAndDigest: true, equalArchiveBytes: true, noWorkspaceRootGet: true,
    ioEvidenceScope: 'Exact HTTP targets/body counts plus the separately pinned daemon traversal call path; no kernel syscall trace.' };
  await verifyRetainedFixture(options);
} catch (error) { report.primaryFailure = failure(error); }
finally {
  phase = 'cleanup';
  if (proxy) { try { await proxy.close(); report.traceEndpointRemoved = true; } catch (error) { report.cleanupFailures.push(failure(error)); } }
  for (const [path, identity] of [[publishedNamespace, publishedIdentity], [join(options.output, 'small-fixture'), smallIdentity]]) {
    try {
      if (!identity) { await assert.rejects(lstat(path), { code: 'ENOENT' }); continue; }
      const current = await lstat(path, { bigint: true });
      assert(current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino, 'Owned local output identity changed; preserved.');
      await rm(path, { recursive: true }); await assert.rejects(lstat(path), { code: 'ENOENT' });
    } catch (error) { report.cleanupFailures.push(failure(error)); }
  }
  report.status = report.primaryFailure || report.cleanupFailures.length ? 'failed' : 'passed';
  report.finishedAt = new Date().toISOString();
  await checkpoint();
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  if (process.connected) process.disconnect();
}
process.stdout.write(`${JSON.stringify({ status: report.status, report: join(options.output, 'report.json') })}\n`);
if (report.status !== 'passed') process.exitCode = 1;
