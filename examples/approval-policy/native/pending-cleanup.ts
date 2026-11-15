import { safeCommandFailure } from './cli.js';
import type { NativeCleanupPendingError, NativeRunReport } from './run.js';

/** Retains the executable's original cleanup owner until an explicit retry settles it. */
export async function waitForNativeCleanup(owner: NativeCleanupPendingError): Promise<NativeRunReport> {
  return new Promise<NativeRunReport>((resolve) => {
    let retrying = false;
    const signals = ['SIGUSR2', 'SIGINT', 'SIGTERM'] as const;
    const ignoreDiagnosticError = () => {};
    const publish = () => {
      try {
        const output = owner.report.cleanup.settled ? owner.report : {
          ...safeCommandFailure(owner), processPID: process.pid,
          cleanupRetryInstruction: `kill -USR2 ${process.pid}`,
          cleanupRetrySignals: signals,
          forcedTermination: 'SIGKILL_loses_original_in_process_owner',
        };
        if (!process.stdout.destroyed && !process.stdout.writableNeedDrain) process.stdout.write(`${JSON.stringify(output)}\n`);
      } catch { /* Diagnostic failure cannot discard an unsettled cleanup owner. */ }
    };
    const finish = (report: NativeRunReport) => {
      clearInterval(keepalive);
      for (const name of signals) process.removeListener(name, retry);
      publish();
      process.stdout.removeListener('error', ignoreDiagnosticError);
      process.stderr.removeListener('error', ignoreDiagnosticError);
      resolve(report);
    };
    const retry = () => {
      if (retrying) return;
      retrying = true;
      void Promise.resolve().then(() => owner.retryCleanup()).then(finish, () => {
        // Report persistence may fail after the original cleanup actually settled.
        if (owner.report.cleanup.settled) finish(owner.report);
        else { retrying = false; publish(); }
      });
    };
    // This timer retains the process independently of stdin; it never retries work.
    const keepalive = setInterval(() => {}, 60_000);
    process.stdout.on('error', ignoreDiagnosticError);
    process.stderr.on('error', ignoreDiagnosticError);
    for (const name of signals) process.on(name, retry);
    publish();
  });
}
