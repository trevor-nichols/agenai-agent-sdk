import assert from 'node:assert/strict';
import { failure } from '../coordinator/evidence.mjs';
import { compareMemberInventory, memberConfiguration } from '../coordinator-recovery/common.mjs';

export function cleanupOriginal({ original, node, owner, recovery, guard, report, evidence, save }) {
  const owners = new Map(), returned = new Map(), unexpected = [];
  const retain = (value, label) => {
    const record = value.recoveryRecord;
    const selected = original.members.find((entry) => entry.record.operationId === record.operationId);
    if (!selected) { unexpected.push({ owner: value, label }); return; }
    try { compareMemberInventory(record, selected.record); }
    catch { unexpected.push({ owner: value, label }); return; }
    const previous = owners.get(record.operationId);
    assert(!previous || previous === value, 'Two cleanup capabilities unexpectedly claim the same original member.');
    owners.set(record.operationId, value);
  };
  return {
    retain,
    async finish() {
      guard.select({ kind: 'cleanup' });
      const failures = [];
      for (const selected of original.members) {
        const id = selected.record.operationId;
        if (returned.has(id)) continue;
        try {
          const record = recovery.members.find((value) => value.operationId === id);
          if (!record) { assert.equal(selected.record.phase, 'destroyed'); returned.set(id, selected.record); continue; }
          if (!owners.has(id)) {
            compareMemberInventory(record, selected.record);
            const result = await recovery.reconcile({ configuration: memberConfiguration(original, node, selected), record }, { signal: AbortSignal.timeout(60_000) });
            if (result.owner) retain(result.owner, 'positive-original-reconciliation');
            if (result.kind === 'absent') returned.set(id, result.record);
            else assert(result.kind === 'matched' || result.kind === 'uncertain', result.reason);
          }
          if (!returned.has(id)) {
            const current = owners.get(id); assert(current, 'Original cleanup capability was not retained.');
            for (const method of ['start', 'reserveProcess', 'importTree', 'exportTree', 'files']) assert.equal(typeof current[method], 'undefined');
            await current.destroy(); returned.set(id, current.recoveryRecord);
          }
          const settled = returned.get(id); assert.equal(settled.phase, 'destroyed'); compareMemberInventory(settled, selected.record);
          try {
            const file = await evidence.file(`${selected.member.label}-settled-record.json`, settled, 65_536);
            report.settledRecords.push({ label: selected.member.label, ...file }); await save();
          } catch (error) { report.evidenceFailures.push(failure(error)); }
        } catch (error) { failures.push(failure(error)); }
      }
      if (unexpected.length) failures.push({ message: 'Unexpected cleanup authority remains retained.',
        owners: unexpected.map(({ owner: current, label }) => ({ label, record: current.recoveryRecord })) });
      if (failures.length) throw new AggregateError(failures.map((value) => new Error(JSON.stringify(value))), 'Original negative-proof cleanup remains owned.');
      await owner.close({ timeoutMs: 60_000 });
      assert.deepEqual(owner.state, { kind: 'closed', result: 'clean', generation: original.generation });
      report.finalOwnerState = owner.state; report.originalCleanupComplete = true;
      try { await save(); } catch (error) { report.evidenceFailures.push(failure(error)); }
    },
  };
}

export async function retainUntilFinished(operation, report, save) {
  let signal = Promise.withResolvers(); const retry = () => signal.resolve();
  const keepAlive = setInterval(() => {}, 30_000); process.on('SIGUSR2', retry);
  try {
    for (;;) {
      try { await operation(); return; }
      catch (error) {
        report.cleanupFailures.push(failure(error)); report.cleanupComplete = false;
        try { await save(); } catch (cause) { report.evidenceFailures.push(failure(cause)); }
        process.stdout.write(`${JSON.stringify({ status: 'retained_cleanup', pid: process.pid, retrySignal: 'SIGUSR2',
          message: 'Original coordinator/fixture capabilities remain in this process; no replay or forced termination.' })}\n`);
        await signal.promise; signal = Promise.withResolvers();
      }
    }
  } finally { clearInterval(keepAlive); process.off('SIGUSR2', retry); }
}

export function retainSignals(report) {
  const interrupted = () => { report.interrupted = true; };
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  return {
    assertCurrent() { assert(!report.interrupted, 'Interrupted qualification cannot enter another effect phase.'); },
    close() { process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted); },
  };
}
