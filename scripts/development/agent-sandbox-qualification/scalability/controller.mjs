// ------------------------------------------------------------------------------------------------
//                controller.mjs - Installed SDK large-workspace owner and independent content checks
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileFromBytes, parseSandboxRequest, SANDBOX_DEFAULT_TRANSFER_BUFFERS, SANDBOX_DEFAULT_STREAM_LIMITS } from '@agen-ai/sandbox';
import { importSandboxDirectory, exportSandboxDirectory, SandboxDirectoryCleanupError } from '@agen-ai/sandbox/node';
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { failure } from './configuration.mjs';
import { datasetPlan, generateDataset } from './dataset.mjs';
import { censusDirectory, hashFile, verifyPublishedDataset } from './manifests.mjs';
import { engineControl, observeAbsent } from './resources.mjs';

assert.equal(process.argv.length, 3, 'Explicit launcher configuration required.');
assert((await lstat(process.argv[2])).size <= 16 * 1024, 'Bounded launcher configuration required.');
const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error('Large-workspace qualification interrupted.'));
process.on('SIGTERM', interrupt);
process.on('SIGINT', interrupt);
let phase = 'opening';
process.on('message', (message) => {
  if (message?.kind === 'memory' && Number.isSafeInteger(message.id) && process.connected) {
    process.send({ kind: 'memory', id: message.id, pid: process.pid, phase, memory: process.memoryUsage() });
  }
});

const report = { format: 'agenai.sandbox-large-workspace.v1', status: 'running', startedAt: new Date().toISOString(),
  controller: { pid: process.pid, node: process.version, platform: process.platform, architecture: process.arch },
  namespace: `scale-${randomUUID()}`, endpoint: options.endpoint, imageDigest: options.imageDigest,
  transferBuffers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, transferLogicalQuotas: null, requestPolicy: request().policy,
  credentialReads: 0, modelCalls: 0,
  primaryFailure: null, cleanupFailures: [], evidenceFailures: [], runs: [], sourceRetained: false,
  source: null, sink: null, guest: null, artifactPath: 'artifacts/nested/result.bin' };
const stringify = (value) => `${JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? String(entry) : entry, 2)}\n`;
const atomicJson = async (destination, value) => {
  await writeFile(`${destination}.next`, stringify(value), { mode: 0o600 });
  await rename(`${destination}.next`, destination);
};
const checkpoint = () => atomicJson(join(options.output, 'report.json'), report);
const sourceDirectory = join(options.output, 'source-fixture');
const exportNamespace = join(options.output, 'export-destination');
const ownedRoots = new Map();
let guestReaders;

async function remember(path) {
  const entry = await lstat(path, { bigint: true });
  assert(entry.isDirectory() && !entry.isSymbolicLink());
  ownedRoots.set(path, { dev: entry.dev, ino: entry.ino });
}

async function removeOwned(path) {
  const expected = ownedRoots.get(path);
  if (!expected) {
    await assert.rejects(lstat(path), { code: 'ENOENT' }, 'Unclaimed qualification directory remains; preserve it for exact recovery.');
    return;
  }
  const entry = await lstat(path, { bigint: true });
  assert(entry.isDirectory() && !entry.isSymbolicLink() && entry.dev === expected.dev && entry.ino === expected.ino, 'Owned qualification directory identity changed; preserved.');
  await rm(path, { recursive: true });
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  ownedRoots.delete(path);
}

function request() {
  return parseSandboxRequest({ policy: {
    resources: { cpus: 2, memoryBytes: 1024 ** 3, pids: 128 },
    temporaryStorage: { homeBytes: 32 * 1024 ** 2, tempBytes: 32 * 1024 ** 2 }, network: { kind: 'isolated' },
    execution: { kind: 'until_stopped' }, deadlines: { startupMs: 60_000, cleanupMs: 30_000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: { ...SANDBOX_DEFAULT_STREAM_LIMITS, maxOutputBytes: 64 * 1024 },
  } });
}

const backend = createDockerSandboxBackend({ endpoint: options.endpoint, namespace: report.namespace,
  imageDigest: options.imageDigest, user: { uid: 65534, gid: 65534 }, spillDirectory: options.output });

async function boundedOutput(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    assert(length <= 16 * 1024, 'Guest evidence output exceeded its envelope.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runOwned(id, action) {
  const directory = join(options.output, id);
  await mkdir(directory, { mode: 0o700 });
  const evidence = { id, status: 'running', recoveryPath: join(directory, 'recovery.json'), observations: [],
    primaryFailure: null, cleanupFailures: [], details: {} };
  report.runs.push(evidence);
  const owner = backend.reserve(request(), { kind: 'persisted', persist: (record) => atomicJson(evidence.recoveryPath, record) });
  await checkpoint();
  let primary;
  try {
    const sandbox = await owner.start({ signal: cancellation.signal });
    await action(sandbox, owner, evidence);
  } catch (error) {
    primary = error;
    evidence.primaryFailure = failure(error);
    if (error instanceof SandboxDirectoryCleanupError) {
      evidence.details.directoryCleanup = { directory: error.directory, publishedDirectory: error.publishedDirectory ?? null,
        originalFailurePreserved: true };
      try {
        await error.retryCleanup();
        evidence.details.directoryCleanup.retry = 'settled';
        if (error.directory === exportNamespace && error.publishedDirectory === join(exportNamespace, 'files')) await remember(exportNamespace);
      }
      catch (cleanupError) { evidence.cleanupFailures.push(failure(cleanupError)); evidence.details.directoryCleanup.retry = 'failed'; }
    }
  }
  finally {
    try { await owner.destroy(); }
    catch (error) { evidence.cleanupFailures.push(failure(error)); }
    if (id === 'baseline' && guestReaders) {
      for (const result of await guestReaders) {
        if (result.status === 'rejected' && result.reason !== primary) evidence.cleanupFailures.push(failure(result.reason));
      }
      guestReaders = undefined;
    }
    evidence.recoveryRecord = owner.recoveryRecord;
    try { evidence.observations.push(...await observeAbsent(options.endpoint, owner.recoveryRecord, 'after-destroy')); }
    catch (error) { evidence.cleanupFailures.push(failure(error)); }
    evidence.status = evidence.primaryFailure !== null || evidence.cleanupFailures.length ? 'failed' : 'passed';
    await checkpoint();
  }
  if (evidence.status !== 'passed') throw new AggregateError([...(evidence.primaryFailure === null ? [] : [primary]), ...evidence.cleanupFailures], `Owned ${id} qualification failed.`);
}

async function baseline() {
  await runOwned('baseline', async (sandbox, owner, evidence) => {
    phase = 'import';
    evidence.details.import = await importSandboxDirectory(sandbox, sourceDirectory, { signal: cancellation.signal });
    assert.equal(evidence.details.import.files, BigInt(report.source.importFiles));
    assert.equal(evidence.details.import.payloadBytes, report.source.importPayloadBytes);
    const volume = owner.recoveryRecord.resources.find((entry) => entry.role === 'storage');
    assert(volume?.identity.kind === 'identified', 'Owned storage identity required.');
    const actualVolume = (await engineControl(options.endpoint, 'GET', `/volumes/${encodeURIComponent(volume.identity.id)}`)).value;
    assert.equal(actualVolume.Driver, 'local');
    assert.equal(Object.keys(actualVolume.Options ?? {}).length, 0, 'Qualification requires default disk-backed local volume options.');
    evidence.details.storage = { id: volume.identity.id, driver: actualVolume.Driver, options: actualVolume.Options,
      mountpoint: actualVolume.Mountpoint, memoryBackedFixture: false,
      hostVolumeMountpointInspection: 'Not performed; Docker-owned volume internals are not host-readable by this unprivileged controller.',
      allocationFilesystemObservation: 'Guest statfs of the actual owned workspace; host DockerRootDir statfs recorded by launcher.' };
    phase = 'guest-hash';
    const processOwner = sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: ['control/guest.mjs', sandbox.workspace], cwd: sandbox.workspace,
      env: { HOME: '/home/sandbox', TMPDIR: '/tmp', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } });
    const streams = await processOwner.start({ signal: cancellation.signal });
    streams.stdin.end();
    const output = [boundedOutput(streams.stdout), boundedOutput(streams.stderr), streams.exit];
    guestReaders = Promise.allSettled(output);
    const [out, err, exit] = await Promise.all(output);
    assert.deepEqual(exit, { kind: 'exited', code: 0 }, `Guest hash failed: ${err}`);
    assert.equal(err, '');
    report.guest = JSON.parse(out);
    assert.equal(report.guest.node, 'v24.18.0');
    assert.equal(report.guest.files, report.source.files);
    assert.equal(report.guest.payloadBytes, String(report.source.payloadBytes));
    assert.equal(report.guest.aggregateSha256, report.source.aggregateSha256);
    assert.equal(report.guest.largestFileBytes, report.source.largestFileBytes);
    assert(BigInt(report.guest.allocatedBytes) >= report.source.payloadBytes);
    phase = 'stop-compute';
    await sandbox.stop();
    evidence.observations.push(...await observeAbsent(options.endpoint, owner.recoveryRecord, 'before-export', ['compute']));
    phase = 'export';
    const exported = await exportSandboxDirectory(sandbox, { kind: 'workspace' }, exportNamespace, { signal: cancellation.signal });
    await remember(exportNamespace);
    evidence.details.export = exported.summary;
    evidence.details.publishedDirectory = exported.directory;
    assert.equal(exported.summary.files, BigInt(report.source.files + 3));
    assert.equal(exported.summary.files, BigInt(report.guest.census.files));
    assert.equal(exported.summary.directories, BigInt(report.guest.census.directories));
    assert.equal(exported.summary.payloadBytes, BigInt(report.guest.census.payloadBytes));
    await copyFile(join(exported.directory, 'control', 'guest.jsonl'), join(options.output, 'guest-manifest.jsonl'));
    phase = 'sink-hash';
    report.sink = await verifyPublishedDataset({ sourceManifest: report.source.manifestPath,
      guestManifest: join(options.output, 'guest-manifest.jsonl'), directory: exported.directory,
      sinkManifest: join(options.output, 'sink-manifest.jsonl'), signal: cancellation.signal });
    assert.equal(report.sink.aggregateSha256, report.source.aggregateSha256);
    assert.equal(report.sink.files, report.source.files);
    const controls = [];
    for (const name of ['source.jsonl', 'guest.mjs', 'guest.jsonl']) {
      const actual = await hashFile(join(exported.directory, 'control', name), { signal: cancellation.signal });
      if (name !== 'guest.jsonl') {
        const expected = await hashFile(join(sourceDirectory, 'control', name), { signal: cancellation.signal });
        assert.equal(actual.sha256, expected.sha256);
        assert.equal(actual.byteLength, expected.byteLength);
      }
      controls.push({ path: `control/${name}`, ...actual });
    }
    report.sink.controls = controls;
    report.sink.fullPayloadBytes = report.sink.payloadBytes + controls.reduce((sum, entry) => sum + BigInt(entry.byteLength), 0n);
    report.sink.census = await censusDirectory(exported.directory, { controlFiles: controls.map((entry) => entry.path), signal: cancellation.signal });
    assert.equal(report.sink.census.dataFiles, report.source.files);
    assert.equal(report.sink.census.controlFiles, 3);
    assert.equal(report.sink.census.directories, 4);
    assert.equal(BigInt(report.sink.census.files), exported.summary.files);
    assert.equal(BigInt(report.sink.census.directories), exported.summary.directories);
    assert.equal(report.sink.census.payloadBytes, exported.summary.payloadBytes);
    assert.equal(exported.summary.payloadBytes, report.sink.fullPayloadBytes, 'All exported payload bytes must have independent sink hashes.');
    assert(exported.summary.archiveBytes > exported.summary.payloadBytes);
    assert(evidence.details.import.archiveBytes > evidence.details.import.payloadBytes);
    await checkpoint();
  });
}

async function quotaRejection() {
  await runOwned('caller-quota', async (sandbox, owner, evidence) => {
    phase = 'caller-quota';
    evidence.details.quotas = { maxTotalBytes: 1024 };
    await assert.rejects(importSandboxDirectory(sandbox, sourceDirectory, {
      signal: cancellation.signal, quotas: evidence.details.quotas,
    }), (error) => {
      assert.equal(error.code, 'input_limit');
      evidence.details.expectedRejection = failure(error);
      return true;
    });
    assert(['failed', 'uncertain', 'stopped'].includes(sandbox.state.kind), 'Rejected import must fence execution.');
    assert.throws(() => sandbox.reserveProcess({ executable: '/usr/local/bin/node', args: ['--version'], cwd: sandbox.workspace, env: {} }),
      { name: 'SandboxStateError' });
    assert.throws(() => sandbox.importTree([fileFromBytes('must-not-replay.txt', new Uint8Array([1]))]), { name: 'SandboxStateError' });
    evidence.details.executionFenced = true;
    evidence.details.noReplay = true;
    await sandbox.stop();
    evidence.observations.push(...await observeAbsent(options.endpoint, owner.recoveryRecord, 'quota-import-stopped', ['compute']));
  });
}

try {
  await checkpoint();
  phase = 'generate';
  await mkdir(sourceDirectory, { mode: 0o700 });
  await remember(sourceDirectory);
  report.source = await generateDataset({ directory: sourceDirectory, seed: options.fixtureSeed, plan: datasetPlan(), signal: cancellation.signal });
  report.source.census = await censusDirectory(sourceDirectory, { controlFiles: ['control/source.jsonl', 'control/guest.mjs'], signal: cancellation.signal });
  assert.equal(report.source.census.files, report.source.importFiles);
  assert.equal(report.source.census.dataFiles, report.source.files);
  assert.equal(report.source.census.controlFiles, 2);
  assert.equal(report.source.census.directories, 4);
  assert.equal(report.source.census.payloadBytes, report.source.importPayloadBytes);
  assert(report.source.files > 20_000 && report.source.payloadBytes > 12n * 1024n ** 3n);
  assert.equal(report.source.largestFileBytes, 512 * 1024 ** 2);
  await copyFile(report.source.manifestPath, join(options.output, 'source-manifest.jsonl'));
  await checkpoint();
  await baseline();
  await quotaRejection();
} catch (error) { report.primaryFailure = failure(error); }
finally {
  phase = 'cleanup';
  try { await removeOwned(exportNamespace); report.exportDestinationRemoved = true; }
  catch (error) { report.cleanupFailures.push(failure(error)); }
  if (options.retainSource && report.primaryFailure === null && report.cleanupFailures.length === 0) {
    report.sourceRetained = true;
    const entry = await lstat(sourceDirectory, { bigint: true });
    report.retainedFixture = { directory: sourceDirectory, device: String(entry.dev), inode: String(entry.ino),
      purpose: 'Explicitly owned host source for subsequent MS004; no SDK resource is retained.' };
  } else {
    try { await removeOwned(sourceDirectory); report.sourceRemoved = true; }
    catch (error) { report.cleanupFailures.push(failure(error)); }
  }
  report.status = report.primaryFailure || report.cleanupFailures.length || report.evidenceFailures.length ? 'failed' : 'passed';
  report.finishedAt = new Date().toISOString();
  await checkpoint();
  process.removeListener('SIGTERM', interrupt);
  process.removeListener('SIGINT', interrupt);
  if (process.connected) process.disconnect();
}
process.stdout.write(`${JSON.stringify({ status: report.status, report: join(options.output, 'report.json') })}\n`);
if (report.status !== 'passed') process.exitCode = 1;
