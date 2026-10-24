// ------------------------------------------------------------------------------------------------
//                contracts.ts - Streaming Docker tar entries - Exact lengths and bounded wire options
// ------------------------------------------------------------------------------------------------

import type { SandboxByteSource, SandboxTransferSummary } from '@agen-ai/sandbox';

export interface TarInputEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly size: number;
  readonly body?: SandboxByteSource;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

export interface TarHeader {
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'pax';
  readonly size: number;
  readonly mode: number;
}

export interface TarOutputEntry extends Omit<TarHeader, 'kind'> {
  readonly kind: 'file' | 'directory';
  readonly body: AsyncIterable<Uint8Array>;
}

export interface TarOptions {
  readonly signal: AbortSignal;
  readonly chunkBytes: number;
  readonly maxArchiveBytes?: bigint;
  readonly limitCode: 'input_limit' | 'output_limit';
}

export type TarSummary = SandboxTransferSummary;
