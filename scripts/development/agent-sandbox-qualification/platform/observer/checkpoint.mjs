// ------------------------------------------------------------------------------------------------
//                checkpoint.mjs - Atomic whole-registry observer checkpoints and actual write joins
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { rename, writeFile } from 'node:fs/promises';

export function createObserverCheckpoint(path) {
  const pending = new Set();
  let tail = Promise.resolve();
  return {
    write(record) {
      assert(pending.size < 64, 'Observer checkpoint queue exceeds its finite qualification bound.');
      const bytes = `${JSON.stringify(record, null, 2)}\n`; assert(Buffer.byteLength(bytes) <= 1024 * 1024);
      const actual = tail.then(async () => { await writeFile(`${path}.next`, bytes, { mode: 0o600 }); await rename(`${path}.next`, path); });
      // Callers retain each failure; later writes can still persist its recorded cleanup evidence.
      tail = actual.catch(() => {});
      pending.add(actual); void actual.finally(() => pending.delete(actual)).catch(() => {}); return actual;
    },
    async join() {
      const failures = (await Promise.allSettled([...pending])).filter((entry) => entry.status === 'rejected').map((entry) => entry.reason);
      if (failures.length) throw new AggregateError(failures, 'Observer checkpoint writes failed.');
    },
  };
}
