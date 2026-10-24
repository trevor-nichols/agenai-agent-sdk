// ------------------------------------------------------------------------------------------------
//                types.ts - Plain filesystem import/publication contracts and retained cleanup
// ------------------------------------------------------------------------------------------------

import type { SandboxTransferOptions, SandboxTransferSummary } from '../../files/types.js';

export interface SandboxDirectoryImportOptions extends SandboxTransferOptions {
  /** Match a smaller explicitly configured sandbox buffer. Defaults to 64 KiB. */
  readonly chunkBytes?: number;
}

export interface SandboxDirectoryExportResult {
  /** Published child of the exclusively created caller-selected destination namespace. */
  readonly directory: string;
  readonly summary: SandboxTransferSummary;
}

export interface DirectoryCleanupOwner { close(): Promise<void> }

export class SandboxDirectoryCleanupError extends Error {
  constructor(readonly primaryError: unknown, readonly cleanupError: unknown,
    readonly directory: string, private readonly owner: DirectoryCleanupOwner, readonly publishedDirectory?: string) {
    super('Directory transfer failed or its local filesystem cleanup remains owned.', { cause: primaryError });
    this.name = 'SandboxDirectoryCleanupError';
  }
  retryCleanup(): Promise<void> { return this.owner.close(); }
}
