// ------------------------------------------------------------------------------------------------
//                contracts.ts - Plain filesystem helper client contracts over caller-owned stdio
// ------------------------------------------------------------------------------------------------

import type {
  SandboxByteSource, SandboxFileListConsumer, SandboxFileListResult, SandboxFileReadConsumer, SandboxFileReadResult,
  SandboxFileStatResult, SandboxFileWriteResult, SandboxLivePath, SandboxRelativePath,
} from '@agen-ai/sandbox';

/** The helper's stdin. The client is its sole writer and ends or destroys it. */
export interface NodeFilesystemHelperInput {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  end(): unknown;
  destroy(): unknown;
}

/** The helper's stdout. The client is its sole reader; chunks must be byte arrays of at most 64 KiB. */
export interface NodeFilesystemHelperOutput extends AsyncIterable<unknown> {
  destroy(): unknown;
}

export interface NodeFilesystemHelperClientLimits {
  /** Deadline for the helper's readiness frame. Default 10,000 ms; maximum 60,000 ms. */
  readonly readyTimeoutMs?: number;
  /** Deadline for each correlated reply. Default 10,000 ms; maximum 60,000 ms. */
  readonly responseTimeoutMs?: number;
  /** Idle renewal interval; it must be shorter than the helper's launch lease. Default 5,000 ms. */
  readonly heartbeatMs?: number;
}

export interface NodeFilesystemHelperClientOptions {
  readonly input: NodeFilesystemHelperInput;
  readonly output: NodeFilesystemHelperOutput;
  /** The exact effective identity the helper must attest in its readiness frame. */
  readonly user: Readonly<{ uid: number; gid: number }>;
  readonly limits?: NodeFilesystemHelperClientLimits;
}

export interface NodeFilesystemHelperFileOptions {
  readonly signal: AbortSignal;
  readonly quotas: Readonly<{ maxBytes?: bigint; maxEntries?: bigint }>;
  /** Largest chunk delivered to a read consumer; an integer from 1 through 65,536 bytes. */
  readonly chunkBytes: number;
}

export interface NodeFilesystemHelperWriteOptions extends NodeFilesystemHelperFileOptions {
  readonly mode: 'create' | 'replace';
}

export type NodeFilesystemHelperCloseReceipt =
  | Readonly<{ kind: 'closed' }>
  | Readonly<{ kind: 'failed'; error: Error }>;

/**
 * One serial descriptor-safe helper session. Operations never overlap; an aborted or failed
 * operation permanently fails the transport. Write receipts are exact: a published, changed or
 * uncertain outcome is reported as observed and never retried or rolled back.
 */
export interface NodeFilesystemHelperClient {
  readonly ready: Promise<void>;
  stat(path: SandboxLivePath, options: NodeFilesystemHelperFileOptions): Promise<SandboxFileStatResult>;
  list(path: SandboxLivePath, consume: SandboxFileListConsumer, options: NodeFilesystemHelperFileOptions): Promise<SandboxFileListResult>;
  readFile(path: SandboxRelativePath, consume: SandboxFileReadConsumer, options: NodeFilesystemHelperFileOptions): Promise<SandboxFileReadResult>;
  writeFile(path: SandboxRelativePath, source: SandboxByteSource, options: NodeFilesystemHelperWriteOptions): Promise<SandboxFileWriteResult>;
  /** Idempotent after success; the helper process exits 0 only after a `closed` receipt. */
  close(): Promise<NodeFilesystemHelperCloseReceipt>;
}
