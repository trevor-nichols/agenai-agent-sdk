// ------------------------------------------------------------------------------------------------
//                export.ts - Provisional filesystem export and exclusive-namespace publication
// ------------------------------------------------------------------------------------------------

import { dirname } from 'node:path';
import type { Sandbox } from '../../contracts.js';
import { SandboxOperationError, SandboxUnsupportedError } from '../../errors.js';
import { parseTransferOptions } from '../../files/parse.js';
import type { SandboxTreeSelection, SandboxTransferOptions, SandboxTransferSummary } from '../../files/types.js';
import { canonicalHostPath, verifyHostDirectory } from '../hostPath.js';
import { DirectoryStage } from './stage.js';
import { capturedTransferOptions } from './options.js';
import { SandboxDirectoryCleanupError } from './types.js';
import type { SandboxDirectoryExportResult } from './types.js';

/** Destination is a new exclusive namespace; the published tree is its returned `files` child. */
export async function exportSandboxDirectory(sandbox: Sandbox, selection: SandboxTreeSelection,
  destination: string, options?: SandboxTransferOptions): Promise<SandboxDirectoryExportResult> {
  const path = canonicalHostPath(destination);
  const parsed = parseTransferOptions(options);
  const selected = capturedTransferOptions(parsed);
  parsed.signal?.throwIfAborted();
  if (parsed.deadlineAt !== undefined && parsed.deadlineAt <= Date.now()) throw new SandboxOperationError('deadline_exceeded', 'Directory export deadline elapsed before entry.');
  if (process.platform === 'win32') throw new SandboxUnsupportedError('Directory publication requires the qualified POSIX filesystem profile.');
  const parent = await verifyHostDirectory(dirname(path), parsed.signal);
  const stage = new DirectoryStage(path, parent, parsed.signal);
  let outcome: Readonly<{ kind: 'returned'; summary: SandboxTransferSummary }> | Readonly<{ kind: 'threw'; error: unknown }>;
  try {
    await stage.initialize();
    const summary = await sandbox.exportTree(selection, (entry, input) => stage.consume(entry, input), selected);
    await stage.publish();
    outcome = { kind: 'returned', summary };
  } catch (error) {
    stage.fence(error);
    outcome = { kind: 'threw', error };
  }
  try { await stage.close(); }
  catch (cleanupError) { throw new SandboxDirectoryCleanupError(outcome.kind === 'threw' ? outcome.error : undefined,
    cleanupError, path, stage, stage.publishedDirectory); }
  if (outcome.kind === 'threw') throw outcome.error;
  return Object.freeze({ directory: stage.directory, summary: outcome.summary });
}
