// ------------------------------------------------------------------------------------------------
//                types.ts - Incremental metadata ledger ownership and canonical records
// ------------------------------------------------------------------------------------------------

import type { SandboxDriverSpillStore } from '../../backend/spill.js';
import type { SandboxRelativePath, SandboxSymlinkTarget } from '../types.js';

export type MetadataRecord =
  | Readonly<{ path: SandboxRelativePath; kind: 'file' | 'directory' }>
  | Readonly<{ path: SandboxRelativePath; kind: 'symlink'; target: SandboxSymlinkTarget }>;

export interface MetadataLedgerOptions {
  readonly openSpill: () => Promise<SandboxDriverSpillStore>;
  readonly batchBytes: number;
  readonly fanIn: number;
  readonly signal?: AbortSignal;
}

export interface MetadataLedger {
  append(record: MetadataRecord): Promise<void>;
  finish(): Promise<void>;
  records(): AsyncIterable<MetadataRecord>;
  get(path: SandboxRelativePath): Promise<MetadataRecord | undefined>;
  validateSymlinks(options?: Readonly<{ root?: SandboxRelativePath }>): Promise<void>;
  close(): Promise<void>;
}
