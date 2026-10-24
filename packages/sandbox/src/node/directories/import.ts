// ------------------------------------------------------------------------------------------------
//                import.ts - Explicit host directory import with local handle ownership
// ------------------------------------------------------------------------------------------------

import type { Sandbox } from '../../contracts.js';
import { SandboxUnsupportedError } from '../../errors.js';
import { invalidInput } from '../../internal/data.js';
import { parseTransferOptions, transferData } from '../../files/parse.js';
import type { SandboxTransferSummary } from '../../files/types.js';
import { SANDBOX_LIMITS } from '../../policy/limits.js';
import { canonicalHostPath, verifyHostDirectory } from '../hostPath.js';
import { DirectorySource } from './source.js';
import { capturedTransferOptions } from './options.js';
import { SandboxDirectoryCleanupError } from './types.js';
import type { SandboxDirectoryImportOptions } from './types.js';

/** The caller keeps the hierarchy stable; descriptor checks detect changes but do not create a snapshot. */
export async function importSandboxDirectory(sandbox: Sandbox, root: string,
  input?: SandboxDirectoryImportOptions): Promise<SandboxTransferSummary> {
  const path = canonicalHostPath(root);
  const data = input === undefined ? {} : transferData(input, ['signal', 'deadlineAt', 'quotas', 'chunkBytes']);
  const { chunkBytes = SANDBOX_LIMITS.maxTransferChunkBytes, ...transfer } = data;
  if (typeof chunkBytes !== 'number' || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > SANDBOX_LIMITS.maxTransferChunkBytes) {
    invalidInput('Host file chunkBytes must be between one byte and 64 KiB');
  }
  const options = parseTransferOptions(transfer);
  const selected = capturedTransferOptions(options);
  if (process.platform === 'win32') throw new SandboxUnsupportedError('Directory imports require the qualified POSIX filesystem profile.');
  options.signal?.throwIfAborted();
  const metadata = await verifyHostDirectory(path, options.signal);
  const source = new DirectorySource(path, metadata, chunkBytes, options.signal);
  let outcome: Readonly<{ kind: 'returned'; summary: SandboxTransferSummary }> | Readonly<{ kind: 'threw'; error: unknown }>;
  try { outcome = { kind: 'returned', summary: await sandbox.importTree(source, selected) }; }
  catch (error) { outcome = { kind: 'threw', error }; }
  try { await source.close(); }
  catch (cleanupError) { throw new SandboxDirectoryCleanupError(outcome.kind === 'threw' ? outcome.error : undefined, cleanupError, path, source); }
  if (outcome.kind === 'threw') throw outcome.error;
  return outcome.summary;
}
