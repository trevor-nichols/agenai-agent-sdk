import { pathToFileURL } from 'node:url';
import { acceptEditsCommand, safeFailure } from './cli.js';
import { waitForCleanup } from './pending-cleanup.js';
import { AcceptEditsCleanupPendingError } from './report.js';

export { acceptEditsCommand } from './cli.js';
export { runAcceptEdits, supportsCreate, type AcceptEditsControls } from './run.js';
export { exactListDecider, onceResolution, exactAction, type AcceptEditsAction, type AcceptEditsDecider } from './decisions.js';
export { parseAcceptEditsConfig, type AcceptEditsConfig, type AcceptEditsRunConfig } from './config.js';
export { AcceptEditsCleanupPendingError, type AcceptEditsReport } from './report.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Accept-edits example cancelled.'));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const result = await acceptEditsCommand(process.argv.slice(2), controller.signal);
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    if (error instanceof AcceptEditsCleanupPendingError) await waitForCleanup(error);
    else process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
