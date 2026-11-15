import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { NativeExampleError } from '../data.js';
import { waitForNativeCleanup } from '../pending-cleanup.js';
import { NativeCleanupPendingError, type NativeRunReport } from '../run.js';

function pendingReport(): NativeRunReport {
  return { format: 'agenai.approval-native-result.v1', runId: 'owned-file-cleanup', stage: 'destroy',
    requestedPolicy: 'provider_auto_review', status: 'cleanup_pending', failureCode: 'run_failed',
    reservation: { currency: 'USD', amountCents: 1, consumedCents: 1, maximumCents: 1,
      meaning: 'authorization_reservation_only', providerCharge: 'unobserved' },
    output: { events: 0, bytes: 0, observedToolItems: 0, requests: [] }, cleanup: { attempts: 0, observedFailures: 0, settled: false } };
}
async function marker(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agenai-pending-cleanup-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'marker.txt'); await writeFile(path, 'pending-cleanup\n', { flag: 'wx' }); return path;
}
async function signal(name: NodeJS.Signals) {
  // The observer also prevents a missing production listener from terminating the test process.
  const delivered = new Promise<void>((resolve) => process.once(name, resolve));
  process.kill(process.pid, name); await delivered; await setImmediate();
}

test('pending CLI cleanup retains one file owner through failed and concurrent real signal retries', { timeout: 10_000 }, async (t) => {
  const path = await marker(t); const report = pendingReport();
  let release: (() => void) | undefined; const held = new Promise<void>((resolve) => { release = resolve; });
  let forceSettle = false; const noticePIDs: unknown[] = []; let publicationProtected = true;
  let failed: (() => void) | undefined; const firstFailure = new Promise<void>((resolve) => { failed = resolve; });
  const baseline = ['SIGUSR2', 'SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    if (typeof chunk !== 'string' || !chunk.includes('"cleanupRetryInstruction"')) return write(chunk);
    const notice: unknown = JSON.parse(chunk);
    noticePIDs.push(notice && typeof notice === 'object' && 'processPID' in notice ? notice.processPID : undefined);
    publicationProtected &&= ['SIGUSR2', 'SIGINT', 'SIGTERM'].every((name, index) => process.listenerCount(name) > (baseline[index] ?? 0));
    return true;
  });
  const owner: NativeCleanupPendingError = new NativeCleanupPendingError(report, async () => {
    report.cleanup.attempts += 1;
    assert.equal(await readFile(path, 'utf8'), 'pending-cleanup\n');
    if (report.cleanup.attempts === 1 && !forceSettle) {
      report.cleanup.observedFailures += 1; failed?.(); throw new NativeCleanupPendingError(report, () => owner.retryCleanup());
    }
    if (!forceSettle) await held;
    await unlink(path); report.cleanup.settled = true; report.status = 'failed'; report.stage = 'complete'; return report;
  });
  let settled = false;
  const waiting = waitForNativeCleanup(owner).then((result) => { settled = true; return result; });
  t.after(async () => {
    forceSettle = true; release?.();
    if (!settled) { process.emit('SIGUSR2'); await waiting; }
  });
  await setImmediate();
  assert.equal(settled, false, 'The CLI must retain unsettled ownership instead of returning.');
  assert.equal(report.cleanup.attempts, 0); assert.equal(await readFile(path, 'utf8'), 'pending-cleanup\n');
  assert.deepEqual(noticePIDs, [process.pid]); assert.equal(publicationProtected, true);
  await signal('SIGUSR2'); await firstFailure; await setImmediate();
  assert.equal(report.cleanup.attempts, 1); assert.equal(settled, false);
  assert.equal(await readFile(path, 'utf8'), 'pending-cleanup\n'); assert.deepEqual(noticePIDs, [process.pid, process.pid]);
  await signal('SIGUSR2');
  assert.equal(report.cleanup.attempts, 2);
  await signal('SIGUSR2'); await signal('SIGUSR2');
  assert.equal(report.cleanup.attempts, 2, 'Concurrent operator requests must share the entered original retry.');
  release?.();
  assert.equal((await waiting).status, 'failed');
  assert.equal(report.cleanup.attempts, 2); assert.equal(report.cleanup.settled, true);
  await assert.rejects(access(path), { code: 'ENOENT' });
  assert.deepEqual(['SIGUSR2', 'SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)), baseline);
});

test('pending CLI cleanup survives diagnostic errors and releases a settled owner despite artifact failure', { timeout: 10_000 }, async (t) => {
  const path = await marker(t); const report = pendingReport(); let settled = false;
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    if (typeof chunk === 'string' && chunk.includes('"cleanupRetryInstruction"')) throw new Error('Synthetic diagnostic write failure.');
    return write(chunk);
  });
  const owner = new NativeCleanupPendingError(report, async () => {
    report.cleanup.attempts += 1; await unlink(path);
    report.cleanup.settled = true; report.status = 'failed'; report.stage = 'complete';
    report.artifactFailure = 'report_persistence_failed'; throw new NativeExampleError('artifact_failed');
  });
  const waiting = waitForNativeCleanup(owner).then((result) => { settled = true; return result; });
  t.after(async () => { if (!settled) { process.emit('SIGUSR2'); await waiting; } });
  await setImmediate(); assert.equal(settled, false);
  assert.equal(report.cleanup.attempts, 0); assert.equal(await readFile(path, 'utf8'), 'pending-cleanup\n');
  await signal('SIGUSR2');
  const final = await waiting;
  assert.equal(final.status, 'failed'); assert.equal(final.cleanup.settled, true);
  assert.equal(final.cleanup.attempts, 1); assert.equal(final.artifactFailure, 'report_persistence_failed');
  await assert.rejects(access(path), { code: 'ENOENT' });
});
