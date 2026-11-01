import { retainCleanupOwner } from '../concurrency/ownership.mjs';
import { writeSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { failure } from '../live/evidence.mjs';
import { originalOwnerCleanup } from '../live/owner-cleanup.mjs';
import { runNativeController } from '../../native-controller.mjs';

export function cleanupDiagnostic(value, descriptor = 1) {
  try {
    let line = JSON.stringify(value);
    if (Buffer.byteLength(line) > 16 * 1024) line = JSON.stringify({ status: 'retained_cleanup', pid: process.pid, diagnosticCapacityExceeded: true });
    writeSync(descriptor, `${line}\n`); return true;
  } catch { return false; }
}

// Reservations report lifecycle state; reconciled cleanup-only owners expose only their recovery record.
function assertOwnerDestroyed(owner) {
  assert.equal('state' in owner ? owner.state.kind : owner.recoveryRecord.phase, 'destroyed');
}

export const cleanupProof = (operation) => Object.assign(operation, { cleanupProof: true });
export const cleanupAction = (operation, complete) => Object.assign(operation, { cleanupRetry: true, cleanupComplete: complete });

export async function proxyRetired(proxy, error) {
  if (!(error instanceof AggregateError) || error.message !== 'Trace forwarding work failed.') return false;
  const capacity = proxy.capacity();
  if (capacity.connections.current || capacity.requests.current || capacity.pendingRequests.current || capacity.pendingRequests.retiring) return false;
  try { await lstat(proxy.endpoint.slice(7)); return false; }
  catch (cause) { if (cause.code === 'ENOENT') return true; throw cause; }
}

export class CleanupObligations {
  constructor({ timeoutMs, onFailure }) {
    this.timeoutMs = timeoutMs; this.onFailure = onFailure;
    this.steps = new Map(); this.reported = new WeakSet(); this.failed = false;
  }

  async failure(error, name) {
    this.failed = true;
    if (error && typeof error === 'object') {
      if (this.reported.has(error)) return;
      this.reported.add(error);
    }
    try { await this.onFailure(error, name); }
    catch (reporting) {
      cleanupDiagnostic({ status: 'cleanup_reporting_failed', pid: process.pid, step: name,
        message: String(reporting.message).slice(0, 2048) }, 2);
    }
  }

  async step(name, operation, { retryRejected = false, complete, proof = false } = {}) {
    let entry = this.steps.get(name);
    if (entry?.settled) return entry.value;
    if (entry?.state === 'rejected' && !retryRejected) throw entry.error;
    if (!entry || entry.state === 'rejected') {
      entry = { name, state: 'entered', settled: false, attempts: (entry?.attempts ?? 0) + 1 };
      this.steps.set(name, entry);
      entry.actual = Promise.resolve().then(operation).then((value) => {
        entry.value = value; entry.state = 'fulfilled'; entry.settled = true; return value;
      }, (error) => { entry.error = error; entry.state = 'rejected'; throw error; });
      void entry.actual.catch(() => {});
    }
    let timer;
    try {
      return await Promise.race([entry.actual, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Cleanup observation expired for ${name}; its original task remains owned.`)), this.timeoutMs);
      })]);
    } catch (error) {
      await this.failure(error, name);
      if (entry.state === 'rejected' && (proof || await complete?.(error))) { entry.settled = true; return entry.value; }
      throw error;
    } finally { clearTimeout(timer); }
  }

  snapshot() {
    return [...this.steps.values()].map(({ name, state, settled, attempts }) => ({ name, state, settled, attempts }));
  }

  async callbacks(phase, actions) {
    for (const [index, action] of actions.entries()) await this.step(`${phase}-${index}`, action,
      { retryRejected: action.cleanupRetry === true, complete: action.cleanupComplete, proof: action.cleanupProof === true });
  }

  async finish(operation, onRetained) {
    try { await operation(); }
    catch (error) {
      await this.failure(error, 'cleanup');
      await retainCleanupOwner({ operation: async () => {
        try { await operation(); }
        catch (cause) { await this.failure(cause, 'cleanup'); throw cause; }
      }, onRetained: async (attempt) => {
        try { await onRetained(attempt); }
        catch (reporting) {
          await this.failure(reporting, 'retained-report');
          cleanupDiagnostic({ status: 'retained_cleanup', pid: process.pid, retrySignal: 'SIGUSR2', attempt,
            reportingFailure: String(reporting.message).slice(0, 2048) });
        }
      } });
    }
  }
}

export async function finishRunCleanup(run, { timeoutMs, census, readerKind, beforeOwners, after }) {
  const cleanup = run.cleanup ??= new CleanupObligations({ timeoutMs, onFailure(error, step) {
    run.evidence.status = 'failed'; run.evidence.cleanupErrors.push({ step, ...failure(error) });
  } });
  await cleanup.finish(async () => {
    await cleanup.callbacks('before', [...(run.beforeCleanup ?? [])].reverse());
    if (beforeOwners) await beforeOwners(cleanup);
    for (const entry of [...run.owners].reverse()) if (entry.owner) {
      await cleanup.step(`destroy-${entry.namespace}`, () => originalOwnerCleanup(entry.owner, 'destroy'), { retryRejected: true });
      assertOwnerDestroyed(entry.owner);
      const final = await cleanup.step(`absence-${entry.namespace}`, () => census(entry), { retryRejected: true });
      await cleanup.step(`owner-report-${entry.namespace}`, async () => {
        entry.record = entry.owner.recoveryRecord;
        run.evidence.owners.find(({ namespace }) => namespace === entry.namespace).finalRecord = entry.record;
        run.evidence.census.push(...final); await run.save();
      }, { proof: true });
    }
    for (const [index, session] of run.sessions.entries()) {
      const result = await cleanup.step(`reader-${index}`, () => session.join());
      await cleanup.step(`reader-report-${index}`, async () => {
        run.evidence.observations.push({ kind: readerKind, result }); await run.save();
      }, { proof: true });
    }
    for (const [index, proxy] of [...run.proxies].reverse().entries()) {
      await cleanup.step(`proxy-${index}`, () => proxy.close(), { retryRejected: true, complete: (error) => proxyRetired(proxy, error) });
    }
    await cleanup.callbacks('after', run.afterCleanup);
    if (after) await after(cleanup);
  }, async (attempt) => {
    run.evidence.cleanupComplete = false; run.evidence.status = 'failed';
    run.evidence.retainedCleanup = { pid: process.pid, retrySignal: 'SIGUSR2', attempt, steps: cleanup.snapshot() };
    await run.save(); cleanupDiagnostic({ status: 'retained_cleanup', ...run.evidence.retainedCleanup });
  });
  run.evidence.cleanupComplete = true;
  if (cleanup.failed || run.evidence.cleanupErrors.length) run.evidence.status = 'failed';
  try { await run.save(); } catch (error) { await cleanup.failure(error, 'final-report'); }
}

export async function finishSuiteCleanup(report, { timeoutMs, save, operation }) {
  report.cleanupFailures ??= [];
  const cleanup = new CleanupObligations({ timeoutMs, onFailure(error, step) {
    report.cleanupFailures.push({ step, ...failure(error) });
  } });
  await cleanup.finish(() => operation(cleanup), async (attempt) => {
    report.retainedCleanup = { pid: process.pid, retrySignal: 'SIGUSR2', attempt, steps: cleanup.snapshot() };
    report.status = 'failed'; await save(); cleanupDiagnostic({ status: 'retained_cleanup', ...report.retainedCleanup });
  });
}

export function waitForInterruption(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export async function finishChildCleanup({ result, save, owners, sessions, localCleanupOwners = [], timeoutMs }) {
  const cleanup = new CleanupObligations({ timeoutMs, onFailure(error, step) {
    result.status = 'failed'; result.cleanupErrors.push({ step, ...failure(error) }); process.exitCode = 1;
  } });
  await cleanup.finish(async () => {
    for (const [index, owner] of localCleanupOwners.entries()) {
      await cleanup.step(`local-${index}`, () => owner.retryCleanup(), { retryRejected: true });
    }
    for (const [index, owner] of [...new Set(owners)].entries()) {
      await cleanup.step(`destroy-${index}`, () => originalOwnerCleanup(owner, 'destroy'), { retryRejected: true });
      assertOwnerDestroyed(owner);
      result.finalRecord = owner.recoveryRecord;
    }
    for (const [index, session] of sessions.entries()) {
      const joined = await cleanup.step(`reader-${index}`, () => session.join());
      await cleanup.step(`reader-report-${index}`, async () => { result.session = joined; await save(); }, { proof: true });
    }
  }, async (attempt) => {
    result.status = 'failed'; result.retainedCleanup = { pid: process.pid, retrySignal: 'SIGUSR2', attempt, steps: cleanup.snapshot() };
    await save(); cleanupDiagnostic({ status: 'retained_cleanup', ...result.retainedCleanup });
  });
  result.cleanupComplete = true;
  try { await save(); } catch (error) { await cleanup.failure(error, 'final-report'); }
}

export async function joinedCleanupChild(run, name, prepare) {
  const children = run.cleanupChildren ??= new Map();
  let original = children.get(name);
  if (!original) {
    original = { name, entered: null }; children.set(name, original);
    original.actual = (async () => {
      const options = await prepare();
      try {
        return await runNativeController({ ...options, onStarted: async (receipt) => {
          original.entered = receipt;
          (run.evidence.cleanupChildren ??= []).push({ name, ...receipt }); await run.save();
        } });
      } catch (error) {
        if (!original.entered) throw error;
        assert.equal(error.quiescent, true, 'The original cleanup child must join before returning its failure.');
        run.evidence.cleanupErrors.push({ child: name, ...failure(error) });
        return error;
      }
    })();
    void original.actual.catch(() => { if (!original.entered) children.delete(name); });
  }
  return original.actual;
}

export async function finishControllerCleanup(run, timeoutMs, operation) {
  const cleanup = new CleanupObligations({ timeoutMs, onFailure(error, step) {
    run.evidence.status = 'failed'; run.evidence.cleanupErrors.push({ step, ...failure(error) });
  } });
  await cleanup.finish(() => operation(cleanup), async (attempt) => {
    run.evidence.retainedController = { pid: process.pid, retrySignal: 'SIGUSR2', attempt, steps: cleanup.snapshot() };
    await run.save(); cleanupDiagnostic({ status: 'retained_cleanup', ...run.evidence.retainedController });
  });
}
