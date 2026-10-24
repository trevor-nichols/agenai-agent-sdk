// ------------------------------------------------------------------------------------------------
//                types.ts - Incremental metadata ledger ownership and canonical records
// ------------------------------------------------------------------------------------------------

import type { SandboxDriverSpillStore } from '../../backend/spill.js';
import type { SandboxRelativePath } from '../types.js';

export interface MetadataRecord {
  readonly path: SandboxRelativePath;
  readonly kind: 'file' | 'directory';
}

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
  close(): Promise<void>;
}
