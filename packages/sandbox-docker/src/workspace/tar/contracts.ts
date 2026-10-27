// ------------------------------------------------------------------------------------------------
//                contracts.ts - Streaming Docker tar entries - Exact lengths and bounded wire options
// ------------------------------------------------------------------------------------------------

import type { SandboxByteSource, SandboxTransferSummary } from '@agen-ai/sandbox';

interface TarInputMetadata {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}
export type TarInputEntry = TarInputMetadata & (
  | Readonly<{ kind: 'file'; body?: SandboxByteSource }>
  | Readonly<{ kind: 'directory'; body?: never }>
  | Readonly<{ kind: 'symlink'; target: string; body?: never }>
);

export interface TarHeader {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'pax';
  readonly size: number;
  readonly mode: number;
  readonly target: string;
}

export type TarOutputEntry = Omit<TarHeader, 'kind' | 'target'> & (
  | Readonly<{ kind: 'file' | 'directory'; body: AsyncIterable<Uint8Array> }>
  | Readonly<{ kind: 'symlink'; target: string }>
);

export interface TarOptions {
  readonly signal: AbortSignal;
  readonly chunkBytes: number;
  readonly maxArchiveBytes?: bigint;
  readonly limitCode: 'input_limit' | 'output_limit';
  readonly symlinks?: 'reject' | 'preserve_internal';
}

export type TarSummary = SandboxTransferSummary;
