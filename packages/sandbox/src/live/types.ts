import type { SandboxByteSource, SandboxRelativePath } from '../files/types.js';

export type SandboxFileAccess = Readonly<{ kind: 'disabled' | 'read_only' | 'read_write' }>;
export type SandboxFileSupport = false | Readonly<{ read: true; write: boolean }>;
export type SandboxLivePath = SandboxRelativePath | '.';

interface SandboxFileMetadata {
  readonly path: SandboxLivePath;
  readonly byteLength: number;
  /** Observed permission bits, without set-ID or sticky bits. */
  readonly permissions: number;
}
export type SandboxFileEntry = SandboxFileMetadata & Readonly<{ kind: 'file' | 'directory' | 'symlink' | 'unsupported_hardlink' | 'unsupported_special' }>;

export type SandboxFileRejection = 'path_resolution' | 'unsupported_type' | 'hardlink' | 'already_exists' | 'quota_exceeded' | 'permission_denied';
export type SandboxFileCancellation = 'signal' | 'deadline' | 'callback_closed' | 'stopped';
export type SandboxFileObservation =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'changed' }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'rejected'; reason: SandboxFileRejection }>
  | Readonly<{ kind: 'cancelled'; reason: SandboxFileCancellation }>;

export type SandboxFileStatResult =
  | Readonly<{ kind: 'completed'; entry: SandboxFileEntry }>
  | Exclude<SandboxFileObservation, Readonly<{ kind: 'completed' }>>;
export type SandboxFileListResult = SandboxFileObservation & Readonly<{ entries: bigint }>;
export type SandboxFileReadResult = SandboxFileObservation & Readonly<{ bytes: bigint }>;
export type SandboxFileWriteResult =
  | Readonly<{ kind: 'completed' | 'changed'; effect: 'published'; bytes: bigint; permissions: number }>
  | Readonly<{ kind: 'missing'; effect: 'none'; bytes: bigint }>
  | Readonly<{ kind: 'rejected'; effect: 'none'; bytes: bigint; reason: SandboxFileRejection }>
  | Readonly<{ kind: 'cancelled'; effect: 'none'; bytes: bigint; reason: SandboxFileCancellation }>
  | Readonly<{ kind: 'cancelled'; effect: 'unknown'; bytes: bigint | null; reason: SandboxFileCancellation }>
  /** bytes is the confirmed helper-admitted count, or null when its acknowledgement is unavailable. */
  | Readonly<{ kind: 'uncertain'; effect: 'unknown' | 'published'; bytes: bigint | null }>;

export interface SandboxFileQuotas {
  readonly maxBytes?: number | bigint;
  readonly maxEntries?: number | bigint;
}
export interface SandboxFileOptions {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: string;
  readonly quotas?: SandboxFileQuotas;
}
export interface SandboxFileWriteOptions extends SandboxFileOptions {
  /** Create is exclusive; replace atomically replaces the name, without an inode compare-and-swap. */
  readonly mode: 'create' | 'replace';
}
export type SandboxFileListConsumer = (entry: SandboxFileEntry, input: Readonly<{ signal: AbortSignal }>) => Promise<void>;
export type SandboxFileReadConsumer = (file: Readonly<{ entry: SandboxFileEntry & Readonly<{ kind: 'file' }>; chunks: AsyncIterable<Uint8Array> }>, input: Readonly<{ signal: AbortSignal }>) => Promise<void>;

export interface SandboxReadOnlyFiles {
  readonly kind: 'read_only';
  stat(path: string, options?: SandboxFileOptions): Promise<SandboxFileStatResult>;
  list(path: string, consume: SandboxFileListConsumer, options?: SandboxFileOptions): Promise<SandboxFileListResult>;
  readFile(path: string, consume: SandboxFileReadConsumer, options?: SandboxFileOptions): Promise<SandboxFileReadResult>;
}
export interface SandboxReadWriteFiles extends Omit<SandboxReadOnlyFiles, 'kind'> {
  readonly kind: 'read_write';
  writeFile(path: string, source: SandboxByteSource, options: SandboxFileWriteOptions): Promise<SandboxFileWriteResult>;
}
export type SandboxFiles = Readonly<{ kind: 'disabled' }> | SandboxReadOnlyFiles | SandboxReadWriteFiles;
