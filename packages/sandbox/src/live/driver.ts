import type { SandboxByteSource, SandboxRelativePath } from '../files/types.js';
import type { SandboxFileListConsumer, SandboxFileListResult, SandboxFileReadConsumer, SandboxFileReadResult,
  SandboxFileStatResult, SandboxFileWriteResult, SandboxLivePath } from './types.js';

export interface SandboxDriverFileOptions {
  readonly signal: AbortSignal;
  readonly quotas: Readonly<{ maxBytes?: bigint; maxEntries?: bigint }>;
  readonly chunkBytes: number;
}
export interface SandboxDriverFileWriteOptions extends SandboxDriverFileOptions {
  readonly mode: 'create' | 'replace';
}
export interface SandboxDriverReadOnlyFiles {
  readonly kind: 'read_only';
  stat(path: SandboxLivePath, options: SandboxDriverFileOptions): Promise<SandboxFileStatResult>;
  list(path: SandboxLivePath, consume: SandboxFileListConsumer, options: SandboxDriverFileOptions): Promise<SandboxFileListResult>;
  readFile(path: SandboxRelativePath, consume: SandboxFileReadConsumer, options: SandboxDriverFileOptions): Promise<SandboxFileReadResult>;
}
export interface SandboxDriverReadWriteFiles extends Omit<SandboxDriverReadOnlyFiles, 'kind'> {
  readonly kind: 'read_write';
  writeFile(path: SandboxRelativePath, source: SandboxByteSource, options: SandboxDriverFileWriteOptions): Promise<SandboxFileWriteResult>;
}
export type SandboxDriverFiles = SandboxDriverReadOnlyFiles | SandboxDriverReadWriteFiles;
