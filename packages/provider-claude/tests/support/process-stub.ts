// ------------------------------------------------------------------------------------------------
//                process-stub.ts - Worker-process boundary whose close fails while its group is alive
// ------------------------------------------------------------------------------------------------

import type { WorkerProcess } from '../../src/node/process.js';

export { WorkerCleanupFailure } from '../../src/node/process.js';

/** `alive` stands for a worker group that has not exited; close can only join it once it is false. */
export const workerControl = { alive: true, closes: 0, tools: [] as readonly string[] };

export async function startWorker(): Promise<Readonly<{ worker: WorkerProcess; tools: readonly string[] }>> {
  const worker: WorkerProcess = {
    listen() {},
    send() {},
    async close() {
      workerControl.closes += 1;
      if (workerControl.alive) throw new Error('The worker process group survived.');
    },
  };
  return { worker, tools: workerControl.tools };
}
