import { pathToFileURL } from 'node:url';
import { nativeCommand, safeCommandFailure } from './native/cli.js';
import { waitForNativeCleanup } from './native/pending-cleanup.js';
import { NativeCleanupPendingError } from './native/run.js';

export { NativeCleanupPendingError } from './native/run.js';
export { nativeCommand } from './native/cli.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Explicit native example cancellation.'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const result = await nativeCommand(process.argv.slice(2), controller.signal);
    process.stdout.write(`${JSON.stringify(result.output)}\n`); process.exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof NativeCleanupPendingError) await waitForNativeCleanup(error);
    else {
      process.stderr.write('Native example stopped; raw native diagnostics and credentials are omitted.\n');
      process.stdout.write(`${JSON.stringify(safeCommandFailure(error))}\n`);
    }
    process.exitCode = 1;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
