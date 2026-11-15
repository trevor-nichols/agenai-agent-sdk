import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { waitForNativeCleanup } from '../pending-cleanup.js';
import { NativeCleanupPendingError, type NativeRunReport } from '../run.js';

// Credentialless process-liveness fixture: the external supervisor owns this directory.
const directory = process.argv[2]; assert(directory);
const marker = join(directory, 'marker.txt');
const report: NativeRunReport = { format: 'agenai.approval-native-result.v1', runId: 'owned-file-cleanup', stage: 'destroy',
  requestedPolicy: 'provider_auto_review', status: 'cleanup_pending', failureCode: 'run_failed',
  reservation: { currency: 'USD', amountCents: 1, consumedCents: 1, maximumCents: 1,
    meaning: 'authorization_reservation_only', providerCharge: 'unobserved' },
  output: { events: 0, bytes: 0, observedToolItems: 0, requests: [] }, cleanup: { attempts: 0, observedFailures: 0, settled: false } };
const owner = new NativeCleanupPendingError(report, async () => {
  report.cleanup.attempts += 1;
  assert.equal(await readFile(marker, 'utf8'), 'pending-cleanup\n');
  await unlink(marker); report.cleanup.settled = true; report.status = 'failed'; report.stage = 'complete'; return report;
});
await waitForNativeCleanup(owner);
process.exitCode = 1;
