import { safeFailure } from './cli.js';
import type { AcceptEditsCleanupPendingError, AcceptEditsReport } from './report.js';

/** Keeps the process, and so the original cleanup owners, alive until an explicit retry settles. */
export async function waitForCleanup(owner: AcceptEditsCleanupPendingError): Promise<AcceptEditsReport> {
  return new Promise<AcceptEditsReport>((resolve) => {
    let retrying = false;
    let current = owner;
    const signals = ['SIGUSR2', 'SIGINT', 'SIGTERM'] as const;
    const publish = () => {
      const output = current.report.cleanup.settled ? current.report : {
        ...safeFailure(current), processPID: process.pid,
        cleanupRetryInstruction: `kill -USR2 ${process.pid}`, cleanupRetrySignals: signals,
        forcedTermination: 'SIGKILL_loses_original_in_process_owner',
      };
      if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(output)}\n`);
    };
    const finish = (report: AcceptEditsReport) => {
      clearInterval(keepalive);
      for (const name of signals) process.removeListener(name, retry);
      publish();
      resolve(report);
    };
    const retry = () => {
      if (retrying) return;
      retrying = true;
      void current.retryCleanup().then(finish, (error: unknown) => {
        if (error && typeof error === 'object' && 'retryCleanup' in error) current = error as AcceptEditsCleanupPendingError;
        retrying = false;
        publish();
      });
    };
    // Retains the process independently of stdin; the timer never retries work by itself.
    const keepalive = setInterval(() => {}, 60_000);
    for (const name of signals) process.on(name, retry);
    publish();
  });
}
